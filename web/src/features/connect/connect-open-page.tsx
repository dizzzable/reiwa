/**
 * `/connect/open` — where an "add to app" link lands after leaving a Telegram
 * Mini App, and the only place on its way that may put the app's scheme behind
 * a button.
 *
 * The Mini App cannot: Telegram for Android loads the scheme in the Mini App's
 * own webview and replaces the Mini App with an error page, Telegram for iOS
 * drops it (`deep-link-handoff.ts`). So the connect screen hands this page's
 * address to `openLink`, the Mini App's documented way out, and this page opens
 * in a real browser — Safari, a Chrome Custom Tab, Telegram's own in-app browser
 * on Android, a desktop tab — where a same-window tap on an app scheme is handed
 * to the system rather than loaded. The owner watched exactly that tap work in
 * Safari; the sources for the others are in `deep-link-handoff.ts`.
 *
 * ── A tap, never an attempt on load ─────────────────────────────────────────
 *
 * The page does not try to open the app by itself. Chrome refuses to leave for
 * an app from a navigation that no gesture started, and on iOS a page that
 * redirects on load reads as the page misbehaving. The button IS the gesture,
 * so it is the primary path, and "copy the link" sits under it for the device
 * that has no app registered for the scheme.
 *
 * ── Two checks before the button, in order ──────────────────────────────────
 *
 * Anybody can hand anybody an address of this page, so the button waits for
 * both. The operator's catalog must build exactly this link from this
 * subscription URL, and then the cabinet must confirm it signed that
 * subscription URL for a signed-in subscriber — the catalog vouches for the
 * app, the signature for whose subscription is inside it
 * (`connect-trampoline.ts`). Until both have said yes nothing on the page is
 * clickable; a no is a refusal, and a check that could not be asked is a retry.
 *
 * ── Nobody's session, and nobody's key in a log ─────────────────────────────
 *
 * Safari has none of Telegram's cookies, so the route is public — declared
 * outside `StealthLayout` in `App.tsx`, and listed in the transport's public
 * paths so a stray 401 elsewhere cannot bounce it to the sign-in form. The link
 * arrives in the fragment (`connect-trampoline.ts`) and never leaves the
 * document. The page makes two requests: the public catalog, with nothing of
 * the link in it, and the signature check, which carries the SHA-256 of the
 * subscription URL and the signature and nothing else. The client-error
 * reporter sends `pathname + search`, never the hash.
 *
 * ── Outside the shell, so it brings its own scroller ────────────────────────
 *
 * `#root` clips (`out-of-shell-scroller.test.tsx`), so the outermost box is the
 * bounded scroller and the centring lives in the column inside it — the shape
 * `/payment-return` explains at length.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Copy, Link2 } from 'lucide-react'
import { toast } from 'sonner'

import { getConnectPage, verifyConnectHandoff } from '@/lib/api-client'
import { copyText } from './clipboard'
import { readCatalog } from './connect-catalog'
import { readTrampolinePayload, subscriptionDigest, verifyTrampolinePayload } from './connect-trampoline'

type Verdict = 'ready' | 'checking' | 'failed' | 'invalid' | 'unverified'

const BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 py-3 text-sm font-semibold'

export default function ConnectOpenPage() {
  const { t } = useTranslation()

  // Read once, from this document's own fragment — never from the query, and
  // never again after a client-side navigation could have dropped it.
  const [payload] = useState(() => readTrampolinePayload(window.location.hash))

  // The connect screen's own query key, so a cabinet that already holds the
  // catalog does not ask twice. Not asked at all when there is nothing to check.
  const catalogQuery = useQuery({
    queryKey: ['connect-page'],
    queryFn: getConnectPage,
    staleTime: 60_000,
    enabled: payload !== null,
  })

  /** The catalog's word on the link: `null` until the catalog has answered. */
  const catalogVouches = useMemo(() => {
    if (payload === null || catalogQuery.data === undefined) return null
    return verifyTrampolinePayload(readCatalog(catalogQuery.data), payload)
  }, [payload, catalogQuery.data])

  // The cabinet's word on whose subscription it is. Asked only once the catalog
  // has vouched, so a link no template builds is refused without a request, and
  // asked with the digest — the subscription URL and the link stay here. One
  // signature's answer does not change while the page is open.
  const signatureQuery = useQuery({
    queryKey: ['connect-handoff', payload?.signature ?? null],
    queryFn: async () => {
      if (payload === null) throw new Error('no payload to verify')
      const digest = await subscriptionDigest(payload.subscriptionUrl)
      return verifyConnectHandoff({ digest, signature: payload.signature })
    },
    enabled: catalogVouches === true,
    staleTime: Infinity,
  })

  const verdict: Verdict = useMemo(() => {
    if (payload === null) return 'invalid'
    if (catalogVouches === null) return catalogQuery.isError ? 'failed' : 'checking'
    if (!catalogVouches) return 'unverified'
    // Only a literal yes opens anything. A no is a refusal; an answer that is
    // neither is a check that did not happen, and so is an error.
    const answer = signatureQuery.data?.valid
    if (answer === true) return 'ready'
    if (answer === false) return 'unverified'
    if (signatureQuery.data !== undefined || signatureQuery.isError) return 'failed'
    return 'checking'
  }, [payload, catalogVouches, catalogQuery.isError, signatureQuery.data, signatureQuery.isError])

  // Its own failure line, not the connect screen's: that one says to select the
  // link by hand, and this page never shows the link — only its host. What is
  // left to a subscriber whose browser will not copy is the connect screen they
  // came from, where the same button runs in Telegram's own web view.
  const copy = async (): Promise<void> => {
    if (payload === null) return
    if (await copyText(payload.subscriptionUrl)) toast.success(t('connect.copied'))
    else toast.error(t('connect.openCopyFailed'))
  }

  // Asks again whichever check could not be asked: the catalog while it has no
  // answer, the signature after it has one.
  const retry = (): void => {
    void (catalogVouches === null ? catalogQuery.refetch() : signatureQuery.refetch())
  }

  return (
    <div
      data-testid="connect-open"
      data-verdict={verdict}
      className="scroll-area relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-6 text-[color:var(--brand-foreground)]"
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 py-10">
        <h1 className="text-xl font-semibold">{t('connect.openTitle')}</h1>

        {verdict === 'ready' && payload !== null && (
          <>
            <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t('connect.openBody')}
            </p>
            {/* The catalog vouched for the app and the cabinet for the
                subscription: its signature says this cabinet issued that URL
                to a signed-in subscriber. It cannot say the subscriber is the
                person holding this phone — anybody can pass on a subscription
                the operator issued — so the host is still shown, which is
                what lets somebody handed another person's address notice it. */}
            <p
              data-connect-open-host=""
              className="break-all text-xs text-[color:var(--brand-muted-foreground)]"
            >
              {t('connect.openSource', { host: new URL(payload.subscriptionUrl).host })}
            </p>
            {/* The same-window anchor the owner saw work in Safari. Only ever
                rendered once the catalog AND the cabinet have said yes — a fast
                tap before both checks finish has nothing to land on. */}
            <a
              data-connect-open-app=""
              href={payload.link}
              className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
            >
              <Link2 aria-hidden="true" className="size-4" />
              {t('connect.openButton')}
            </a>
            <button
              type="button"
              data-connect-open-copy=""
              onClick={() => void copy()}
              className={`${BUTTON} border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)]`}
            >
              <Copy aria-hidden="true" className="size-4" />
              {t('connect.copyLink')}
            </button>
            <p className="text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t('connect.openNotOpened')}
            </p>
          </>
        )}

        {verdict === 'checking' && (
          <p className="text-sm text-[color:var(--brand-muted-foreground)]">{t('connect.openChecking')}</p>
        )}

        {verdict === 'failed' && (
          <>
            <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t('connect.openFailed')}
            </p>
            <button
              type="button"
              data-connect-open-retry=""
              onClick={retry}
              className={`${BUTTON} border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)]`}
            >
              {t('common.retry')}
            </button>
          </>
        )}

        {verdict === 'invalid' && (
          <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {t('connect.openInvalid')}
          </p>
        )}

        {verdict === 'unverified' && (
          <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {t('connect.openUnverified')}
          </p>
        )}
      </div>
    </div>
  )
}

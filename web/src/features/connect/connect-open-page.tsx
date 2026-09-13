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
 * ── Nobody's session, and nobody's key in a log ─────────────────────────────
 *
 * Safari has none of Telegram's cookies, so the route is public — declared
 * outside `StealthLayout` in `App.tsx`, and listed in the transport's public
 * paths so a stray 401 elsewhere cannot bounce it to the sign-in form. The link
 * arrives in the fragment (`connect-trampoline.ts`) and never leaves the
 * document: the one request this page makes is the public catalog, with nothing
 * of the link in it, and the client-error reporter sends `pathname + search`,
 * never the hash.
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

import { getConnectPage } from '@/lib/api-client'
import { copyText } from './clipboard'
import { readCatalog } from './connect-catalog'
import { readTrampolinePayload, verifyTrampolinePayload } from './connect-trampoline'

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

  const verdict: Verdict = useMemo(() => {
    if (payload === null) return 'invalid'
    if (catalogQuery.data !== undefined) {
      return verifyTrampolinePayload(readCatalog(catalogQuery.data), payload) ? 'ready' : 'unverified'
    }
    return catalogQuery.isError ? 'failed' : 'checking'
  }, [payload, catalogQuery.data, catalogQuery.isError])

  const copy = async (): Promise<void> => {
    if (payload === null) return
    if (await copyText(payload.subscriptionUrl)) toast.success(t('connect.copied'))
    else toast.error(t('connect.copyFailed'))
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
            {/* The catalog vouches for the SHAPE of the link — the operator's
                own app, the operator's own import endpoint — and cannot vouch
                for whose subscription is inside it: a public page cannot know
                the operator's subscription host. So the host is shown, which is
                what lets somebody handed a stranger's address notice it. */}
            <p
              data-connect-open-host=""
              className="break-all text-xs text-[color:var(--brand-muted-foreground)]"
            >
              {t('connect.openSource', { host: new URL(payload.subscriptionUrl).host })}
            </p>
            {/* The same-window anchor the owner saw work in Safari. Only ever
                rendered for a link the catalog vouched for — a fast tap before
                the check finishes has nothing to land on. */}
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
              onClick={() => void catalogQuery.refetch()}
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

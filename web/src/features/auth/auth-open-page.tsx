import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'

import {
  androidDefaultBrowserIntent,
  isAndroidWebView,
  readBrowserKey,
  signInAddress,
} from './browser-handoff'
import { followLink, replacePage } from './leave-page'

/**
 * `/auth/open` — where the Mini App's «Открыть в браузере» lands, with a
 * one-time sign-in key in the fragment (`browser-handoff.ts`).
 *
 * Public, like `/connect/open`: it opens in a browser that has none of
 * Telegram's cookies. It decides one thing — whether this is already the
 * browser the customer should end up in:
 *
 *   - In an Android WebView — Telegram's in-app browser, where `openLink`
 *     usually lands on Android — it does NOT spend the key. It hands it to the
 *     phone's default browser through `intent://`, straight away and again
 *     from a button, because Telegram passes such a link to the system from
 *     script exactly as from a tap (one handler, `shouldOverrideUrlLoading`).
 *   - Anywhere else — Safari, a desktop browser, Chrome or a Custom Tab — this
 *     IS that browser: the key goes to the home page, the one place that has
 *     always spent the bot's sign-in keys, and the customer lands signed in.
 *
 * The fragment is wiped at once, so the key is not left in this tab's history.
 */

const BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-[var(--radius-item)] px-4 py-3 text-sm font-semibold'

type Plan =
  | { readonly kind: 'expired' }
  | { readonly kind: 'hop'; readonly intent: string; readonly here: string }
  | { readonly kind: 'here'; readonly target: string }

function planFor(hash: string, origin: string, userAgent: string): Plan {
  const key = readBrowserKey(hash)
  if (key === null) return { kind: 'expired' }
  const target = signInAddress(origin, key)
  const intent = isAndroidWebView(userAgent) ? androidDefaultBrowserIntent(target) : null
  return intent === null ? { kind: 'here', target } : { kind: 'hop', intent, here: target }
}

export default function AuthOpenPage() {
  const { t } = useTranslation()
  // Read once, before the fragment is wiped below.
  const [plan] = useState<Plan>(() => planFor(window.location.hash, window.location.origin, navigator.userAgent))

  // Once per page: a second navigation would be a second intent, or a second
  // spend of a key that is single-use (StrictMode mounts effects twice in dev).
  const left = useRef(false)

  useEffect(() => {
    if (left.current) return
    left.current = true
    if (window.location.hash !== '') {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
    if (plan.kind === 'here') replacePage(plan.target)
    else if (plan.kind === 'hop') followLink(plan.intent)
  }, [plan])

  return (
    <div
      data-testid="auth-open"
      data-plan={plan.kind}
      className="scroll-area relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-6 text-[color:var(--brand-foreground)]"
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 py-10">
        {plan.kind === 'expired' ? (
          <>
            <h1 className="text-xl font-semibold">{t('authOpen.expiredTitle')}</h1>
            <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t('authOpen.expiredBody')}
            </p>
            <a href="/sign-in" className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}>
              {t('authOpen.signIn')}
            </a>
          </>
        ) : plan.kind === 'hop' ? (
          <>
            <h1 className="text-xl font-semibold">{t('authOpen.hopTitle')}</h1>
            <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
              {t('authOpen.hopBody')}
            </p>
            <a
              data-auth-open-hop=""
              href={plan.intent}
              className={`${BUTTON} bg-[color:var(--brand-primary)] text-[color:var(--brand-primary-fg)]`}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {t('authOpen.hopButton')}
            </a>
            <a
              data-auth-open-here=""
              href={plan.here}
              className={`${BUTTON} text-[color:var(--brand-muted-foreground)]`}
            >
              {t('authOpen.stayHere')}
            </a>
          </>
        ) : (
          <p className="text-sm text-[color:var(--brand-muted-foreground)]">{t('authOpen.signingIn')}</p>
        )}
      </div>
    </div>
  )
}

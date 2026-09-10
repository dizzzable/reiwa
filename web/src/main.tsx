import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { queryClient } from '@/lib/query-client'
import { registerServiceWorker } from '@/lib/register-sw'
import { installGlobalErrorReporting } from '@/lib/client-error-reporter'
import { installIosZoomLock } from '@/lib/ios-zoom-lock'
import { captureInstallPromptEvents } from '@/lib/install-prompt-capture'
import { AppErrorBoundary } from '@/components/error-boundary'
import { BrandingProvider } from '@/lib/branding-provider'
import { resolveTelegramLaunchParams } from '@/lib/telegram-launch-params'
import App from './App'
import '@/index.css'
import '@/i18n/i18n'

// Capture Telegram's launch parameters — here, at module scope, before React
// exists.
//
// The bot opens the cabinet straight on a cabinet route: its notification and
// keyboard buttons are `web_app` buttons built as `${miniAppUrl}${path}` (see
// `src/bot/listeners/internal-http-listener.ts`, "Mini App deep-link button"),
// and the path is operator-configured, so any route is a possible launch
// document. `initData` IS `tgWebAppData` and it arrives in that document's
// `location.hash` — but the first react-router navigation drops the fragment,
// and on a cookieless deep-link launch that navigation happens immediately.
// Whatever has not read the payload by then never will: `/bootstrap` finds
// nothing, falls back to waiting for telegram.org — precisely the host a
// VPN-less customer cannot reach — and the subscriber who tapped «Продлить»
// lands on a password form.
//
// This used to live in `useTelegramWebApp`'s effect at the application root,
// which is NOT early enough and only appeared to work by accident. `<Navigate>`
// is itself a `useEffect` (react-router 8's `components.js`), and React runs
// CHILD effects before parent ones — so a gate that renders `<Navigate>` on its
// first render wins the race and the fragment is gone before the root's effect
// runs. Today's session gate happens to be asynchronous (`useSession` has no
// `initialData`, no `placeholderData` and no persister, so `isLoading` is true
// on the first render and StealthLayout paints a spinner), which is the only
// reason the effect placement survived. `/ref/:token` already loses it: that
// route returns `<Navigate>` on its first render. Give `useSession` an
// `initialData` one day and every deep-link launch breaks again, silently.
//
// Module scope in the entry chunk is the one place with no ordering left to
// lose: it runs before the first render, before any effect, before any lazy
// boundary, on every route. The call is idempotent and writes nothing for a
// document with no launch parameters.
resolveTelegramLaunchParams()

// Register service worker for PWA support
registerServiceWorker()

// Catch `beforeinstallprompt` — here, at module scope, for the same reason as
// the launch parameters above: the event does not wait for React.
//
// Chromium fires it ONCE, shortly after load, and never again for a client-side
// navigation. `useInstallPrompt` used to register the listener in its own
// effect, and its only consumer is the Settings page — which nobody lands on,
// they navigate there, several route changes into a session that never reloads.
// The listener therefore came into existence minutes after the event had
// already been dispatched to nobody, so `canInstall` was false for every user on
// every visit and the "Install app" row rendered essentially never.
//
// The event has no replay and no re-fire to wait for, so the listener has to
// already exist when it lands. Module scope in the entry chunk is the one place
// that is guaranteed of, on every route.
captureInstallPromptEvents()

// Forward browser/Mini App runtime errors (window.onerror + unhandled
// rejections) to the BFF so they join the bot/api/worker firehose.
installGlobalErrorReporting()

// iOS Safari/WKWebView ignores `user-scalable=no`, so suppress pinch- and
// double-tap-zoom in JS — keeps the Mini App from zooming/panning out of
// bounds on iPhone (Android already honours the viewport meta).
installIosZoomLock()

const root = document.getElementById('root')!

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <BrandingProvider>
          <TooltipProvider delayDuration={300}>
            <AppErrorBoundary>
              <App />
            </AppErrorBoundary>
            <Toaster
              position="top-center"
              offset={16}
              // NOT cosmetic, and not a claim about the customer's OS.
              //
              // Sonner styles the toast's CHILDREN — description, action
              // button, "later" chip, close button — through its own palette,
              // and its default is `light`. The card underneath has always been
              // near-black. So the hint BODY rendered #3f3f3f on rgba(9,9,11)
              // — about 1.9:1 — and the whole message the operator wrote was
              // invisible; the "later" chip was worse. Nothing in the cabinet
              // had ever passed `description` or `closeButton` before this
              // hint toast, so the palette had never been asked for anything
              // but a title.
              //
              // This says "the surface these children sit on is dark", which is
              // a fact about `.cabinet-toast`, not a preference.
              theme="dark"
              // Glass surface matching the cabinet's dialogs/sheets so toasts
              // read as one design system — in `index.css` under
              // `.cabinet-toast`, NOT inline here, and that is not tidying.
              // An inline declaration beats every stylesheet rule, so while the
              // surface was written here the four hint tones an operator picks
              // in the panel could not be drawn at all: warning, success and
              // danger all arrived as the same near-black card.
              toastOptions={{ className: 'cabinet-toast' }}
            />
          </TooltipProvider>
        </BrandingProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)

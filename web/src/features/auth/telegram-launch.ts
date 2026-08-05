/**
 * How the entry routes (`/`, `/bootstrap`) wait for Telegram's Mini App SDK
 * before they decide "Mini App or browser?".
 *
 * The SDK is not bundled: `public/telegram-webapp-loader.js` fetches it from
 * telegram.org, so `window.Telegram` appears some unknown time after first
 * paint. Both routes must answer before they can route, and the two possible
 * mistakes are not symmetric:
 *
 *   - Answering "browser" for a real Mini App drops a Telegram-first user on a
 *     username/password form they have no credentials for. Nothing recovers
 *     from it — the launch parameters are spent and the user is simply stuck.
 *   - Answering "Mini App" for a browser, or waiting for a signal that is not
 *     coming, hangs the splash.
 *
 * So the wait is bounded only where a bound is safe. `useTelegramWebApp` has
 * drawn that line correctly since the loader gained explicit signals; this
 * module is that same rule, extracted, because the root page had its own
 * unconditional ~1.5s cap and a slow or VPN-proxied SDK fetch beat it routinely.
 * Two policies for one decision is what produced the bug, so there is now one.
 */
import { hasTelegramLaunchParameters } from '@/hooks/use-telegram-webapp'

/** Only reached when no loader signal is coming; see `pollForTelegramSdk`. */
const POLL_INTERVAL_MS = 150

/**
 * The SDK's answer, once its bridge exists: the launch's `initData`, or `null`
 * when the bridge is present but carries no launch payload — that is an
 * ordinary browser that merely reached telegram.org, and it must keep routing
 * as one. `undefined` means the bridge is still absent, i.e. not an answer yet.
 */
function readTelegramInitData(): string | null | undefined {
  const webApp = window.Telegram?.WebApp
  if (!webApp) return undefined
  const data = webApp.initData
  return typeof data === 'string' && data.length > 0 ? data : null
}

/**
 * Did this document start as a Telegram Mini App — i.e. is a loader signal
 * actually on its way?
 *
 * The launch parameters are the loader's own trigger, so they answer it
 * directly. But they live in the entry URL, and react-router drops the hash
 * (where Telegram puts them) on every client-side navigation — which is exactly
 * how `/bootstrap` is reached, from `StealthLayout`, logout, claim and
 * finish-setup. The loader's state marker survives those hops: it is stamped
 * once at document load and only ever for a launch that had the parameters, so
 * a plain browser still reads `undefined` and keeps its bounded wait.
 */
function launchedByTelegram(): boolean {
  return hasTelegramLaunchParameters() || window.__reiwaTelegramSdkState !== undefined
}

/**
 * A Telegram launch waits for the loader's verdict with no time cap. `ready`
 * and `error` are the only two events that are answers; a clock running out is
 * not one, and spending it as "browser" is the bug this module exists to
 * prevent. `error` settles just as firmly as `ready` — the SDK could not be
 * fetched, so no bridge is coming and the web flow is the honest outcome.
 */
function waitForTelegramSdk(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const finish = (initData: string | null) => {
      window.removeEventListener('reiwa:telegram-sdk-ready', onReady)
      window.removeEventListener('reiwa:telegram-sdk-error', onError)
      resolve(initData)
    }
    const onReady = () => finish(readTelegramInitData() ?? null)
    const onError = () => finish(null)

    window.addEventListener('reiwa:telegram-sdk-ready', onReady)
    window.addEventListener('reiwa:telegram-sdk-error', onError)

    // The loader is a `defer` script in `index.html`, so it can finish before
    // the app bundle even runs. Its event then fired long before this listener
    // existed and nothing further is ever dispatched — the recorded state is
    // the whole signal, and missing it would hang the splash forever.
    if (window.__reiwaTelegramSdkState === 'ready') onReady()
    else if (window.__reiwaTelegramSdkState === 'error') onError()
  })
}

/**
 * A launch with no Telegram parameters gets a bounded wait, because no signal
 * is coming: the loader skips the request entirely, so nothing would ever
 * release us, and a Russian-IP browser that cannot reach telegram.org must
 * never be left staring at the splash. The poll covers only the ordering race
 * where a bridge shows up anyway (a cached SDK, an extension).
 */
async function pollForTelegramSdk(maxMs: number): Promise<string | null> {
  const start = Date.now()
  for (;;) {
    const initData = readTelegramInitData()
    if (initData !== undefined) return initData
    if (Date.now() - start >= maxMs) return null
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/**
 * Resolves the launch's Telegram `initData`, or `null` for "route as a browser".
 *
 * `maxMs` bounds the browser case only. A Telegram launch is never bounded —
 * see the module comment.
 */
export async function detectTelegramInitData(maxMs: number): Promise<string | null> {
  const immediate = readTelegramInitData()
  if (immediate !== undefined) return immediate
  return launchedByTelegram() ? await waitForTelegramSdk() : await pollForTelegramSdk(maxMs)
}

/**
 * How the entry routes (`/`, `/bootstrap`) decide "Mini App or browser?".
 *
 * The two possible mistakes are not symmetric:
 *
 *   - Answering "browser" for a real Mini App drops a Telegram-first user on a
 *     username/password form they have no credentials for. Nothing recovers
 *     from it — the launch parameters are spent and the user is simply stuck.
 *   - Answering "Mini App" for a browser, or waiting for a signal that is not
 *     coming, hangs the splash.
 *
 * The first mistake is now unreachable for a launch that carries its payload,
 * because the decision no longer depends on the network at all. `initData` IS
 * `tgWebAppData` and Telegram puts it in `location.hash` from the first byte,
 * so `readTelegramLaunchInitData()` answers immediately — no script, no fetch,
 * no clock. The cabinet used to answer this by waiting for
 * `telegram.org/js/telegram-web-app.js` and reading `window.Telegram.WebApp
 * .initData` back out of it: ~100 KB fetched cross-origin to re-read a value
 * already in the address bar. This product sells VPN, so the user tapping the
 * bot's button has no VPN yet and telegram.org is precisely the host they
 * cannot reach — and every failure of that fetch was spent as "browser".
 *
 * The SDK is still loaded (see `useTelegramWebApp`) and still wanted, for
 * haptics, BackButton/MainButton, theme and `openInvoice`. It is simply no
 * longer what authentication waits on.
 *
 * What remains below is the fallback for launch shapes the URL does not carry:
 * an embedder that hands the payload straight to the bridge, or a document that
 * lost the hash before this module ran and has no session mirror either. For
 * those the old rule still holds — a Telegram launch waits for the loader's
 * verdict with no time cap, a plain browser gets a bounded wait — because a
 * clock spent as "browser" is the failure this module exists to prevent.
 */
import {
  hasTelegramLaunchParameters,
  readTelegramLaunchInitData,
} from '@/lib/telegram-launch-params'

/** Only reached when no loader signal is coming; see `pollForTelegramSdk`. */
const POLL_INTERVAL_MS = 150

/**
 * The SDK's answer, once its bridge exists: the launch's `initData`, or `null`
 * when the bridge is present but carries no launch payload — that is an
 * ordinary browser that merely reached telegram.org, and it must keep routing
 * as one. `undefined` means the bridge is still absent, i.e. not an answer yet.
 *
 * A fallback, not the primary source: every caller below reads the URL first,
 * so by the time this speaks the launch has already been shown to carry no
 * payload of its own.
 */
function readTelegramInitData(): string | null | undefined {
  const webApp = window.Telegram?.WebApp
  if (!webApp) return undefined
  const data = webApp.initData
  return typeof data === 'string' && data.length > 0 ? data : null
}

/**
 * Is a loader signal actually on its way?
 *
 * The launch parameters are the loader's own trigger, so they answer it
 * directly. The loader's state marker covers what is left when react-router has
 * dropped the hash: it is stamped once at document load and only ever for a
 * launch that had the parameters, so a plain browser still reads `undefined`
 * and keeps its bounded wait.
 */
function launchedByTelegram(): boolean {
  return hasTelegramLaunchParameters() || window.__reiwaTelegramSdkState !== undefined
}

/**
 * A Telegram launch whose payload is not in the URL waits for the loader's
 * verdict with no time cap. `ready` and `error` are the only two events that
 * are answers; a clock running out is not one. `error` settles just as firmly
 * as `ready` — the SDK could not be fetched, so no bridge is coming, and with
 * no payload in the URL either there is nothing left to authenticate with.
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
 * `maxMs` bounds the browser case only, and only when the answer had to come
 * from the SDK at all. See the module comment.
 */
export async function detectTelegramInitData(maxMs: number): Promise<string | null> {
  // The launch payload itself, straight off the URL (or the session mirror of
  // it). This is the whole decision for every real Mini App launch, and it
  // resolves before a single byte has been requested from telegram.org.
  const launchInitData = readTelegramLaunchInitData()
  if (launchInitData !== null) return launchInitData

  const immediate = readTelegramInitData()
  if (immediate !== undefined) return immediate
  return launchedByTelegram() ? await waitForTelegramSdk() : await pollForTelegramSdk(maxMs)
}

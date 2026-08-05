/**
 * Telegram's launch parameters — the launch payload itself, read from the URL
 * Telegram opened, not from a script fetched afterwards to describe it.
 *
 * `initData` IS `tgWebAppData`. Telegram writes it into `location.hash` of the
 * launch document from the very first byte, and the SDK does nothing more
 * exotic with it than `webAppInitData = initParams.tgWebAppData`. So the
 * cabinet never needed a network round-trip to answer "Mini App or browser?":
 * it was holding the answer before the first request went out.
 *
 * It used to fetch ~100 KB from telegram.org anyway, purely to read that value
 * back out of `window.Telegram.WebApp`. This product sells VPN. The user who
 * taps the bot's button does not have one yet, which makes telegram.org exactly
 * the host their network blocks — and every failed fetch was spent as "plain
 * browser", dropping a Telegram-first user on a username/password form they
 * have no credentials for. Nothing recovers from that screen.
 *
 * Decoding has to be exact, because the server HMACs the bytes. Telegram
 * percent-encodes `tgWebAppData` once when it builds the fragment, so the value
 * must be decoded exactly once. `URLSearchParams` does that, and its rules are
 * the SDK's `urlSafeDecode` rules — `+` becomes a space, then
 * `decodeURIComponent` — so the string produced here is byte-identical to the
 * one `WebApp.initData` would hold. A second decode turns a literal `%25` into
 * `%`; a skipped one leaves `%7B` where a `{` belongs. Either way the signature
 * no longer verifies and the user is stuck on the same dead-end form.
 */

/**
 * The names Telegram appends to a Mini App URL. `tgWebAppData` is the launch's
 * `initData`; the others describe the client. `public/telegram-webapp-loader.js`
 * recognises the same four, so "the URL says Telegram" and "the loader will
 * request the SDK" stay one rule — restate the list there and they drift.
 */
export const TELEGRAM_LAUNCH_PARAMETER_NAMES = [
  'tgWebAppData',
  'tgWebAppVersion',
  'tgWebAppPlatform',
  'tgWebAppThemeParams',
] as const

/** Decoded launch parameters, the same map the SDK calls `initParams`. */
export type TelegramLaunchParams = Readonly<Record<string, string>>

/**
 * The SDK's own `sessionStorage` key, shared on purpose rather than shadowed.
 *
 * The shipped SDK stores its launch parameters as
 * `sessionStorage['__telegram__initParams'] = JSON.stringify(initParams)` and
 * restores them on a later document with a key-wise merge that only fills in
 * names the fresh URL did not carry:
 *
 *     var initParams = urlParseHashParams(locationHash)
 *     var storedParams = sessionStorageGet('initParams')
 *     if (storedParams) {
 *       for (var key in storedParams) {
 *         if (typeof initParams[key] === 'undefined') initParams[key] = storedParams[key]
 *       }
 *     }
 *     sessionStorageSet('initParams', initParams)
 *
 * Writing the same key in the same shape — a flat object of decoded strings —
 * makes the two agree: whichever runs first, the other reads what it expects.
 * A different shape here would be actively harmful, because that `for…in` walks
 * whatever `JSON.parse` returned; hand it a bare string and the SDK's own
 * launch parameters acquire numeric-index garbage. Hence `persistLaunchParams`
 * merges over the stored object instead of replacing it, so names this module
 * never parses (`tgWebAppStartParam`, `tgWebAppBotInline`, `_path`) survive a
 * write untouched.
 */
const SDK_LAUNCH_PARAMS_KEY = '__telegram__initParams'

/**
 * The hash and the query as two parameter sets. Telegram has used both — the
 * fragment on current clients, the query on older ones and on some desktop
 * launch URLs — so neither may be the only one read.
 */
function urlParameterSources(): readonly URLSearchParams[] {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  // Hash first: that is where a current client puts the signed payload, so a
  // stale copy left in the query can never win over it.
  return [new URLSearchParams(hash), new URLSearchParams(window.location.search)]
}

/**
 * Did Telegram open THIS document — i.e. is a loader signal actually on its way?
 *
 * Presence, not a non-empty value, and the URL only: this is the loader's own
 * trigger restated, and it must keep answering the loader's question. A
 * document that merely inherits the session store has no request in flight and
 * must not be left waiting for a signal nobody will send.
 */
export function hasTelegramLaunchParameters(): boolean {
  const sources = urlParameterSources()
  return TELEGRAM_LAUNCH_PARAMETER_NAMES.some((name) =>
    sources.some((source) => source.has(name)),
  )
}

/** The launch parameters carried by this document's own URL. */
function readLaunchParamsFromUrl(): TelegramLaunchParams | null {
  const found: Record<string, string> = {}
  for (const source of urlParameterSources()) {
    for (const name of TELEGRAM_LAUNCH_PARAMETER_NAMES) {
      const value = source.get(name)
      if (value !== null && value.length > 0 && found[name] === undefined) {
        found[name] = value
      }
    }
  }
  return Object.keys(found).length > 0 ? found : null
}

/** The session store exactly as it sits on disk, so a merge cannot drop keys. */
function readPersistedRecord(): Record<string, unknown> | null {
  try {
    const raw = window.sessionStorage.getItem(SDK_LAUNCH_PARAMS_KEY)
    if (raw === null || raw.length === 0) return null
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    // Storage disabled (private mode), or another writer left something that is
    // not JSON. Either way this document simply has no mirror to fall back on.
    return null
  }
}

function readPersistedLaunchParams(): TelegramLaunchParams | null {
  const record = readPersistedRecord()
  if (record === null) return null
  const params: Record<string, string> = {}
  for (const name of TELEGRAM_LAUNCH_PARAMETER_NAMES) {
    const value = record[name]
    // The SDK stores `null` for a valueless parameter; only a real string is a
    // launch parameter.
    if (typeof value === 'string' && value.length > 0) params[name] = value
  }
  return Object.keys(params).length > 0 ? params : null
}

function persistLaunchParams(params: TelegramLaunchParams): void {
  try {
    // The URL wins over the store, which is the SDK's own precedence
    // (`if (typeof initParams[key] === 'undefined')`), and everything already
    // stored under names this module does not parse is carried through.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ ...(readPersistedRecord() ?? {}), ...params }),
    )
  } catch {
    // Private mode, quota, or a hostile embedder. The URL is still the primary
    // source, so a failed mirror costs a LATER document its bridge — never this
    // document its authentication.
  }
}

/**
 * This document's launch parameters: from the URL when it still has them, from
 * the SDK's session store when it does not.
 *
 * Resolving also mirrors the URL copy into that store. `/bootstrap` is reached
 * by react-router `<Navigate>` from StealthLayout, logout, claim and
 * finish-setup, and a client-side navigation drops the hash — as does a full
 * reload after `history.replaceState`, and the return leg from a payment
 * gateway. The SDK survives those hops this exact way; mirroring here means the
 * cabinet does too, even on the networks where the SDK never arrived to do it.
 */
export function resolveTelegramLaunchParams(): TelegramLaunchParams | null {
  const fromUrl = readLaunchParamsFromUrl()
  if (fromUrl === null) return readPersistedLaunchParams()
  persistLaunchParams(fromUrl)
  return fromUrl
}

/**
 * The launch's `initData`, or `null` when Telegram did not open this session.
 *
 * This is `window.Telegram.WebApp.initData`, byte for byte — the SDK's own
 * definition of it is `webAppInitData = initParams.tgWebAppData` — available
 * with no script, no network and no clock, which is the entire point.
 */
export function readTelegramLaunchInitData(): string | null {
  const initData = resolveTelegramLaunchParams()?.tgWebAppData
  return typeof initData === 'string' && initData.length > 0 ? initData : null
}

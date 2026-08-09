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
 * `initData`; the others describe the client or the entry point.
 * `public/telegram-webapp-loader.js` recognises the same five, so "the URL says
 * Telegram" and "the loader will request the SDK" stay one rule — restate the
 * list there and they drift.
 *
 * `tgWebAppStartParam` is the Mini App's `start_param`, i.e. the `startapp=`
 * payload of the `t.me` link that opened the app — the ad campaign code, among
 * other things. It is a launch parameter like the rest and travels the same
 * way, so it is captured the same way. Reading it out of the bridge instead
 * (`initDataUnsafe.start_param`) made Mini App ad attribution depend on
 * telegram.org, which is the host this product's customers cannot reach; the
 * `?startapp=` / `?campaign=` query fallback next to it never fires, because
 * Telegram does not put the start parameter in the query.
 */
export const TELEGRAM_LAUNCH_PARAMETER_NAMES = [
  'tgWebAppData',
  'tgWebAppVersion',
  'tgWebAppPlatform',
  'tgWebAppThemeParams',
  'tgWebAppStartParam',
] as const

/** Decoded launch parameters, the same map the SDK calls `initParams`. */
export type TelegramLaunchParams = Readonly<Record<string, string>>

/**
 * The server's freshness window for a launch payload, restated.
 *
 * `src/lib/telegram-auth.ts` refuses a payload with `now - auth_date > 86400`,
 * and `/auth/telegram/bootstrap` answers that refusal with a 401. Serving such a
 * payload cannot succeed, so the only thing it can produce is the error screen
 * — whose Retry is `window.location.reload()`, which reads the same mirror
 * back. Keep this equal to the server's window; a larger value here re-opens
 * that loop and a smaller one throws away launches the server would accept.
 */
const LAUNCH_PAYLOAD_MAX_AGE_SECONDS = 86_400

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
 * launch parameters acquire numeric-index garbage. Hence `writeLaunchParamsMirror`
 * merges over the stored object instead of replacing it, so names this module
 * never parses (`tgWebAppBotInline`, `_path`) survive a write untouched.
 *
 * That key-wise merge is the contract for BOTH carriers, not just this one.
 * `resolveTelegramLaunchParams` used to quote it here and then assign
 * `capturedLaunchParams = fromUrl` — replacing everything in memory while
 * merging only into the store. The two then disagreed about exactly the case
 * the merge exists for: a URL carrying `tgWebAppVersion` but no payload (a
 * client that appends the descriptive names to a hop it makes itself) replaced
 * the good in-memory capture with a payload-less record AND, being non-`null`,
 * stopped the mirror from being consulted at all. The code now implements the
 * merge the comment always described.
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

/**
 * Is this a value at all, as opposed to a present-but-empty parameter?
 *
 * `trim()` decides the QUESTION; it never touches the ANSWER. `#tgWebAppData=`
 * and `#tgWebAppData=%20` both arrive as a string `URLSearchParams` reports
 * happily, and the second one used to pass a bare `length > 0` — so a fragment
 * holding one space was accepted as a signed launch, made `detectTma()` answer
 * true, and was sent to `/auth/telegram/bootstrap` to come back 401. The stored
 * value stays byte-identical because the server HMACs those exact bytes: a
 * trimmed `tgWebAppData` would fail the signature check just as surely.
 */
function isUsableLaunchValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** The launch parameters carried by this document's own URL. */
function readLaunchParamsFromUrl(): TelegramLaunchParams | null {
  const found: Record<string, string> = {}
  for (const source of urlParameterSources()) {
    for (const name of TELEGRAM_LAUNCH_PARAMETER_NAMES) {
      const value = source.get(name)
      if (isUsableLaunchValue(value) && found[name] === undefined) {
        found[name] = value
      }
    }
  }
  return Object.keys(found).length > 0 ? found : null
}

/**
 * How old the payload SAYS it is, in seconds, or `null` when it does not say.
 *
 * **Not a security check, and it must never become one.** `auth_date` is read
 * straight out of `tgWebAppData` with no HMAC verification — client-side it is
 * unsigned, and anybody who can edit the address bar can write any value there.
 * The server is the only thing that decides whether a payload is genuine
 * (`validateTelegramInitData`, keyed by the bot token). This is a freshness
 * HEURISTIC with exactly one job: stop replaying a payload the server has
 * already committed to refusing, because the bootstrap error screen's Retry is
 * `window.location.reload()` and the mirror would hand the same dead payload
 * back on every pass — forever.
 *
 * A payload that omits `auth_date`, or writes one that is not a positive
 * integer, gets no verdict at all: judging it here would be inventing a
 * rejection the server never made.
 */
function launchPayloadAgeSeconds(initData: string): number | null {
  try {
    const authDate = Number(new URLSearchParams(initData).get('auth_date') ?? '')
    if (!Number.isSafeInteger(authDate) || authDate <= 0) return null
    return Math.floor(Date.now() / 1000) - authDate
  } catch {
    return null
  }
}

/** True when the server's own window has already closed on this payload. */
function isSpentLaunchPayload(params: TelegramLaunchParams): boolean {
  if (!isUsableLaunchValue(params.tgWebAppData)) return false
  const age = launchPayloadAgeSeconds(params.tgWebAppData)
  // A negative age is a clock disagreement, not an expiry — the server's own
  // check is one-sided (`now - auth_date > 86400`) and so is this one.
  return age !== null && age > LAUNCH_PAYLOAD_MAX_AGE_SECONDS
}

/** The same record with the payload removed; the client description stays. */
function withoutLaunchPayload(params: TelegramLaunchParams): TelegramLaunchParams {
  const { tgWebAppData: _spent, ...rest } = params
  return rest
}

/**
 * Takes the payload out of THIS document's own URL, hash and query alike.
 *
 * The other carriers can simply be dropped; the URL cannot, because Retry on
 * the bootstrap error screen is `window.location.reload()` and a reload keeps
 * the fragment. Clearing memory and the mirror without this leaves the loop
 * exactly where it was — the reloaded document reads the same spent payload
 * straight back out of its own address bar.
 *
 * Only `tgWebAppData` goes. `tgWebAppVersion` and friends stay, so the loader
 * still recognises the document as a Mini App and still fetches the bridge.
 */
function scrubLaunchPayloadFromUrl(): void {
  try {
    const rawHash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash
    const hash = new URLSearchParams(rawHash)
    const query = new URLSearchParams(window.location.search)
    if (!hash.has('tgWebAppData') && !query.has('tgWebAppData')) return
    hash.delete('tgWebAppData')
    query.delete('tgWebAppData')
    const search = query.toString()
    const fragment = hash.toString()
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search.length > 0 ? `?${search}` : ''}${
        fragment.length > 0 ? `#${fragment}` : ''
      }`,
    )
  } catch {
    // A hostile embedder can make `history.replaceState` throw. Memory and the
    // mirror are already cleared by then, so the worst case is that this one
    // document keeps a spent payload in its own address bar.
  }
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
    if (isUsableLaunchValue(value)) params[name] = value
  }
  return Object.keys(params).length > 0 ? params : null
}

/**
 * Merges `params` into the SDK's session record, optionally deleting names.
 *
 * The URL wins over the store, which is the SDK's own precedence
 * (`if (typeof initParams[key] === 'undefined')`), and everything already stored
 * under names this module does not parse is carried through. `remove` exists
 * for the one thing a merge cannot express: forgetting a payload, which a merge
 * would otherwise leave sitting under the key it is supposed to clear.
 */
function writeLaunchParamsMirror(
  params: TelegramLaunchParams,
  remove: readonly string[] = [],
): void {
  try {
    const record: Record<string, unknown> = { ...(readPersistedRecord() ?? {}), ...params }
    for (const name of remove) delete record[name]
    window.sessionStorage.setItem(SDK_LAUNCH_PARAMS_KEY, JSON.stringify(record))
  } catch {
    // Private mode, quota, or a hostile embedder. The URL is still the primary
    // source, so a failed mirror costs a LATER document its bridge — never this
    // document its authentication.
  }
}

/**
 * This document's launch parameters, captured in memory the first time they are
 * seen.
 *
 * The session mirror alone is not enough, because writing it can silently fail.
 * Telegram Web (weba/webk) runs the Mini App in an `iframe`, and in a
 * partitioned or storage-blocked third-party context `window.sessionStorage`
 * THROWS on access rather than returning null — which `writeLaunchParamsMirror`
 * catches and swallows, exactly as it should. But then the payload has nowhere
 * to live, and the next react-router `<Navigate>` (StealthLayout's redirect to
 * `/bootstrap`, one tick later) takes the URL copy with it.
 *
 * This module-level copy costs nothing and covers every same-document hop,
 * which is all of them: the SPA never reloads on an internal navigation. The
 * mirror stays for what memory cannot survive — a genuinely NEW document, i.e.
 * a reload or the return leg from a payment gateway.
 *
 * `web/src/main.tsx` calls `resolveTelegramLaunchParams()` at module scope,
 * before `createRoot(root).render(…)`, so this is filled in before React has
 * rendered anything at all. That placement is load-bearing and is explained
 * there; the short version is that no React effect can be early enough,
 * because `<Navigate>` is itself an effect and child effects run first.
 */
let capturedLaunchParams: TelegramLaunchParams | null = null

/**
 * This document's launch parameters: the URL merged over what this session was
 * already carrying — the in-memory capture when a client-side navigation has
 * dropped the URL copy, the SDK's session store when this is a new document
 * altogether.
 *
 * The merge is key-wise, with the fresh URL winning per NAME. That is the SDK's
 * own restore rule (quoted above `SDK_LAUNCH_PARAMS_KEY`) and it is now what
 * both carriers do; the previous `capturedLaunchParams = fromUrl` replaced
 * memory wholesale, so a URL carrying only descriptive names threw away a good
 * payload and — being non-`null` — also stopped the mirror from being read.
 *
 * `/bootstrap` is reached by react-router `<Navigate>` from StealthLayout,
 * logout, claim and finish-setup, and a client-side navigation drops the
 * fragment AND the query — as does a full reload after `history.replaceState`,
 * and the return leg from a payment gateway. The SDK survives those hops via
 * the store; the cabinet survives them via the store OR memory, so it keeps
 * working on the networks where the SDK never arrived and in the embeddings
 * where the store is unreachable.
 *
 * A payload this session has been CARRYING past the server's own window is
 * dropped here rather than served — see `isSpentLaunchPayload`, and note the
 * comment there about why that is a loop guard and not a security check.
 */
export function resolveTelegramLaunchParams(): TelegramLaunchParams | null {
  const fromUrl = readLaunchParamsFromUrl()
  let carried = capturedLaunchParams ?? readPersistedLaunchParams()

  // Freshness is judged on the CARRIED copy only, never on a payload the
  // current document's own URL is still holding.
  //
  // The carried one is the replay: the mirror outlives its launch with nothing
  // to expire it, so a document opened a day later — a restored tab, the return
  // leg from a slow payment, a webview the OS kept — sends a payload the server
  // has already committed to refusing, and the error screen's Retry reloads
  // into the same refusal.
  //
  // The URL copy is a different thing and must not be judged by the same clock.
  // It belongs to a document Telegram just opened, so it is fresh by
  // construction, and the only clock available to disprove that is the DEVICE's
  // — which the server's check does not consult. A phone whose clock is a few
  // days fast would have its perfectly good launch discarded here, before the
  // server ever saw it, and the user would be told to open the app in Telegram
  // while doing exactly that. A copied or bookmarked launch URL genuinely is
  // stale, and that case is settled by the server's own verdict:
  // `forgetTelegramLaunchPayload()` on a 401 takes it out of the URL too.
  if (carried !== null && isSpentLaunchPayload(carried)) {
    carried = withoutLaunchPayload(carried)
    if (capturedLaunchParams !== null) capturedLaunchParams = carried
    forgetPersistedLaunchPayload()
  }

  if (fromUrl === null) return carried

  // This document's own launch, merged over what the session already carried.
  const merged = { ...(carried ?? {}), ...fromUrl }
  capturedLaunchParams = merged
  writeLaunchParamsMirror(merged)
  return merged
}

/** Drops the payload from the session mirror, leaving the rest of the record. */
function forgetPersistedLaunchPayload(): void {
  // Nothing stored means nothing to forget — and writing here would create the
  // SDK's key on a document that never had one.
  if (readPersistedRecord() === null) return
  writeLaunchParamsMirror({}, ['tgWebAppData'])
}

/**
 * Forget the launch payload this session is carrying — in memory, in the
 * mirror, and in this document's own URL.
 *
 * Called when the SERVER has refused it: `/auth/telegram/bootstrap` answers a
 * payload it cannot validate with 401. The bootstrap error screen's only
 * affordance is Retry, and Retry is `window.location.reload()` — a new document
 * that re-reads the mirror AND keeps the fragment, so it sends the identical
 * bytes to the identical refusal. Leaving a refused payload in place therefore
 * does not cost one failed sign-in, it costs every subsequent one, with no way
 * out of the screen.
 *
 * Only `tgWebAppData` goes. The rest of the record describes the client, is not
 * what was refused, and is what keeps `public/telegram-webapp-loader.js`
 * fetching the bridge for a document that is still a Mini App.
 */
export function forgetTelegramLaunchPayload(): void {
  if (capturedLaunchParams !== null) {
    capturedLaunchParams = withoutLaunchPayload(capturedLaunchParams)
  }
  forgetPersistedLaunchPayload()
  scrubLaunchPayloadFromUrl()
}

/**
 * Test-only: forget the in-memory capture so each spec starts from a cold
 * document. Production code must never call this.
 */
export function __resetTelegramLaunchCaptureForTests(): void {
  capturedLaunchParams = null
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
  return isUsableLaunchValue(initData) ? initData : null
}

/**
 * The launch's `start_param` — the `startapp=` payload of the `t.me` link that
 * opened the Mini App — or `null` when this session did not come through one.
 *
 * This is `window.Telegram.WebApp.initDataUnsafe.start_param`, from the same
 * place the SDK reads it (`initParams.tgWebAppStartParam`) and with the same
 * availability as everything else here: no script, no network, no clock.
 */
export function readTelegramLaunchStartParam(): string | null {
  const startParam = resolveTelegramLaunchParams()?.tgWebAppStartParam
  return isUsableLaunchValue(startParam) ? startParam : null
}

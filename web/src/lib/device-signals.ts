/**
 * Two device signals the cabinet computes about the browser it runs in.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * A ban is evaded with a new mailbox and a new login, both free and instant.
 * The bot has a Telegram id to refuse and the VPN client reports a hardware id,
 * but the cabinet can be used without either — so for somebody banned from the
 * cabinet, the machine in front of them is the only thing that carries over.
 *
 * The signals are sent to the panel, which marks the account for an operator if
 * the same machine also belongs to a blocked one. NOTHING here refuses anybody:
 * a device match proves the same MACHINE, not the same person, and a household
 * sharing a laptop is indistinguishable from an evader.
 *
 * ── What a browser genuinely cannot do, because a lot is sold on this ─────
 *
 * There is no API for a MAC address, a disk serial or a motherboard id, and
 * there will not be one — a MAC does not even leave the local link. Real
 * hardware bans need a kernel driver on the customer machine. Everything below
 * is DERIVED, and the two values differ in exactly how:
 *
 *   installId   a random value we store. Exact while it lasts, and gone the
 *               moment somebody clears site data or opens a private window.
 *
 *   deviceHash  a digest of what the GRAPHICS AND AUDIO STACKS do. A function
 *               of the GPU, its driver and the OS rather than of the browser,
 *               which is why it survives a cleared profile and usually a
 *               different browser on the same machine. It is NOT unique to a
 *               person: two identical corporate laptops produce one value.
 *
 * ── Everything here fails soft, on purpose ───────────────────────────────
 *
 * A browser that blocks canvas readback, a locked-down storage partition, a
 * webview with no WebGL — each of those is a visitor we simply learn less
 * about. Not one of them is a reason for the cabinet to misbehave, so every
 * component is individually guarded and the whole thing returns `null` rather
 * than throwing.
 */

const INSTALL_ID_KEY = 'rz.device'
const INSTALL_ID_COOKIE = 'rz_device'
/** Two years. Long enough to outlast a subscription, short enough to expire. */
const COOKIE_MAX_AGE_SECONDS = 2 * 365 * 24 * 60 * 60

export interface DeviceSignals {
  readonly installId: string | null
  readonly deviceHash: string | null
}

/**
 * Reads — or creates — the persistent install id.
 *
 * ── Written to two places that restore each other ────────────────────────
 *
 * `localStorage` and a first-party cookie hold the same value, and whichever
 * survives repopulates the other. This is not belt-and-braces for its own sake:
 * the two are cleared by different actions and expire under different rules.
 * "Clear cookies" in most browsers leaves `localStorage`; Safari's tracking
 * prevention caps SCRIPT-WRITTEN storage at seven days of inactivity while a
 * server-set cookie lives longer; and a Telegram in-app webview can drop either
 * between sessions. Keeping one copy in each doubles how long the cheap signal
 * lasts for the cost of six lines.
 *
 * ── And it is still the weak half ────────────────────────────────────────
 *
 * One deliberate "clear site data" removes both, and a private window never had
 * them. That is expected — this catches the people who did not think to, which
 * is most of them, and `deviceHash` is what catches the rest.
 */
export function readOrCreateInstallId(): string | null {
  const stored = readStorage() ?? readCookie()
  if (stored !== null) {
    // Repopulate whichever half is missing.
    writeStorage(stored)
    writeCookie(stored)
    return stored
  }
  const created = randomId()
  if (created === null) return null
  writeStorage(created)
  writeCookie(created)
  // Only report it if at least one of the two actually took. A value that
  // cannot be persisted is a brand-new "device" on every page load, which
  // would fill the observation table with rows that match nothing, ever.
  return readStorage() ?? readCookie()
}

/**
 * Computes the hardware-derived digest.
 *
 * ── What goes in, and what is deliberately left out ──────────────────────
 *
 * IN: the WebGL renderer and vendor strings (the GPU model and its driver —
 * the highest-entropy stable signal a browser exposes), a canvas rendering
 * digest (rasterisation differs by GPU, driver, OS and font stack), an audio
 * digest (the audio pipeline differs the same way), core count, platform and
 * colour depth.
 *
 * OUT, and this matters more than what is in:
 *
 *   SCREEN SIZE. It changes when a laptop is plugged into a monitor, and
 *   `devicePixelRatio` changes when somebody zooms. Both would make the digest
 *   move without the machine changing — and a digest that moves matches
 *   nothing, which is worse than having no digest at all.
 *
 *   TIME ZONE AND LANGUAGE. They travel with a person rather than identifying
 *   a machine, and they are the components that make two strangers in the same
 *   city look alike.
 *
 *   ANY USER AGENT STRING. It changes on every browser update, and it is the
 *   one component trivially spoofed, so it adds churn and no confidence.
 */
export async function computeDeviceHash(): Promise<string | null> {
  const parts = [
    webglSignature(),
    canvasSignature(),
    await audioSignature(),
    hardwareSignature(),
  ].filter((part): part is string => part !== null && part.length > 0)

  // Below two components the digest is mostly the core count, which millions of
  // people share. Reporting it would create matches between strangers, and a
  // flag raised on that would send an operator after a family.
  if (parts.length < 2) return null
  return sha256Hex(parts.join('|'))
}

export async function collectDeviceSignals(): Promise<DeviceSignals> {
  return {
    installId: safe(() => readOrCreateInstallId(), null),
    deviceHash: await computeDeviceHash().catch(() => null),
  }
}

// ── Components ───────────────────────────────────────────────────────────

/**
 * The GPU model and driver, via `WEBGL_debug_renderer_info`.
 *
 * The single most valuable component, and the reason a different browser on the
 * same machine still matches: the string describes the hardware, not the
 * browser. Firefox and some privacy modes refuse the extension, which is
 * handled the same way as everything else here — by contributing nothing.
 */
function webglSignature(): string | null {
  return safe(() => {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (gl === null) return null
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (debugInfo === null) return null
    const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as unknown
    const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as unknown
    const parts = [vendor, renderer].filter((v) => typeof v === 'string' && v.length > 0)
    return parts.length === 0 ? null : `gl:${parts.join('/')}`
  }, null)
}

/**
 * A digest of how this machine rasterises text and shapes.
 *
 * The drawing is arbitrary but must never change: it is the input whose output
 * we are comparing across visits, so editing it would orphan every value ever
 * stored. Anti-aliasing, sub-pixel positioning and the available font stack all
 * differ by GPU, driver and OS, which is where the entropy comes from.
 */
function canvasSignature(): string | null {
  return safe(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 60
    const ctx = canvas.getContext('2d')
    if (ctx === null) return null
    ctx.textBaseline = 'top'
    ctx.font = '14px "Arial"'
    ctx.fillStyle = '#f60'
    ctx.fillRect(10, 10, 80, 20)
    ctx.fillStyle = '#069'
    ctx.fillText('rz-device-0123456789', 12, 14)
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'
    ctx.fillText('rz-device-0123456789', 14, 18)
    const data = canvas.toDataURL()
    // A blocked or randomised canvas often returns a tiny constant. Anything
    // that short is not a rendering, and treating it as one would put every
    // such visitor in the same bucket.
    return data.length < 128 ? null : `cv:${data}`
  }, null)
}

/**
 * A digest of the audio pipeline.
 *
 * `OfflineAudioContext` renders without playing anything, so it needs no user
 * gesture and makes no sound. The floating-point results differ by platform and
 * audio stack in ways that are stable for one machine.
 */
async function audioSignature(): Promise<string | null> {
  try {
    const Ctor =
      (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
        .OfflineAudioContext ??
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext
    if (Ctor === undefined) return null

    const context = new Ctor(1, 5000, 44100)
    const oscillator = context.createOscillator()
    oscillator.type = 'triangle'
    oscillator.frequency.value = 10000
    const compressor = context.createDynamicsCompressor()
    oscillator.connect(compressor)
    compressor.connect(context.destination)
    oscillator.start(0)

    const buffer = await context.startRendering()
    const channel = buffer.getChannelData(0)
    let sum = 0
    for (let i = 0; i < channel.length; i += 1) sum += Math.abs(channel[i])
    // Rounded, because the last bits of a float are not reproducible even on
    // one machine and would make the digest change between visits.
    return `au:${sum.toFixed(4)}`
  } catch {
    return null
  }
}

/** Core count, platform and colour depth — low entropy, but free and stable. */
function hardwareSignature(): string | null {
  return safe(() => {
    const nav = navigator as Navigator & { deviceMemory?: number }
    const parts = [
      `hc:${nav.hardwareConcurrency ?? 0}`,
      `dm:${nav.deviceMemory ?? 0}`,
      `pf:${nav.platform ?? ''}`,
      `cd:${window.screen?.colorDepth ?? 0}`,
    ]
    return parts.join(',')
  }, null)
}

// ── Storage ──────────────────────────────────────────────────────────────

function readStorage(): string | null {
  return safe(() => {
    const value = window.localStorage.getItem(INSTALL_ID_KEY)
    return isPlausibleId(value) ? value : null
  }, null)
}

function writeStorage(value: string): void {
  safe(() => {
    window.localStorage.setItem(INSTALL_ID_KEY, value)
    return null
  }, null)
}

function readCookie(): string | null {
  return safe(() => {
    for (const entry of document.cookie.split(';')) {
      const [name, ...rest] = entry.trim().split('=')
      if (name !== INSTALL_ID_COOKIE) continue
      const value = decodeURIComponent(rest.join('='))
      return isPlausibleId(value) ? value : null
    }
    return null
  }, null)
}

function writeCookie(value: string): void {
  safe(() => {
    // `SameSite=Lax` and no `Secure` flag hard-coded: the cabinet is served over
    // TLS in production and over plain HTTP in local development, and a
    // `Secure` cookie would silently never be set in the second case — which is
    // exactly where somebody would be testing this.
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${INSTALL_ID_COOKIE}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`
    return null
  }, null)
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isPlausibleId(value: string | null): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{8,128}$/.test(value)
}

function randomId(): string | null {
  return safe(() => {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }, null)
}

async function sha256Hex(input: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    // `crypto.subtle` is absent on insecure origins. No digest, no signal —
    // never a thrown error out of a background task.
    return null
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

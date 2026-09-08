/**
 * connect-theme
 * ─────────────
 * The appearance an operator picked for the connect screen, and how it becomes
 * CSS without becoming a way to *inject* CSS.
 *
 * ── Why the screen can have its own look at all ──────────────────────────────
 *
 * The rest of the cabinet wears one concept, chosen on the branding page. This
 * screen is the one place a customer is asked to leave the cabinet and do
 * something in another app, and operators wanted it to be able to carry its own
 * identity — the way the external subscription page used to. So the panel may
 * send a concept here, and when it does not, the screen keeps the cabinet's.
 * Absent is therefore not a failure state: it is the default, and it is the
 * state every deployment starts in.
 *
 * ── Why this is a whitelist and not a stylesheet ─────────────────────────────
 *
 * The values below are written into `style` on a live element. That is a CSS
 * injection surface, and the fact that today's producer is our own generator is
 * not an argument — the same was true of the icon markup that turned out to be
 * an XSS in the panel's own editor, where "it came from the server" was written
 * in a comment and was not true. So:
 *
 *   - only the token NAMES in `CONNECT_THEME_TOKENS` are ever emitted, and a
 *     name that is not one of them is dropped rather than passed through;
 *   - every value is matched against the grammar for what that token holds — a
 *     colour or a length, nothing else;
 *   - the background is the one free-form value, so it is parsed rather than
 *     trusted: gradients only, and no construct that can reach the network,
 *     read another property, or close the declaration.
 *
 * A rejected value leaves the token unset, which means the cabinet's own token
 * answers instead. There is no state in which a malformed theme produces a
 * broken screen, and none in which it produces an unstyled one.
 */
import type { CSSProperties } from 'react'

/**
 * Every custom property this screen is allowed to set, without the `--`.
 *
 * These are the cabinet's OWN tokens, not a second vocabulary: the composition
 * is written against them, so a screen with no theme is already correct and a
 * theme is only a different set of answers to questions the screen was already
 * asking. Adding a token here means the composition uses it; a token the
 * composition does not read has no business arriving.
 */
export const CONNECT_THEME_COLOR_TOKENS = [
  'brand-primary',
  'brand-primary-fg',
  'brand-foreground',
  'brand-muted-foreground',
  'color-surface',
  'color-surface-high',
  'color-border-soft',
  'color-border-strong',
] as const

/** Tokens that carry a length rather than a colour. */
export const CONNECT_THEME_LENGTH_TOKENS = [
  'radius-card',
  'radius-item',
  'radius-pill',
  'glass-blur',
] as const

export type ConnectThemeColorToken = (typeof CONNECT_THEME_COLOR_TOKENS)[number]
export type ConnectThemeLengthToken = (typeof CONNECT_THEME_LENGTH_TOKENS)[number]
export type ConnectThemeToken = ConnectThemeColorToken | ConnectThemeLengthToken

export interface ConnectScreenTheme {
  /** Concept id, kept only so the panel can show which one is selected. */
  readonly presetId: string | null
  readonly tokens: Readonly<Partial<Record<ConnectThemeToken, string>>>
  readonly backgroundColor: string | null
  readonly backgroundImage: string | null
  /**
   * The 4px accent rail down the left edge. Every concept in the book has one
   * and it is the cheapest half of their identity, so it travels as its own
   * value rather than as one more gradient layer nobody can see the seam of.
   */
  readonly rail: string | null
}

/**
 * A colour the browser will certainly understand and that cannot carry
 * anything else.
 *
 * `rgb()`/`hsl()` are here because the panel's generator emits them for alpha,
 * and the neighbouring readers (`card-effect-runtime.asColor`, the panel's own
 * `isSafeHexColor`) were both widened to them for exactly that reason. Hex-only
 * here would repeat the Pixel Card defect: one side reads a colour, the other
 * reads nothing, and nothing in between says they disagree.
 */
const COLOR = /^(?:#[\da-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|transparent)$/i

/** A length. Bare `0` is not accepted: every token here is a real dimension. */
const LENGTH = /^\d+(?:\.\d+)?(?:px|rem)$/

/**
 * The background is the only value with structure, so it is the only one that
 * needs a parser rather than a pattern.
 *
 * Two independent checks, because either alone is bypassable: a character
 * whitelist cannot tell `linear-gradient` from `unknown-function`, and a
 * function whitelist cannot see a comment or an escape used to smuggle one in.
 */
const BACKGROUND_MAX_LENGTH = 4_000
const BACKGROUND_ALLOWED_CHARS = /^[\w\s#%.,()+-]*$/
const BACKGROUND_FUNCTION = /([a-z][\w-]*)\s*\(/gi
const BACKGROUND_FUNCTIONS = new Set([
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
])

/**
 * True when the string is a background this screen will paint.
 *
 * Exported because the panel-side generator is a different codebase on a
 * different release train, and "the two agree" has to be something a test can
 * assert rather than something a comment claims.
 */
export function isSafeBackgroundImage(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > BACKGROUND_MAX_LENGTH) return false
  // `url()` reaches the network and leaks the viewer to whoever it points at;
  // `var()` reads a property this whitelist never approved; `\` and the comment
  // markers exist to hide one of the first two from the checks below.
  if (!BACKGROUND_ALLOWED_CHARS.test(trimmed)) return false
  if (parenthesesUnbalanced(trimmed)) return false
  for (const match of trimmed.matchAll(BACKGROUND_FUNCTION)) {
    if (!BACKGROUND_FUNCTIONS.has(match[1].toLowerCase())) return false
  }
  // A background made of no gradient at all is a colour pretending to be one.
  return /gradient\s*\(/i.test(trimmed)
}

/**
 * An unbalanced value is one the browser will repair for us, and it will not
 * necessarily repair it into the thing the checks above approved.
 */
function parenthesesUnbalanced(value: string): boolean {
  let depth = 0
  for (const character of value) {
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth < 0) return true
    }
  }
  return depth !== 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeColor(value: unknown): string | null {
  return typeof value === 'string' && COLOR.test(value.trim()) ? value.trim() : null
}

/**
 * Narrow the panel's payload into something this screen can paint.
 *
 * Returns `null` for "no theme", which is the ordinary case and means the
 * screen keeps the cabinet's own appearance. It also returns `null` for a theme
 * that survived nothing — an object whose every token was rejected is not a
 * theme, and reporting it as one would give the screen a background with no
 * palette to sit under.
 */
export function readConnectTheme(payload: unknown): ConnectScreenTheme | null {
  if (!isRecord(payload)) return null

  const tokens: Partial<Record<ConnectThemeToken, string>> = {}
  const source = isRecord(payload['tokens']) ? payload['tokens'] : {}
  for (const token of CONNECT_THEME_COLOR_TOKENS) {
    const colour = safeColor(source[token])
    if (colour !== null) tokens[token] = colour
  }
  for (const token of CONNECT_THEME_LENGTH_TOKENS) {
    const raw = source[token]
    if (typeof raw === 'string' && LENGTH.test(raw.trim())) tokens[token] = raw.trim()
  }

  const backgroundImage = isSafeBackgroundImage(payload['backgroundImage'])
    ? payload['backgroundImage'].trim()
    : null
  const backgroundColor = safeColor(payload['backgroundColor'])
  const rail = safeColor(payload['rail'])
  const presetId =
    typeof payload['presetId'] === 'string' && payload['presetId'].length <= 120
      ? payload['presetId']
      : null

  const empty =
    Object.keys(tokens).length === 0 &&
    backgroundImage === null &&
    backgroundColor === null &&
    rail === null
  if (empty) return null

  return { presetId, tokens, backgroundColor, backgroundImage, rail }
}

/**
 * Light or dark, judged from the ground the concept actually paints.
 *
 * ── Why this is needed at all ────────────────────────────────────────────────
 *
 * Native controls are drawn by the browser, not by us. A `<select>`'s open list
 * is the operating system's, and with no `color-scheme` declared anywhere the
 * browser assumes light: on the dark cabinet the platform picker opened as a
 * white sheet with black text over a dark screen. Reported exactly that way —
 * "не в тему попадает".
 *
 * ── Why it is derived and not fixed ──────────────────────────────────────────
 *
 * `color-scheme: dark` would fix the screenshot and break 44 of the 104
 * concepts, which are light-backgrounded. The concept knows its own answer, so
 * the answer is read off the concept.
 *
 * `null` means "this theme does not say" — no concept, or one with no ground
 * colour — and the caller then uses the cabinet's own mode, which is the right
 * answer for a screen wearing the cabinet's own appearance.
 */
export function themeColorScheme(theme: ConnectScreenTheme | null): 'light' | 'dark' | null {
  const ground = theme?.backgroundColor ?? theme?.tokens['color-surface-high'] ?? null
  if (ground === null) return null
  const channels = readHexChannels(ground)
  if (channels === null) return null
  // WCAG relative luminance; 0.18 is the crossover the same formula puts
  // between "text on this wants to be dark" and "wants to be light".
  const [r, g, b] = channels.map((value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18 ? 'dark' : 'light'
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Anything else answers null. */
function readHexChannels(value: string): readonly [number, number, number] | null {
  const body = value.trim().replace('#', '')
  const wide = body.length >= 6
  if (body.length !== (wide ? 6 : 3) && body.length !== (wide ? 8 : 4)) return null
  const size = wide ? 2 : 1
  const read = (index: number): number => {
    const slice = body.slice(index * size, index * size + size)
    const parsed = Number.parseInt(wide ? slice : slice + slice, 16)
    return Number.isNaN(parsed) ? -1 : parsed
  }
  const rgb = [read(0), read(1), read(2)] as const
  return rgb.some((v) => v < 0) ? null : rgb
}

/**
 * The inline style that carries the theme.
 *
 * Scoped to one element rather than written onto `documentElement`: the
 * customer arrives here from a cabinet wearing a different concept and leaves
 * back into it, and a token set on the root would follow them out. The cabinet
 * paints its background on the body, so this element paints its own on top and
 * the two never have to agree.
 */
export function connectThemeStyle(theme: ConnectScreenTheme | null): CSSProperties {
  if (theme === null) return {}
  const style: Record<string, string> = {}
  for (const [token, value] of Object.entries(theme.tokens)) {
    style[`--${token}`] = value
  }
  if (theme.backgroundColor !== null) style.backgroundColor = theme.backgroundColor
  if (theme.backgroundImage !== null) style.backgroundImage = theme.backgroundImage

  // `color`, explicitly, on the SAME element that declares the token.
  //
  // Redefining `--brand-foreground` here does not repaint the text below it,
  // and that is not a subtlety — it is how custom properties work. `color` is
  // inherited, and it was already COMPUTED further up: the layout shell carries
  // `text-foreground` (→ `--foreground`, which is `var(--brand-foreground)`) and
  // `body` sets `color: var(--brand-foreground)` outright. Substitution happens
  // where the declaration is, so both resolved against the cabinet's value long
  // before this element existed. Everything underneath then INHERITS a finished
  // colour that no descendant redefinition can revise.
  //
  // The cost of leaving it out was not subtle either: 44 of the 104 concepts
  // are light-backgrounded, and every one of them painted the cabinet's near
  // white body text onto its own near white ground — about 1.02:1. The labels
  // stayed readable because they ask for `var(--brand-muted-foreground)` inside
  // this subtree, so those DID resolve against the override; legible labels over
  // invisible values is the exact signature.
  //
  // Safe when a token is missing: `--brand-foreground` still has its `:root`
  // default, so this resolves to what the screen would have inherited anyway.
  style.color = 'var(--brand-foreground)'

  // Tells the browser which way to draw the controls it owns — the platform
  // picker's open list above all. Without it the list is the UA default, which
  // is white, on a screen that may well be black.
  const scheme = themeColorScheme(theme)
  if (scheme !== null) style.colorScheme = scheme
  // The rail is deliberately NOT emitted as a custom property. A token the
  // screen reads has to have a declared default in `index.css` — that is what
  // `connect-page-tokens.test.ts` checks, and it is checking for a real thing:
  // a property whose only value is the inline one renders as nothing the moment
  // the inline style is absent. The rail has no cabinet-wide meaning, so it is
  // read straight off the theme by the element that draws it.
  return style as CSSProperties
}

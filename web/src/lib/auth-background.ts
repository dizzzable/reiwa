/**
 * `branding.authBackground` — the operator's media behind the entry screens
 * («Фон https» in Web Reiwa).
 *
 * The panel writes `{ kind: 'image' | 'video', url }`; this module is the only
 * reader, and it is deliberately paranoid: the value crosses three caches
 * (panel → cabinet → this browser) and a payload written by an older panel has
 * no such key at all. Anything this build cannot prove safe resolves to `none`,
 * which is exactly the rendering that existed before the setting.
 *
 * What is allowed:
 *  - `https://` — an absolute address for either kind.
 *  - `/uploads/branding/<file>` — a file the operator uploaded in the panel.
 *    For an image any extension the branding bucket holds; for a video only
 *    `.mp4` / `.webm`, the two the cabinet's relay types (a video slot pointed
 *    at a `.png` would be a black sheet). The relay streams video with Range
 *    support and does not mirror it to disk — see `app.ts`.
 *
 * No `data:` URIs: a wallpaper is not worth an inlined megabyte in a payload
 * that every first paint ships.
 */

export type AuthBackgroundKind = 'none' | 'image' | 'video'

export interface ResolvedAuthBackground {
  readonly kind: AuthBackgroundKind
  /** Present for both real kinds; `null` for `none`. */
  readonly url: string | null
}

/** Absolute, credential-free, whitespace-free HTTPS address. */
const HTTPS_URL = /^https:\/\/(?![^/\s]+@)[^\s"'<>\\]+$/i
/** The cabinet's relayed upload tree: any image file the panel stored. */
const RELAYED_UPLOAD = /^\/uploads\/branding\/[A-Za-z0-9][A-Za-z0-9._-]*$/i
/** The same tree, restricted to the two video types the relay serves. */
const RELAYED_VIDEO_UPLOAD = /^\/uploads\/branding\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mp4|webm)$/i

const NONE: ResolvedAuthBackground = { kind: 'none', url: null }

/** Longer than any operator needs; also a ceiling for a runaway paste. */
const MAX_URL_LENGTH = 2048

function readUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isAllowedImage(url: string): boolean {
  return HTTPS_URL.test(url) || RELAYED_UPLOAD.test(url)
}

function isAllowedVideo(url: string): boolean {
  return HTTPS_URL.test(url) || RELAYED_VIDEO_UPLOAD.test(url)
}

export function resolveAuthBackground(value: unknown): ResolvedAuthBackground {
  if (typeof value !== 'object' || value === null) return NONE

  const { kind } = value as { kind?: unknown }
  if (kind !== 'image' && kind !== 'video') return NONE

  const url = readUrl((value as { url?: unknown }).url)
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return NONE

  const allowed = kind === 'video' ? isAllowedVideo(url) : isAllowedImage(url)
  return allowed ? { kind, url } : NONE
}

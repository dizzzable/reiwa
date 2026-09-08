/**
 * An operator's own wording, laid over the shipped dictionary.
 *
 * WHY A LAYER AND NOT A REPLACEMENT. The obvious shape — mount a file that
 * REPLACES `ru.json` — works exactly until the next update: we add keys, the
 * operator's copy does not have them, and their cabinet starts showing blanks
 * or raw keys for everything written since they made the copy. So the file is
 * an OVERLAY: it names only the strings the operator wanted different, and
 * every other string keeps arriving from the build and keeps improving with it.
 *
 * The same precedence the bot has had for a long time
 * (`src/infrastructure/i18n/translator/translator.ts`, adopted from the
 * snoups/remnashop convention) with ONE deliberate difference: the bot's last
 * resort is to print the key itself, because a visible failure beats silent
 * gibberish for an operator reading their own bot. A subscriber must never see
 * `plans.durationOptions_one`, so here the last resort is the string we
 * shipped. An overlay can add wording; it can never take wording away.
 *
 * WHERE THE FILE GOES. Beside `index.html`, at a path with no build hash in it
 * — that is the whole point, since a hashed name cannot be the target of a
 * stable `-v` mount:
 *
 *   docker run -v ./ru.override.json:/usr/share/nginx/html/locales/ru.override.json   (SPA image)
 *   docker run -v ./ru.override.json:/app/web/locales/ru.override.json                (combined image)
 *
 * A missing file is the normal case and costs one 404. A broken file is
 * ignored. Neither can stop the cabinet from rendering, which is the property
 * that makes this safe to hand to somebody with a text editor and a shell.
 */

/** Directory beside `index.html`. Deliberately not `/assets/`, which the service worker caches for 30 days. */
export const LOCALE_OVERLAY_DIR = 'locales'

/** `locales/<lang>.override.json` — named so nobody mistakes it for a build artefact. */
export function localeOverlayPath(lang: string, base = '/'): string {
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}${LOCALE_OVERLAY_DIR}/${lang}.override.json`
}

/**
 * How deep a nested overlay may go.
 *
 * The shipped dictionary is four levels at its deepest. Eight leaves room and
 * still refuses a file that is a cycle flattened by `JSON.parse` into something
 * pathological.
 */
export const MAX_OVERLAY_DEPTH = 8

/** Bigger than the entire shipped dictionary; small enough that a mistake is not a memory problem. */
export const MAX_OVERLAY_BYTES = 512 * 1024

/**
 * A key segment i18next can actually address.
 *
 * Anything else is a typo or an attempt at something else, and both should be
 * dropped rather than stored: an unaddressable key is a string the operator
 * believes they changed and did not.
 */
const KEY_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/

export type OverlayTree = { readonly [key: string]: string | OverlayTree }

/**
 * Keep the strings, drop everything else, and never throw.
 *
 * A number, a boolean or an array in a translation slot is not a translation:
 * i18next would render `[object Object]` or crash the interpolation. Dropping
 * the entry leaves the shipped string in place, which is always a working
 * answer.
 */
export function sanitiseOverlay(
  value: unknown,
  depth = 0,
  /**
   * The shipped dictionary at this level, when the caller has it.
   *
   * ── Why shape has to be checked against the dictionary ──────────────────────
   *
   * The overlay is merged with i18next's `deepExtend(…, overwrite: true)`, and
   * that function does exactly what it says: a STRING in the overlay replaces
   * whatever sits at that key, including a whole section. So an operator who
   * writes `{"plans": "Тарифы"}` — a reasonable-looking guess at how this works —
   * does not rename anything. They delete every string under `plans`, and the
   * cabinet renders `plans.durationOptions_one` and `plans.title` as literal
   * text to every customer until somebody removes the file.
   *
   * Checked here rather than in the merge because this is the only place that
   * can answer honestly: at merge time the damage is already described.
   *
   * Omitted (`undefined`) means "no dictionary to compare against", and then
   * only the shape rules above apply — that is the mode the unit tests use and
   * the mode a caller without a loaded bundle gets. It is deliberately NOT the
   * same as an empty dictionary, which would drop everything.
   */
  base?: unknown,
): OverlayTree | null {
  if (depth >= MAX_OVERLAY_DEPTH) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const baseRecord =
    typeof base === 'object' && base !== null && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : undefined
  const out: Record<string, string | OverlayTree> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY_SEGMENT.test(key)) continue
    const shipped = baseRecord === undefined ? undefined : baseRecord[key]
    const shippedIsSection =
      typeof shipped === 'object' && shipped !== null && !Array.isArray(shipped)
    if (typeof entry === 'string') {
      // A string where we ship a section would erase the section.
      if (shippedIsSection) continue
      out[key] = entry
      continue
    }
    // A section where we ship a string is the mirror mistake: harmless to the
    // rest of the dictionary, but it replaces one string with an object that
    // renders as `[object Object]`, so it is dropped too.
    if (baseRecord !== undefined && shipped !== undefined && !shippedIsSection) continue
    const nested = sanitiseOverlay(entry, depth + 1, shipped)
    if (nested !== null) out[key] = nested
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Read one language's overlay, or `null` when there is nothing usable.
 *
 * Every failure answers `null`: no file, a 404, an HTML error page from a proxy,
 * a JSON syntax error, a file too large, a network that is not there. The
 * caller cannot tell them apart and should not — in every one of them the
 * correct behaviour is the same, and it is what the cabinet did before this
 * existed.
 */
export async function loadLocaleOverlay(
  lang: string,
  options: {
    readonly base?: string
    readonly fetchImpl?: typeof fetch
    readonly maxBytes?: number
    /**
     * The shipped dictionary, so an overlay cannot delete a section.
     *
     * Named `dictionary` and not `base`: `base` on this options object is
     * already the URL path prefix, and two unrelated meanings under one name is
     * how the wrong one gets passed.
     */
    readonly dictionary?: unknown
  } = {},
): Promise<OverlayTree | null> {
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
  if (doFetch === undefined) return null
  if (!KEY_SEGMENT.test(lang)) return null

  try {
    const response = await doFetch(localeOverlayPath(lang, options.base ?? '/'), {
      // The file is edited by hand on the server and expected to take effect on
      // the next load. A cached copy would make an operator think their edit
      // did nothing.
      cache: 'no-cache',
      credentials: 'same-origin',
    })
    if (!response.ok) return null
    const text = await response.text()
    if (text.length > (options.maxBytes ?? MAX_OVERLAY_BYTES)) return null
    return sanitiseOverlay(JSON.parse(text), 0, options.dictionary)
  } catch {
    // Deliberately silent to the customer and deliberately total. A missing
    // overlay is the ordinary case; a broken one is the operator's to fix, and
    // the cabinet's job meanwhile is to look exactly as it shipped.
    return null
  }
}

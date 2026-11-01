import {
  DOCUMENT_PUBLIC_CONFIG_ELEMENT_ID,
  DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH,
} from '../application/ports/public-config-persistence.port.js';

/**
 * THE PUBLIC CONFIG, INSIDE THE DOCUMENT THAT NEEDS IT.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The API has always written the operator's name and icons into the head it
 * serves. The PAGE was another matter: the name on the screen, the logo, the
 * palette are drawn by the browser from `GET /api/v1/public-config`, and until
 * that answered a browser with no saved copy painted the built-in «Reiwa».
 * Returning visitors never saw it — their browser keeps a copy — so it reached
 * exactly the people an operator least wants to show it to: someone opening
 * the cabinet for the first time (the owner, 01.11.2026: a friend «увидел
 * reiwa а не мое название»).
 *
 * The server holds the answer already — it read it for the head, from the same
 * cache the route serves. So it hands it over in the same response: a data
 * block (`type="application/json"`, never executed, so the CSP has no say)
 * that `theme-bootstrap.js` reads before the bundle and the branding provider
 * reads on its first render.
 *
 * ── Where ───────────────────────────────────────────────────────────────────
 * Before `theme-bootstrap.js`: that script runs synchronously as the parser
 * reaches it, and an element placed after it does not exist yet. With no such
 * script (a template that changed), before `</head>`; with no `</head>`, not
 * at all — pure and total, like the other head writers: a document is never
 * failed over this.
 *
 * ── Size ────────────────────────────────────────────────────────────────────
 * Skipped above {@link DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH}, the cap the browser
 * applies to its own saved copy: a copy the browser would refuse is only bytes.
 * The bootstrap request still runs, so nothing is lost but the head start.
 */

const THEME_BOOTSTRAP_TAG = /<script\b[^>]*\bsrc=(["'])\/theme-bootstrap\.js\1[^>]*>\s*<\/script\s*>/i;
const HEAD_CLOSE = /<\/head\s*>/i;

/**
 * JSON that is safe as the text of a `<script>` data block. Only `</script`
 * can end the block early, so `<` is what must not appear; `>` and `&` go too,
 * and U+2028/U+2029 for any reader that still treats them as line ends.
 * `JSON.parse` reads every escape back to the same character. `null` when the
 * value cannot be written down (a cycle, a BigInt).
 */
export function serializeForScript(value: unknown): string | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Insert `insert` at the first match of `pattern` (before it), or `null` for no match. */
function insertBefore(html: string, pattern: RegExp, insert: string): string | null {
  const match = pattern.exec(html);
  if (match === null) return null;
  // Slices, not `String.replace`: a `$` in the operator's name must stay a `$`.
  return html.slice(0, match.index) + insert + html.slice(match.index);
}

/**
 * The document with `body` — exactly what `GET /api/v1/public-config` would
 * answer — written into its head. Unchanged when the body cannot be written
 * down, is over the cap, or the template has no place for it.
 */
export function embedPublicConfig(html: string, body: unknown): string {
  if (body === null || typeof body !== 'object') return html;
  const json = serializeForScript(body);
  if (json === null || json.length > DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH) return html;
  const element = `<script id="${DOCUMENT_PUBLIC_CONFIG_ELEMENT_ID}" type="application/json">${json}</script>\n        `;
  return insertBefore(html, THEME_BOOTSTRAP_TAG, element) ?? insertBefore(html, HEAD_CLOSE, element) ?? html;
}

const STOCK_TITLE_ELEMENT = /<title\b[^>]*>\s*Reiwa\s*<\/title\s*>/i;
const STOCK_APPLE_WEB_APP_TITLE_TAG =
  /[ \t]*<meta\b[^>]*\bname=(["'])apple-mobile-web-app-title\1[^>]*\bcontent=(["'])Reiwa\2[^>]*>[ \t]*\r?\n?/i;
const STOCK_FAVICON_TAG = /<link\b[^>]*\brel=(["'])icon\1[^>]*\bhref=(["'])\/Reiwa-logo\.svg\2[^>]*>/i;
const STOCK_APPLE_TOUCH_ICON_TAG =
  /[ \t]*<link\b[^>]*\brel=(["'])apple-touch-icon\1[^>]*\bhref=(["'])\/icons\/icon-192x192\.png\2[^>]*>[ \t]*\r?\n?/i;

/**
 * The document served when the server has NO operator config at all — nothing
 * in memory, and neither the panel nor the copy in Redis answered within the
 * document's deadline (or no copy was ever saved), which after a start is a
 * matter of seconds (`public-config-warmup.ts`). It used to be the build's
 * file byte for byte, naming «Reiwa» in the tab, in the home-screen title, and
 * in any link preview fetched in that window — and Telegram keeps a preview.
 * Now nothing of Reiwa's is in it: an empty `<title>` (the browser shows the
 * address), no home-screen title, an empty tab icon (`data:,`, which also
 * keeps the browser from asking for `/favicon.ico`) and no home-screen icon.
 * The page itself waits on a neutral screen until the config arrives
 * (`web/src/lib/branding-provider.tsx`), which writes the operator's icons.
 */
export function neutralizeStockHead(html: string): string {
  return html
    .replace(STOCK_TITLE_ELEMENT, () => '<title></title>')
    .replace(STOCK_APPLE_WEB_APP_TITLE_TAG, () => '')
    .replace(STOCK_FAVICON_TAG, () => '<link rel="icon" href="data:," />')
    .replace(STOCK_APPLE_TOUCH_ICON_TAG, () => '');
}

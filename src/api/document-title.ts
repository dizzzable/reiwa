/**
 * The cabinet's name in the head of every document it serves: the browser tab,
 * and the preview of any cabinet link (the owner's decision of 26.09.2026 —
 * the operator's name, never «Reiwa»; no description and no image).
 *
 * ── Why the server writes it ─────────────────────────────────────────────────
 *
 * A link preview (Telegram and other messengers, social networks) and a crawler
 * read the DELIVERED bytes; none of them runs the bundle. The SPA sets
 * `document.title` from a React effect (`web/src/lib/branding-provider.tsx`), so
 * until this every preview of a cabinet said «Reiwa» — the build's own `<title>`
 * (`web/index.html`) — whatever the operator is called.
 *
 * ── Which name goes where ────────────────────────────────────────────────────
 *
 *  - The TITLE (`<title>`, `og:title`, `twitter:title`) is the tab title the SPA
 *    sets at runtime, by the same rule, so the tab keeps its name when the
 *    bundle boots and a preview says what the tab says: the panel's «Заголовок
 *    веб-страницы», then «Название проекта» (both on «Платформа» → «Брендинг»),
 *    then «Название бренда» («WEB Reiwa» → «Идентичность»). The runtime copy is
 *    `web/src/lib/document-title.ts` — the SPA may not import this file
 *    (`web/test/build-isolation.test.ts`) — and
 *    `test/web/document-title-parity.test.ts` holds the two equal.
 *  - The SITE NAME (`og:site_name`) is the brand itself, «Название бренда»: the
 *    name the cabinet shows subscribers everywhere else — the header, the
 *    splash, the name under the home-screen icon. When the brand is the stock
 *    one, the title stands in.
 *
 * «Reiwa» is what the panel answers for a brand name that was never set, and it
 * is what the build's `<title>` already says. So an operator whose only name is
 * «Reiwa» gets NOTHING written: the document is exactly the one the build
 * ships, `<title>Reiwa</title>` and no preview tags, as before this change.
 *
 * No imports, on purpose: the parity spec loads this file under the web app's
 * compiler options as well as the API's.
 */

/** The build's own `<title>`, and the panel's default «Название бренда». */
export const STOCK_BRAND_NAME = 'Reiwa';

/**
 * The longest name written, in code points: the longest the panel accepts
 * («Заголовок веб-страницы» and «Название проекта» 128, «Название бренда» 64).
 * It never cuts a name the panel saved; it bounds a payload that is not one.
 */
export const MAX_DOCUMENT_NAME_LENGTH = 128;

export interface DocumentNames {
  /** `<title>`, `og:title`, `twitter:title`: the tab title. */
  readonly title: string;
  /** `og:site_name`: the brand, or the title when the brand is the stock one. */
  readonly siteName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A name as the head carries it. Runs of whitespace and control characters
 * become one space — the tab shows them so anyway — the ends are trimmed, and
 * the value is cut at {@link MAX_DOCUMENT_NAME_LENGTH} code points, never inside
 * a character. Anything but a string is no name.
 */
export function cleanDocumentName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const folded = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return Array.from(folded).slice(0, MAX_DOCUMENT_NAME_LENGTH).join('').trim();
}

/**
 * The names a public-config body (`/api/internal/branding/public-config`, as the
 * cabinet keeps it) gives the document, or `null` when the operator set none of
 * its own — the document then stays exactly as built.
 */
export function documentNamesOf(publicConfig: unknown): DocumentNames | null {
  const config = isRecord(publicConfig) ? publicConfig : {};
  const branding = isRecord(config['branding']) ? config['branding'] : {};
  const platform = isRecord(config['platformBranding']) ? config['platformBranding'] : {};
  const brand = cleanDocumentName(branding['brandName']);
  const ownBrand = brand !== STOCK_BRAND_NAME ? brand : '';
  const title =
    cleanDocumentName(platform['webTitle']) || cleanDocumentName(platform['projectName']) || ownBrand;
  if (title.length === 0) return null;
  return { title, siteName: ownBrand || title };
}

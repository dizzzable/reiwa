/**
 * The name the cabinet's tab carries: the panel's «Заголовок веб-страницы»,
 * then «Название проекта» (both on «Платформа» → «Брендинг»), then «Название
 * бренда» («WEB Reiwa» → «Идентичность»).
 *
 * The API writes the same name into the document it serves — `<title>` and the
 * link-preview tags — by the same rule (`src/api/document-title.ts`), so the tab
 * keeps its name when the bundle boots and a link preview says what the tab
 * says. This app may not import the API's file (`web/test/build-isolation.test.ts`),
 * hence the copy; `test/web/document-title-parity.test.ts` holds the two equal.
 * Change the rule in both.
 */

/** The longest name written, in code points: the longest the panel accepts. */
export const MAX_DOCUMENT_TITLE_LENGTH = 128;

/** What the tab title is read from: the public config, as the provider holds it. */
export interface DocumentTitleSource {
  readonly branding?: { readonly brandName?: string | null } | null;
  readonly platformBranding?: {
    readonly webTitle?: string | null;
    readonly projectName?: string | null;
  } | null;
}

/**
 * A name as the tab shows it: runs of whitespace and control characters become
 * one space, the ends are trimmed, and it is cut at
 * {@link MAX_DOCUMENT_TITLE_LENGTH} code points, never inside a character.
 */
export function cleanDocumentTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  const folded = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return Array.from(folded).slice(0, MAX_DOCUMENT_TITLE_LENGTH).join("").trim();
}

/** The tab title, or `null` when the configuration names nothing. */
export function documentTitleOf(config: DocumentTitleSource): string | null {
  const title =
    cleanDocumentTitle(config.platformBranding?.webTitle) ||
    cleanDocumentTitle(config.platformBranding?.projectName) ||
    cleanDocumentTitle(config.branding?.brandName);
  return title.length > 0 ? title : null;
}

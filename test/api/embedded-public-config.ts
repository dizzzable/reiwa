import { DOCUMENT_PUBLIC_CONFIG_ELEMENT_ID } from '../../src/application/ports/public-config-persistence.port.js';

const ELEMENT = new RegExp(
  `<script id="${DOCUMENT_PUBLIC_CONFIG_ELEMENT_ID}" type="application/json">([\\s\\S]*?)</script>\\s*`,
);

/**
 * A served document split into the public config it carries
 * (`api/document-public-config.ts`) and everything else — the document as it
 * was before the copy was written in, whitespace included, so the assertions
 * that pinned a head byte for byte still can.
 */
export function splitEmbeddedPublicConfig(html: string): { readonly html: string; readonly config: unknown } {
  const match = ELEMENT.exec(html);
  if (match === null) return { html, config: null };
  return {
    html: html.slice(0, match.index) + html.slice(match.index + match[0].length),
    config: JSON.parse(match[1] ?? 'null') as unknown,
  };
}

import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_NAME_LENGTH,
  STOCK_BRAND_NAME,
  documentNamesOf,
} from "../../src/api/document-title.js";
import {
  MAX_DOCUMENT_TITLE_LENGTH,
  documentTitleOf,
  type DocumentTitleSource,
} from "../../web/src/lib/document-title.js";
import { DEFAULT_PUBLIC_CONFIG } from "../../web/src/types/branding.js";

/**
 * Three writers of the cabinet's tab title, one rule.
 *
 *   1. The API, into the document it serves (`src/api/document-title.ts`) —
 *      what a link preview reads.
 *   2. `web/public/theme-bootstrap.js`, from the stored public config, before
 *      the bundle runs — only over the build's own «Reiwa».
 *   3. The app after boot (`web/src/lib/document-title.ts`, applied by
 *      `branding-provider.tsx`).
 *
 * The SPA may not import the API's file (`web/test/build-isolation.test.ts`),
 * and the bootstrap may import nothing at all, so the rule is written three
 * times. Held here: for the same configuration the tab keeps the name it was
 * served with through both runtime writers — no flicker, and a preview says
 * what the tab says.
 */

const BOOTSTRAP_SOURCE = readFileSync(
  new URL("../../web/public/theme-bootstrap.js", import.meta.url),
  "utf8",
);
const STORAGE_KEY = "reiwa_public_config_snapshot_v1";

/**
 * ONE compiled script and ONE context for every run: the loop below runs the
 * script hundreds of times, and a context per run is a V8 global each — enough
 * of them to crowd a test worker's heap. The script is an IIFE that reads
 * `document` and `window` when it runs, so swapping them between runs is a
 * fresh page as far as it can tell.
 */
const BOOTSTRAP = new Script(BOOTSTRAP_SOURCE, { filename: "theme-bootstrap.js" });
const PAGE: { document?: { title: string }; window?: unknown } = {};
const PAGE_CONTEXT = createContext(PAGE);

/** The pre-paint script over a stored snapshot, on a document served with `servedTitle`. */
function titleAfterBootstrap(snapshot: unknown, servedTitle: string): string {
  const stored = JSON.stringify(snapshot);
  const document = {
    title: servedTitle,
    documentElement: {
      dataset: {},
      classList: { toggle: () => undefined },
      style: { colorScheme: "", setProperty: () => undefined },
    },
    querySelector: () => null,
  };
  PAGE.document = document;
  PAGE.window = {
    localStorage: {
      getItem: (key: string) => (key === STORAGE_KEY ? stored : null),
    },
  };
  BOOTSTRAP.runInContext(PAGE_CONTEXT);
  return document.title;
}

function snapshotWith(brandName: unknown, webTitle: unknown, projectName: unknown) {
  return {
    ...DEFAULT_PUBLIC_CONFIG,
    branding: { ...DEFAULT_PUBLIC_CONFIG.branding, brandName },
    platformBranding: { webTitle, projectName },
  };
}

const BEL = String.fromCharCode(7);
/** Names that have tripped a rule before: blanks, the stock name, markup, control characters, length, non-strings. */
const NAMES: readonly unknown[] = [
  undefined,
  null,
  "  ",
  STOCK_BRAND_NAME,
  "Winger VPN",
  `  Winger\n\t VPN${BEL} `,
  '<b>"Q&A"</b> $&',
  "é".repeat(140),
  42,
];

describe("the tab title: served, pre-paint and after boot", () => {
  it("keeps the name it was served with through both runtime writers, for every combination", () => {
    let combinations = 0;
    for (const webTitle of NAMES) {
      for (const projectName of NAMES) {
        for (const brandName of NAMES) {
          const config = snapshotWith(brandName, webTitle, projectName);
          const served = documentNamesOf(config)?.title ?? STOCK_BRAND_NAME;
          const prePaint = titleAfterBootstrap(config, served);
          const afterBoot = documentTitleOf(config as DocumentTitleSource) ?? prePaint;
          const label = JSON.stringify({ webTitle, projectName, brandName });
          expect(prePaint, label).toBe(served);
          expect(afterBoot, label).toBe(served);
          combinations += 1;
        }
      }
    }
    expect(combinations).toBe(NAMES.length ** 3);
  });

  it("the pre-paint script names a document the API could not — the unbranded fallback — from the stored copy", () => {
    // Non-vacuity for the loop above: with this base snapshot the script does
    // reach its title step.
    expect(titleAfterBootstrap(snapshotWith("Winger VPN", null, null), STOCK_BRAND_NAME)).toBe("Winger VPN");
    expect(
      titleAfterBootstrap(snapshotWith("Winger VPN", "Winger — быстрый VPN", "Winger"), STOCK_BRAND_NAME),
    ).toBe("Winger — быстрый VPN");
  });

  it("the pre-paint script never swaps a name the API served for an older stored one", () => {
    // Renamed in the panel: the document is served with the new name while the
    // browser still stores the old configuration.
    expect(titleAfterBootstrap(snapshotWith("Old Name", null, null), "New Name")).toBe("New Name");
  });

  it("cuts at the same length everywhere", () => {
    expect(MAX_DOCUMENT_TITLE_LENGTH).toBe(MAX_DOCUMENT_NAME_LENGTH);
    expect(BOOTSTRAP_SOURCE).toContain(`var MAX_TITLE_LENGTH = ${MAX_DOCUMENT_NAME_LENGTH};`);
    expect(BOOTSTRAP_SOURCE).toContain(`var STOCK_TITLE = "${STOCK_BRAND_NAME}";`);
  });
});

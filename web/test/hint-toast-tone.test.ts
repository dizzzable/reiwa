import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A TONE THAT IS DRAWN.
 *
 * An operator picks one of four tones for every pop-up. In MODAL mode the
 * cabinet draws it — a coloured rule above the title. In TOAST mode it drew
 * nothing: all four arrived as the same near-black glass card, so "your payment
 * did not go through" and "your trial has started" were visually identical and
 * the operator's choice was a control that did nothing.
 *
 * The cause was not a missing colour but WHERE the surface was written. Sonner
 * paints its cards through CSS, and `main.tsx` set `background`, `color`,
 * `border` and `boxShadow` inline on `toastOptions.style`. An inline
 * declaration beats every stylesheet rule, so no per-tone CSS — sonner's own
 * `richColors` included — could ever have applied.
 *
 * That is why this file guards the ARRANGEMENT and not just the colours: the
 * regression is one `style:` object away, and it repaints nothing red.
 */

const root = resolve(__dirname, "..");
const css = readFileSync(resolve(root, "src/index.css"), "utf8");
const main = readFileSync(resolve(root, "src/main.tsx"), "utf8");

/** The toast block, so a colour found elsewhere in a 900-line sheet cannot pass. */
const TONE_RULE = (type: string): string | null => {
  const pattern = new RegExp(
    `\\[data-sonner-toast\\]\\[data-styled="true"\\]\\.cabinet-toast\\[data-type="${type}"\\]\\s*\\{([^}]*)\\}`,
  );
  return pattern.exec(css)?.[1] ?? null;
};

describe("the toast surface", () => {
  it("is a class, not an inline style", () => {
    // THE ACTUAL DEFECT. Anything in `toastOptions.style` outranks the
    // stylesheet, so a well-meaning tweak put back here silently returns all
    // four tones to identical.
    const options = /toastOptions=\{\{([\s\S]*?)\}\}/.exec(main)?.[1] ?? "";

    expect(options).toContain("cabinet-toast");
    expect(options).not.toContain("style:");
  });

  it("tells sonner the surface is dark, so its children are legible", () => {
    // Sonner styles the toast's CHILDREN — description, action button, "later"
    // chip, close button — from its own palette, and its default is light. The
    // card has always been near-black, so the hint BODY rendered #3f3f3f on
    // rgba(9,9,11): about 1.9:1, which is the operator's whole message
    // invisible. Nothing in the cabinet had ever passed `description` before
    // the hint toast, so the palette had never been asked for anything but a
    // title.
    expect(main).toMatch(/<Toaster[\s\S]*?theme="dark"/);
  });

  it("gives a focused button a ring that shows on a dark card", () => {
    // Sonner's own is `rgba(0,0,0,.4)` — written for its white card, invisible
    // on this one.
    expect(css).toMatch(
      /\.cabinet-toast \[data-button\]:focus-visible \{[^}]*box-shadow[^}]*rgba\(255, 255, 255/,
    );
  });

  it("is applied to the Toaster the cabinet actually mounts", () => {
    // A class nothing wears styles nothing. The rules below would all still
    // parse, and every toast would be sonner's default white.
    expect(main).toMatch(/<Toaster[\s\S]*?className: 'cabinet-toast'/);
  });

  it("keeps the glass it had", () => {
    const surface = /\[data-sonner-toast\]\[data-styled="true"\]\.cabinet-toast\s*\{([^}]*)\}/.exec(
      css,
    )?.[1];

    expect(surface, "the base card rule is gone").toBeDefined();
    for (const declaration of [
      "background: rgba(9, 9, 11, 0.92)",
      "backdrop-filter: blur(40px)",
      "border-radius: 16px",
    ]) {
      expect(surface).toContain(declaration);
    }
  });
});

describe("each tone", () => {
  /** Sonner's four `data-type` values, in the order the panel's tones map onto them. */
  const TONES = ["info", "success", "warning", "error"] as const;

  it("has a rule of its own", () => {
    for (const tone of TONES) {
      expect(TONE_RULE(tone), `no rule for ${tone}`).not.toBeNull();
    }
  });

  it("draws a colour no other tone draws", () => {
    // Four rules that all resolved to the same colour would be the original
    // defect with more CSS. The rail is the only thing distinguishing them, so
    // its colour has to be distinct four ways.
    const rails = TONES.map((tone) => /inset 3px 0 0 (#[0-9a-f]{6})/i.exec(TONE_RULE(tone) ?? "")?.[1]);

    expect(rails.every((rail) => rail !== undefined), `parsed rails: ${rails.join(", ")}`).toBe(true);
    expect(new Set(rails).size).toBe(4);
  });

  it("keeps the card's drop shadow beside the rail", () => {
    // `box-shadow` is one property: a per-tone rule that lists only the inset
    // rail REPLACES the drop shadow, and the toast loses the lift that
    // separates it from the page underneath.
    for (const tone of TONES) {
      expect(TONE_RULE(tone), tone).toContain("0 12px 40px rgba(0, 0, 0, 0.55)");
    }
  });

  it("does not paint the whole card", () => {
    // `richColors` and a per-tone `background` are the same mistake the modal's
    // own comment rejects: a surface painted entirely in a warning colour reads
    // as an error the customer caused.
    for (const tone of TONES) {
      // ANY background property, not just the shorthand. `background:` alone
      // let `background-color`, `background-image` and a custom property paint
      // the whole card in the tone — the exact thing this case forbids — and it
      // stayed green while one of them did it.
      expect(TONE_RULE(tone), tone).not.toMatch(/(^|[\s;])background[-a-z]*\s*:/);
    }
    expect(main).not.toContain("richColors");
  });
});

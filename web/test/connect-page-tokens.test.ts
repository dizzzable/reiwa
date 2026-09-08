import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * EVERY CSS VARIABLE THE CONNECT SCREEN USES HAS TO EXIST.
 *
 * This screen is built entirely out of the cabinet's own tokens — that is the
 * whole reason it inherits all 104 appearance concepts without implementing any
 * of them. The cost of that is a class of bug nothing else here catches: a
 * variable name that is close but wrong.
 *
 * `color: var(--does-not-exist)` is invalid at computed-value time, so the
 * property does not fall back to something sensible — it falls back to
 * `inherit`, or to the initial value. The button still renders, still has its
 * background, and its label quietly takes a colour nobody chose. In a light
 * theme that is white on green; in a dark one it looks fine, which is exactly
 * why a person reviewing it on their own machine would not see it.
 *
 * This caught a real one: the screen asked for `--brand-primary-foreground`,
 * and the token is called `--brand-primary-fg`. The primary call to action on
 * the screen had no text colour of its own.
 *
 * Read off the source rather than a hand-written list, because a hand-written
 * list is one more place to forget.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(here, "..", path), "utf8");

const SCREENS = [
  "src/features/connect/connect-page.tsx",
  "src/features/connect/connect-platform-picker.tsx",
  "src/features/connect/connect-link-dialog.tsx",
] as const;

/**
 * The source with its prose removed.
 *
 * These files explain themselves at length, and the explanations quote the very
 * shapes the rules below forbid — so a scan over the raw text reports a comment
 * ABOUT a circle as a circle. Comments are stripped once, here, and every rule
 * reads the code.
 */
function codeLines(source: string): readonly string[] {
  return source.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

/** `--name:` at the start of a declaration, which is where tokens are defined. */
function declaredTokens(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gim), (m) => m[2]));
}

/** `var(--name)` — the uses. A fallback (`var(--a, red)`) is deliberate and skipped. */
function usedTokens(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi), (m) => m[1].toLowerCase()),
  );
}

describe("the connect screen borrows the cabinet's tokens", () => {
  const declared = declaredTokens(read("src/index.css"));

  it("declares every token it reads", () => {
    // Anti-emptiness anchor: a regex that matched nothing would agree with any
    // stylesheet, including an empty one.
    expect(declared.size).toBeGreaterThan(20);

    for (const screen of SCREENS) {
      const used = usedTokens(read(screen));
      expect(used.size).toBeGreaterThan(0);

      const missing = [...used].filter((token) => !declared.has(token));
      expect(missing, `${screen} reads tokens that index.css does not declare`).toEqual([]);
    }
  });

  it("takes every corner from the theme, and only two of them", () => {
    // Reported from a phone, twice.
    //
    // FIRST: the fact tiles at the top and the workspace under them had
    // different corners. Both are cards, and the operator sets ONE rounding in
    // the cabinet's appearance settings — but the little boxes inside the tiles
    // carried the artboard's own numbers (a 10px icon box, a 4px mark plate),
    // so the theme stopped applying halfway down the screen.
    //
    // THEN: the step buttons and the platform control were drawn at
    // `--radius-pill`, which is 9999px. On a concept with a 15px card that is a
    // row of lozenges inside square-ish cards — "нарушают тему" — and the page
    // this screen replaces has one radius on every surface, chip and button.
    // So the screen reads exactly two corner tokens: the card, and everything
    // inside it. The app chips are the reference for the second one.
    //
    // Every corner NAMES one of the two tokens and carries no length of its
    // own. A percentage is allowed alongside — `min(var(--radius-item),35%)` is
    // how a 24px icon box keeps a corner instead of collapsing into a circle,
    // and it still moves with the theme everywhere the theme's own number is
    // the smaller of the two. A `px` or `rem` in here would not.
    for (const screen of SCREENS) {
      const corners = Array.from(
        codeLines(read(screen)).join(" ").matchAll(/rounded-\[([^\]]+)\]/g),
        (m) => m[1],
      ).filter(
        (value) =>
          !/var\(--radius-(card|item)\)/.test(value) || /[\d.](px|rem|em)/.test(value),
      );
      expect(corners, `${screen} pins a corner the theme cannot move`).toEqual([]);
    }
  });

  it("rounds nothing by decree except the recommendation dot", () => {
    // `rounded-full` ignores the theme outright. It was on the header actions,
    // the step rings and the fact tiles' icon boxes, and against artboards that
    // draw those as rounded squares they read as belonging to another design —
    // "не попадают по стилю закругления как на концепте".
    //
    // The dot keeps it: it is a 6px mark with nothing inside it, so "round" is
    // what it IS rather than a radius somebody chose.
    for (const screen of SCREENS) {
      const circles = codeLines(read(screen))
        .filter((line) => line.includes("rounded-full"))
        .map((line) => line.trim());
      const allowed = circles.filter((line) => line.includes("size-[6px]"));
      expect(
        circles.filter((line) => !allowed.includes(line)),
        `${screen} rounds something the theme cannot reshape`,
      ).toEqual([]);
    }
  });

  it("declares no pill token it no longer draws", () => {
    // The mirror of the rule above, on the whitelist: `connect-theme.ts` says
    // which properties the panel may set for this screen, and a name the
    // composition never reads is a setting an operator would change and see
    // nothing happen — with no way to tell that from the feature being broken.
    const whitelist = read("src/features/connect/connect-theme.ts");
    const listed = /CONNECT_THEME_LENGTH_TOKENS = \[([\s\S]*?)\]/.exec(whitelist)?.[1] ?? "";
    const names = Array.from(listed.matchAll(/'([a-z0-9-]+)'/g), (m) => m[1]);
    expect(names.length, "the whitelist was not found").toBeGreaterThan(0);
    // The screen as a whole, not each file: the picker and the link sheet are
    // handed the raised and sunken surfaces as class strings, so they read some
    // of these tokens through a neighbour rather than by name.
    const drawn = SCREENS.map(read).join(" ");
    const unread = names.filter((name) => !drawn.includes(`var(--${name})`));
    expect(unread, "the panel may set a property nothing on this screen draws").toEqual([]);
  });

  it("hardcodes no colour of its own", () => {
    // A literal hex is a colour that survives one theme and breaks in the other
    // — and this screen is shown under every one of the appearance concepts.
    for (const screen of SCREENS) {
      const source = read(screen);
      const literals = Array.from(source.matchAll(/#[0-9a-f]{3,8}\b/gi), (m) => m[0]);
      expect(literals, `${screen} paints with a literal colour`).toEqual([]);
    }
  });
});

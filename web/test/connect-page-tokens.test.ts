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
] as const;

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

  it("hardcodes no corner of its own", () => {
    // Reported from a phone: the fact tiles at the top and the workspace under
    // them had different corners. Both are cards, and the operator sets ONE
    // rounding in the cabinet's appearance settings — but the little boxes
    // inside the tiles carried the artboard's own numbers (a 10px icon box, a
    // 4px mark plate), so the theme stopped applying halfway down the screen.
    //
    // `rounded-full` is deliberately allowed: a circle is a shape, not a
    // radius, and the step rings and round header actions are circles in every
    // one of the 104 concepts.
    for (const screen of SCREENS) {
      const literals = Array.from(
        read(screen).matchAll(/rounded-\[([^\]]+)\]/g),
        (m) => m[1],
      ).filter((value) => !value.startsWith("var(--radius"));
      expect(literals, `${screen} pins a corner the theme cannot move`).toEqual([]);
    }
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

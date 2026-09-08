import { describe, expect, it } from "vitest";

import {
  connectThemeStyle,
  isSafeBackgroundImage,
  readConnectTheme,
  themeColorScheme,
} from "../src/features/connect/connect-theme";

/**
 * The appearance the panel sends for the connect screen.
 *
 * WHAT IS AT STAKE. These values are written into `style` on a live element, so
 * this module is a CSS injection surface and the checks below are the only
 * thing standing on it. "It comes from our own generator" is not a defence and
 * has already been wrong once in this codebase: the panel's icon editor carried
 * a comment saying the markup came from the server while the code read
 * `draft ?? data.config`, and that was an XSS.
 *
 * The other half is degradation. The panel ships ahead of the cabinet, so a
 * value this build does not understand is a NORMAL event, not corruption. Every
 * rejection below must leave the screen rendering on the cabinet's own tokens —
 * never blank, never half-painted.
 */

/** A real background from the panel's concept generator (Midnight Coral Mesh). */
const REAL_BACKGROUND =
  "radial-gradient(circle at 12% 14%, rgba(255,107,122,0.72) 0%, transparent 42%), " +
  "radial-gradient(circle at 86% 12%, rgba(123,140,255,0.58) 0%, transparent 44%), " +
  "linear-gradient(145deg, #05070D 0%, #15102A 40%, #5C2038 72%, #0B0610 100%)";

const REAL_THEME = {
  presetId: "concept-ba",
  tokens: {
    "brand-primary": "#FF6B7A",
    "brand-primary-fg": "#19070B",
    "brand-foreground": "#FFF4F6",
    "brand-muted-foreground": "#B9A1AA",
    "color-surface": "#0D0B17D1",
    "color-surface-high": "#151224D9",
    "color-border-soft": "#FF8AA83D",
    "radius-card": "22px",
    "glass-blur": "26px",
  },
  backgroundColor: "#05070D",
  backgroundImage: REAL_BACKGROUND,
  rail: "#FF6B7A",
};

describe("a concept the panel actually sends", () => {
  it("arrives intact", () => {
    const theme = readConnectTheme(REAL_THEME);
    expect(theme).not.toBeNull();
    expect(theme?.tokens["brand-primary"]).toBe("#FF6B7A");
    expect(theme?.tokens["color-surface"]).toBe("#0D0B17D1");
    expect(theme?.tokens["radius-card"]).toBe("22px");
    expect(theme?.backgroundImage).toBe(REAL_BACKGROUND);
    expect(theme?.rail).toBe("#FF6B7A");
  });

  it("becomes the cabinet's own custom properties, not a second vocabulary", () => {
    // The composition is written against the cabinet's tokens, which is what
    // makes "no theme" already correct. A theme that invented its own names
    // would need the screen to read both, and the screen would then have two
    // ways to be wrong.
    const style = connectThemeStyle(readConnectTheme(REAL_THEME)) as Record<string, string>;
    expect(style["--brand-primary"]).toBe("#FF6B7A");
    expect(style["--color-border-soft"]).toBe("#FF8AA83D");
    expect(style.backgroundImage).toBe(REAL_BACKGROUND);
  });

  it("keeps the rail out of the custom properties", () => {
    // `connect-page-tokens.test.ts` requires a declared default in index.css
    // for every property the screen reads, and it is right to: a property whose
    // only value is the inline one paints nothing the moment that style is
    // gone. The rail has no cabinet-wide meaning, so it never becomes one.
    const style = connectThemeStyle(readConnectTheme(REAL_THEME)) as Record<string, string>;
    expect(Object.keys(style).filter((key) => key.startsWith("--"))).not.toContain("--connect-rail");
  });
});

describe("no theme at all, which is what every deployment starts with", () => {
  it("answers null rather than an empty theme", () => {
    for (const value of [undefined, null, "", 0, [], {}, { tokens: {} }]) {
      expect(readConnectTheme(value), JSON.stringify(value) ?? "undefined").toBeNull();
    }
  });

  it("produces no style, so the screen keeps the cabinet's appearance", () => {
    expect(connectThemeStyle(null)).toEqual({});
  });

  it("answers null when every value was rejected", () => {
    // Not the same as "nothing arrived", and it matters: a theme reported as
    // present with no palette in it would paint a concept background under the
    // cabinet's own text colours, which is the one combination nobody designed.
    expect(
      readConnectTheme({
        tokens: { "brand-primary": "javascript:alert(1)" },
        backgroundImage: "url(https://tracker.example/pixel.png)",
        rail: "expression(alert(1))",
      }),
    ).toBeNull();
  });
});

describe("values that must never reach a style attribute", () => {
  const hostile = [
    ["a network fetch that leaks the viewer", "url(https://tracker.example/p.png)"],
    ["the same, upper-cased", "URL(https://tracker.example/p.png)"],
    ["an image set", "image-set(url(a.png) 1x)"],
    ["a property this whitelist never approved", "var(--admin-token)"],
    ["a comment hiding the rest", "linear-gradient(0deg,#000 0%,#fff 100%)/*"],
    ["an escape", "linear-gradient(0deg,#000 0%,#fff 100%)\\75 rl(a)"],
    ["a second declaration", "linear-gradient(0deg,#000,#fff);background:url(a)"],
    ["an unbalanced call the browser would repair", "linear-gradient(0deg,#000,#fff"],
    ["a closing paren that ends the function early", "linear-gradient(0deg,#000),url(a.png"],
    ["no gradient at all", "#ff0000"],
    ["an unknown function", "paint(worklet)"],
    ["an element reference", "element(#admin)"],

    // ── Cases that ONLY the function whitelist can refuse ────────────────────
    //
    // Everything above is caught by the character check first, which made that
    // whitelist dead code no test had ever executed — found by mutating it away
    // and watching the suite stay green. A relative `url()` is the shape that
    // gets through: no colon, no slash, nothing the character check objects to,
    // and a real gradient beside it so the "must contain a gradient" rule is
    // satisfied too. It still reaches the network, and it still tells whoever
    // serves it that this customer opened this screen.
    ["a relative url layered on a real gradient", "linear-gradient(0deg,#000,#fff), url(a.png)"],
    ["an image set layered on a real gradient", "linear-gradient(0deg,#000,#fff), image-set(a.png 1x)"],
    ["a paint worklet layered on a real gradient", "linear-gradient(0deg,#000,#fff), paint(w)"],
    ["an env lookup layered on a real gradient", "linear-gradient(0deg,#000,#fff), env(x)"],
    ["a counter layered on a real gradient", "linear-gradient(0deg,#000,#fff), counter(c)"],
  ] as const;

  for (const [what, value] of hostile) {
    it(`refuses ${what}`, () => {
      expect(isSafeBackgroundImage(value), value).toBe(false);
      const theme = readConnectTheme({ ...REAL_THEME, backgroundImage: value });
      // The rest of the theme still applies: one bad value costs that value,
      // not the operator's whole concept.
      expect(theme?.backgroundImage).toBeNull();
      expect(theme?.tokens["brand-primary"]).toBe("#FF6B7A");
    });
  }

  it("refuses a background too large to be one", () => {
    const huge = `linear-gradient(0deg, ${"#000000 0%, ".repeat(400)}#ffffff 100%)`;
    expect(huge.length).toBeGreaterThan(4_000);
    expect(isSafeBackgroundImage(huge)).toBe(false);
  });

  it("accepts every gradient form the generator emits", () => {
    for (const value of [
      "linear-gradient(145deg, #05070D 0%, #0B0610 100%)",
      "radial-gradient(circle at 12% 14%, rgba(255,107,122,0.72) 0%, transparent 42%)",
      "conic-gradient(from 90deg, #000 0%, #fff 100%)",
      "repeating-linear-gradient(45deg, #000 0px, #000 2px, #fff 2px, #fff 4px)",
      REAL_BACKGROUND,
    ]) {
      expect(isSafeBackgroundImage(value), value).toBe(true);
    }
  });
});

describe("token values", () => {
  it("keeps colours in every form the panel writes", () => {
    for (const colour of ["#fff", "#ffff", "#FF6B7A", "#151224D9", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "hsl(210 40% 50%)", "transparent"]) {
      const theme = readConnectTheme({ tokens: { "brand-primary": colour } });
      expect(theme?.tokens["brand-primary"], colour).toBe(colour);
    }
  });

  it("drops a colour that is not one", () => {
    for (const bad of ["red", "#gggggg", "rgb(1,2,3);color:red", "var(--x)", "", " ", "#", 42, null]) {
      const theme = readConnectTheme({ tokens: { "brand-primary": bad }, rail: "#000" });
      expect(theme?.tokens["brand-primary"], JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("keeps lengths and drops everything shaped like one but not", () => {
    expect(readConnectTheme({ tokens: { "radius-card": "22px" } })?.tokens["radius-card"]).toBe("22px");
    expect(readConnectTheme({ tokens: { "glass-blur": "1.5rem" } })?.tokens["glass-blur"]).toBe("1.5rem");
    for (const bad of ["22", "22pt", "calc(1px + 1px)", "-4px", "22px;x:y"]) {
      const theme = readConnectTheme({ tokens: { "radius-card": bad }, rail: "#000" });
      expect(theme?.tokens["radius-card"], bad).toBeUndefined();
    }
  });

  it("emits only names the composition reads", () => {
    // An unknown name is not harmless: it is a property the screen never reads,
    // so an operator would see their choice do nothing and have no way to tell
    // that from the feature being broken.
    const theme = readConnectTheme({
      tokens: { "brand-primary": "#FF6B7A", "sidebar-accent": "#000000", "--escaped": "#000000" },
    });
    const style = connectThemeStyle(theme) as Record<string, string>;
    const custom = Object.keys(style).filter((key) => key.startsWith("--"));
    expect(custom).toEqual(["--brand-primary"]);
  });

  it("declares the real properties the tokens exist to feed, and no others", () => {
    // Written as an allow-list rather than an exact key list because the exact
    // version failed for the wrong reason the day `color` was added — and
    // `color` had to be added: without it the concept's foreground token is
    // inert, since the cabinet's `color` is computed on an ancestor.
    //
    // What this still refuses is a stray property nobody declared on purpose.
    const style = connectThemeStyle(readConnectTheme(REAL_THEME)) as Record<string, string>;
    const plain = Object.keys(style).filter((key) => !key.startsWith("--")).sort();
    expect(plain).toEqual(["backgroundColor", "backgroundImage", "color", "colorScheme"]);
    // And `color` reads the token rather than pinning a literal, so a theme
    // that omits the foreground still inherits the cabinet's.
    expect(style.color).toBe("var(--brand-foreground)");
  });

  it("does not let a colour token carry a length, or the reverse", () => {
    const theme = readConnectTheme({
      tokens: { "brand-primary": "22px", "radius-card": "#FF6B7A" },
      rail: "#000000",
    });
    expect(theme?.tokens["brand-primary"]).toBeUndefined();
    expect(theme?.tokens["radius-card"]).toBeUndefined();
  });
});

describe("which way the browser should draw its own controls", () => {
  /**
   * The platform picker's open list belongs to the operating system, and with
   * no `color-scheme` declared anywhere the browser assumes light — so on the
   * dark cabinet it opened as a white sheet with black text. Reported exactly
   * that way.
   *
   * `color-scheme: dark` would fix that screenshot and break the 44 concepts of
   * 104 that are light-backgrounded, so the answer is read off the concept's
   * own ground rather than fixed.
   */
  it("reads dark off a dark ground", () => {
    expect(themeColorScheme(readConnectTheme(REAL_THEME))).toBe("dark");
  });

  it("reads light off a light ground", () => {
    // Alpine Moss Glass, the light half of the book.
    expect(
      themeColorScheme(readConnectTheme({ ...REAL_THEME, backgroundColor: "#EDF2E7" })),
    ).toBe("light");
  });

  it("falls back to the raised surface when there is no ground colour", () => {
    const theme = readConnectTheme({
      tokens: { "color-surface-high": "#F9FBF1" },
      backgroundImage: REAL_BACKGROUND,
    });
    expect(themeColorScheme(theme)).toBe("light");
  });

  it("says nothing when the theme says nothing", () => {
    // Not a guess: with no concept the cabinet's own mode is the right answer,
    // and only the caller knows it.
    expect(themeColorScheme(null)).toBeNull();
    expect(themeColorScheme(readConnectTheme({ tokens: { "brand-primary": "#FF6B7A" } }))).toBeNull();
  });

  it("says nothing for a ground it cannot read", () => {
    // `rgba()` and `hsl()` pass the colour grammar but are not hex; guessing at
    // them would be worse than deferring to the cabinet.
    expect(
      themeColorScheme(readConnectTheme({ ...REAL_THEME, backgroundColor: "rgba(1,2,3,0.5)" })),
    ).toBeNull();
  });
});

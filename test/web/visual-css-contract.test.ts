import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const WEB_SRC = new URL("../../web/src/", import.meta.url);

/** Every `.tsx` under `web/src`, as `[relative path, source]`. */
function readWebSources(): Array<readonly [string, string]> {
  return readdirSync(WEB_SRC, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx"))
    .map(
      (entry) =>
        [
          entry.replaceAll("\\", "/"),
          readFileSync(new URL(entry.replaceAll("\\", "/"), WEB_SRC), "utf8"),
        ] as const,
    );
}

const INDEX_CSS = readFileSync(
  new URL("../../web/src/index.css", import.meta.url),
  "utf8",
);
const EFFECT_LAYER_SOURCE = readFileSync(
  new URL(
    "../../web/src/components/reactbits/card-effect-layer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const EFFECT_LAYER_UTILS_SOURCE = readFileSync(
  new URL(
    "../../web/src/components/reactbits/card-effect-layer-utils.ts",
    import.meta.url,
  ),
  "utf8",
);
const CARD_FRAME_SOURCE = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-card-frame.tsx",
    import.meta.url,
  ),
  "utf8",
);
const CARD_CONTENT_SOURCE = readFileSync(
  new URL(
    "../../web/src/features/dashboard/components/subscription-card.tsx",
    import.meta.url,
  ),
  "utf8",
);
const STADIUM_BUTTON_SOURCE = readFileSync(
  new URL("../../web/src/components/ui/stadium-button.tsx", import.meta.url),
  "utf8",
);

/**
 * The body of `selector { … }`, brace-balanced so at-rules read whole, and
 * ASSERTED UNIQUE.
 *
 * Both properties are load-bearing. This used to stop at the first `}`, which
 * meant `cssBlock("@media (prefers-reduced-motion: reduce)")` returned only the
 * first nested rule — fine while there was one, silently wrong the moment a
 * second was added. And it took the FIRST match: adding a second block with the
 * same selector further down (which is how a CSS override is normally written)
 * left every assertion reading the old one. Both are now failures, not
 * surprises.
 */
function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`${escaped}\\s*\\{`, "g");
  const starts = Array.from(INDEX_CSS.matchAll(opener), (match) => match.index ?? -1);
  expect(starts.length, `missing CSS block for ${selector}`).toBeGreaterThan(0);
  expect(
    starts.length,
    `index.css declares \`${selector}\` ${starts.length} times — this helper reads one block, so every assertion about it would silently describe whichever copy came first`,
  ).toBe(1);

  const open = INDEX_CSS.indexOf("{", starts[0]);
  let depth = 0;
  let index = open;
  for (; index < INDEX_CSS.length; index += 1) {
    const character = INDEX_CSS[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return INDEX_CSS.slice(open + 1, index);
}

/** One `selectors { declarations }` pair out of a (flat) block of CSS. */
interface CssRule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/**
 * The rules inside a block, so an assertion can be tied to the declaration it
 * is actually about.
 *
 * A substring check against the whole block proves nothing: an audit mutated
 * the 16px clamp by adding a decoy rule carrying `font-size: 1rem;` and
 * setting the real inputs back to `0.875rem`, and three `toContain` checks —
 * for the two selectors and for the size — all still passed, because none of
 * them was tied to the others.
 */
function rulesIn(block: string): CssRule[] {
  const rules: CssRule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(block); match !== null; match = pattern.exec(block)) {
    rules.push({
      selectors: match[1]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      body: match[2],
    });
  }
  return rules;
}

describe("animated card CSS opacity contract", () => {
  it("keeps the selected effect as alpha artwork over the theme foundation", () => {
    const fallback = cssBlock(".card-effect-layer__css-fallback");
    const opacityDeclarations =
      fallback.match(/\bopacity\s*:\s*[^;]+;/g) ?? [];

    expect(opacityDeclarations).toEqual(["opacity: 1;"]);
    expect(EFFECT_LAYER_SOURCE).toContain("runtime?.mode === \"css-fallback\"");
    expect(EFFECT_LAYER_SOURCE).toContain(
      "data-card-effect-palette-surface",
    );
    expect(EFFECT_LAYER_SOURCE).toContain("data-card-effect-artwork");
    expect(EFFECT_LAYER_SOURCE).not.toContain("backgroundColor: first");
    expect(EFFECT_LAYER_SOURCE).toContain("opacity: configuredOpacity,");
    expect(EFFECT_LAYER_SOURCE).not.toContain("mixBlendMode");
    expect(EFFECT_LAYER_SOURCE).not.toContain(
      "linear-gradient(135deg, ${first}, ${middle}, ${last})",
    );
    expect(EFFECT_LAYER_SOURCE).toContain(
      "const configuredOpacity = resolveCardEffectOverlayOpacity(opacity)",
    );
    expect(EFFECT_LAYER_UTILS_SOURCE).toContain(
      "return Math.min(Math.max(opacity, 0.05), 1)",
    );
    expect(EFFECT_LAYER_SOURCE).not.toContain("CARD_EFFECT_MAX_OVERLAY_OPACITY");
    expect(EFFECT_LAYER_SOURCE).not.toContain('isolation: "isolate"');
    expect(EFFECT_LAYER_SOURCE).not.toContain('contain: "paint"');
    expect(EFFECT_LAYER_SOURCE).toContain('overflow: "hidden"');
    expect(EFFECT_LAYER_SOURCE).toContain(
      "const shouldAnimate = shouldMount",
    );
    expect(EFFECT_LAYER_SOURCE).not.toContain("prefersReducedMotion");
    // The wrapper settles at exactly 1 and never at a value of its own.
    //
    // This used to read `opacity: 1,` — a hard constant — for a good reason:
    // the operator's `cardEffectOpacity` is the ONLY opacity decision on this
    // layer, and a second one here would quietly cap it. The wrapper now
    // carries a reveal transition, so the rule has to be stated as "it ends at
    // 1" rather than "it is literally 1". What must not come back is a second
    // ceiling: any resting value below 1 would multiply against the operator's
    // choice and a saved 100% would stop being 100%.
    expect(EFFECT_LAYER_SOURCE).toContain("opacity: revealed ? 1 : 0,");
    expect(EFFECT_LAYER_SOURCE).not.toMatch(/opacity: revealed \? 0?\.\d+/);
    // The reveal is a transition, not the old always-on fade that used to run
    // on every render regardless of whether anything had painted.
    expect(EFFECT_LAYER_SOURCE).not.toContain('transition: "opacity 450ms ease"');
    expect(EFFECT_LAYER_SOURCE).toContain("CARD_EFFECT_REVEAL_MS");
  });
});

/** The brace-balanced body of `@keyframes <name>`, matched by name. */
function keyframesBody(name: string): string {
  const start = INDEX_CSS.indexOf(`@keyframes ${name} `);
  expect(start, `missing @keyframes ${name}`).toBeGreaterThanOrEqual(0);
  const open = INDEX_CSS.indexOf("{", start);
  let depth = 0;
  let index = open;
  for (; index < INDEX_CSS.length; index += 1) {
    const character = INDEX_CSS[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return INDEX_CSS.slice(open + 1, index);
}

/**
 * Properties a browser cannot animate on the compositor: changing one forces a
 * repaint (and for `filter`, a re-rasterisation) of the animated element on
 * EVERY frame, for as long as the animation runs. `transform` and `opacity`
 * are the only two that stay on the compositor thread.
 */
const PAINT_BOUND_PROPERTIES = [
  "box-shadow",
  "background-position",
  "background-size",
  "background-image",
  "background-color",
  "filter",
  "backdrop-filter",
  "width",
  "height",
];

/**
 * `property:` anywhere in a declaration position, INCLUDING its vendor-prefixed
 * spellings.
 *
 * The prefix group is the whole point. This used to be
 * `(^|[;{\s])${property}\s*:`, and `-` is in none of those classes — so a
 * keyframe animating `-webkit-filter: blur(…)` matched nothing and passed. An
 * audit proved it: that is the spelling iOS actually honours for
 * `backdrop-filter`, so the one platform this contract exists to protect was
 * the one platform it could not see.
 */
function declarationPattern(property: string): RegExp {
  return new RegExp(`(^|[;{\\s])(-(?:webkit|moz|ms|o)-)?${property}\\s*:`);
}

const INDEX_CSS_KEYFRAMES = [
  "pulse-glow",
  "fade-up",
  "spin-slow",
  "card-effect-fallback-drift-a",
  "card-effect-fallback-drift-b",
  "card-effect-fallback-drift-c",
  "glint",
  // Operator-chosen attention effects for the dashboard header icons. All
  // three are on this list for the same reason as their neighbours: the loop
  // below is what proves they animate `transform`/`opacity` and nothing that
  // costs a repaint.
  "icon-effect-pulse",
  "icon-effect-shake",
  "icon-effect-glow",
  // The glint sweeps a highlight and the iridescence cross-fades two
  // pre-painted gradients. Neither may reach for `filter: hue-rotate` or an
  // animated `background-image`, which are the two obvious ways to move colour
  // and are both on the forbidden list below.
  "icon-effect-glint",
  "icon-effect-iridescent-a",
  "icon-effect-iridescent-b",
];

describe("animation paint contract", () => {
  it("declares every index.css keyframe in transform/opacity only", () => {
    // Guards the whole set, not just today's two offenders: the next hand-
    // written keyframe gets the same answer without anyone remembering to
    // extend this list of names.
    const declared = Array.from(
      INDEX_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{/g),
      (match) => match[1],
    );
    expect(
      declared.slice().sort(),
      "a keyframe was added to or removed from index.css — add it to INDEX_CSS_KEYFRAMES so its properties are checked",
    ).toEqual(INDEX_CSS_KEYFRAMES.slice().sort());

    for (const name of INDEX_CSS_KEYFRAMES) {
      const body = keyframesBody(name);
      for (const property of PAINT_BOUND_PROPERTIES) {
        expect(
          body,
          `@keyframes ${name} animates \`${property}\` (or a vendor-prefixed spelling of it) — a paint-bound property, so every frame repaints the element. Express the motion with transform/opacity instead (see landing.css \`ls-gradient\`).`,
        ).not.toMatch(declarationPattern(property));
      }
    }
  });

  // The scan above is only as good as its matcher, and the matcher is a regex
  // built at runtime that nothing else exercises. Pin both halves.
  it("matches a paint-bound declaration in every spelling that ships", () => {
    for (const [property, declaration] of [
      ["filter", "0% { -webkit-filter: blur(2px); }"],
      ["backdrop-filter", "50% { -webkit-backdrop-filter: blur(8px); }"],
      ["filter", "0% { filter: blur(2px); }"],
      ["box-shadow", "0%{box-shadow:0 0 4px red;}"],
      ["background-position", "to { transform: none; background-position: 0 0; }"],
    ] as const) {
      expect(
        declarationPattern(property).test(declaration),
        `the paint-property matcher no longer sees \`${declaration.trim()}\`, so the keyframe scan above is blind to it`,
      ).toBe(true);
    }
    for (const [property, declaration] of [
      // `backdrop-filter` must not be read as a `filter` declaration…
      ["filter", "0% { backdrop-filter: blur(2px); }"],
      // …and a longhand that merely ends in the property name is not it either.
      ["height", "0% { line-height: 2; }"],
      ["width", "0% { border-width: 2px; }"],
    ] as const) {
      expect(
        declarationPattern(property).test(declaration),
        `the paint-property matcher false-positives on \`${declaration.trim()}\` for \`${property}\``,
      ).toBe(false);
    }
  });

  it("breathes the CTA halo as a pre-painted pseudo-element, keeping the resting glow", () => {
    expect(keyframesBody("pulse-glow")).toContain("opacity:");

    const halo = cssBlock(".animate-pulse-glow::after");
    expect(
      halo,
      "the pulse halo lost its static box-shadow — the peak glow must be painted once, not animated",
    ).toContain("box-shadow:");
    expect(halo).toContain("animation: pulse-glow");
    expect(
      halo,
      "the halo pseudo-element must never swallow clicks on the CTA it decorates",
    ).toContain("pointer-events: none;");
    expect(cssBlock(".animate-pulse-glow")).toContain("position: relative;");

    // The animation no longer supplies a resting glow (its 0%/100% is now
    // opacity 0), so the primary variant's own static shadow IS the rest
    // state. Lose it and the glowing CTA reads flat between pulses.
    expect(
      STADIUM_BUTTON_SOURCE,
      "the primary variant lost its static 24px glow, which is now the pulse's rest state",
    ).toContain("shadow-[0_0_24px_var(--color-brand-glow)]");
  });

  it("drifts the WebGL fallback with transforms on oversized blobs", () => {
    // This is the iOS-without-WebGL path — the devices least able to afford an
    // 18s infinite repaint are exactly the ones that land here.
    expect(
      INDEX_CSS,
      "the single background-position drift keyframe is back; the fallback must move three oversized blob layers by transform instead",
    ).not.toMatch(/@keyframes\s+card-effect-fallback-drift\s*\{/);

    for (const suffix of ["a", "b", "c"]) {
      expect(keyframesBody(`card-effect-fallback-drift-${suffix}`)).toContain(
        "translate3d",
      );
      const blob = cssBlock(`.card-effect-layer__css-fallback-blob--${suffix}`);
      expect(blob).toContain(
        `animation-name: card-effect-fallback-drift-${suffix};`,
      );
    }

    const wrapper = cssBlock(".card-effect-layer__css-fallback");
    expect(
      wrapper,
      "the fallback wrapper animates again — the motion belongs to its blob children",
    ).not.toContain("animation");
    expect(wrapper).toContain("overflow: hidden;");

    // Reduced motion still stops the drift; it now has to reach the blobs.
    expect(
      cssBlock("@media (prefers-reduced-motion: reduce)"),
      "prefers-reduced-motion no longer switches the fallback drift off",
    ).toContain(".card-effect-layer__css-fallback-blob { animation: none;");
  });

/**
 * Animated selectors the reduced-motion block does not name, and why.
 *
 * ONE of these is exempt for a good reason. The other three are simply older
 * than the guard below, and they are listed rather than fixed because switching
 * an animation off changes what a subscriber sees — a call somebody who owns
 * the product should make deliberately, not something to slip into a patch
 * about icon effects. Listing them is the point: they are now visible, and
 * anything NEW that joins them fails instead.
 */
/** CSS with `/* … *\/` comments removed, so a commented rule cannot satisfy a substring test. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

const EXEMPT_FROM_REDUCED_MOTION = new Map([
  [
    ".animate-glint",
    "gated in JavaScript instead: `quests-icon` does not render the sweep at all when `useReducedMotion()` is true, so there is nothing for CSS to switch off",
  ],
  [
    ".animate-pulse-glow::after",
    "PRE-EXISTING GAP. The CTA halo breathes for as long as the screen is open and Reduce Motion does not stop it. It is only an opacity animation, so it costs nothing to run — but it is motion, and the setting asks for none",
  ],
  [
    ".animate-fade-up",
    "PRE-EXISTING GAP, and the mildest: a 0.4s one-shot entrance that ends and stays ended. Reduce Motion arguably still wants it gone",
  ],
  [
    ".animate-spin-slow",
    "PRE-EXISTING GAP. An 8s continuous rotation, which is the shape of animation the setting most clearly means",
  ],
]);

  it("switches every animated selector off under reduced motion", () => {
    // The companion to the ordering test below, and the half it was missing.
    // That one proves the block can WIN; this one proves it says anything at
    // all about each rule. A newly added animation that nobody remembers to
    // list simply runs — the block is still correctly placed, still overrides
    // everything it names, and names one fewer thing than it should.
    //
    // Caught by mutation: deleting `.icon-effect-glint::after` from the block
    // left every assertion in this file green while a subscriber who asked for
    // no motion kept a highlight sweeping across their header.
    // Comments stripped FIRST. `guard.includes(selector)` is a substring test,
    // so commenting a rule out satisfies it — which is the same defect this
    // check was written after, expressed with `/*` instead of a delete.
    const source = stripComments(INDEX_CSS);
    // And the whole file, not the part above `@layer base`. A rule appended
    // after that block is unlayered and later in source order, so it beats the
    // guard outright — slicing there made exactly the winning case invisible.
    const guard = stripComments(cssBlock("@media (prefers-reduced-motion: reduce)"));
    const beforeGuard = source.slice(
      0,
      source.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    const afterGuard = source.slice(
      source.indexOf("@media (prefers-reduced-motion: reduce)"),
    );

    // The selector each animation is attached to: the last selector line above
    // the declaration. Comma-separated groups count as one, which is how they
    // are written in the guard too.
    const NEEDLE = "animation:";
    const selectors = new Set<string>();
    for (let at = beforeGuard.indexOf(NEEDLE); at !== -1; at = beforeGuard.indexOf(NEEDLE, at + 1)) {
      const semicolon = beforeGuard.indexOf(";", at);
      const value = beforeGuard.slice(at + NEEDLE.length, semicolon === -1 ? undefined : semicolon);
      if (value.trim().startsWith("none")) continue;
      const openBrace = beforeGuard.lastIndexOf("{", at);
      if (openBrace === -1) continue;
      const head = beforeGuard.slice(0, openBrace);
      // Keyframe steps also carry declarations; their opening brace is inside
      // an `@keyframes` block and their "selector" is a percentage.
      const selector = head.slice(head.lastIndexOf("}") + 1).trim().split(String.fromCharCode(10)).pop() ?? "";
      if (selector.length === 0 || selector.startsWith("@") || /^[\d%,\s]+$/.test(selector)) continue;
      for (const one of selector.split(",")) {
        const name = one.trim();
        if (name.startsWith(".")) selectors.add(name);
      }
    }

    expect(
      selectors.size,
      "no animated selectors found — the scan stopped matching, so this guard is asserting nothing",
    ).toBeGreaterThan(3);

    // Anything animated AFTER the guard is unguarded whatever the block says,
    // because at equal specificity the later rule wins.
    for (let at = afterGuard.indexOf(NEEDLE); at !== -1; at = afterGuard.indexOf(NEEDLE, at + 1)) {
      const semicolon = afterGuard.indexOf(";", at);
      const value = afterGuard.slice(at + NEEDLE.length, semicolon === -1 ? undefined : semicolon);
      if (value.trim().startsWith("none")) continue;
      // The guard block itself is part of this slice; its own rules all say
      // `none`, so anything else here is a rule declared below it.
      const inGuard = at < guard.length + 200;
      expect(
        inGuard,
        "an animation is declared after the reduced-motion block, so it beats it at equal specificity",
      ).toBe(true);
    }

    const unguarded = [...selectors].filter(
      (selector) => !guard.includes(selector) && !EXEMPT_FROM_REDUCED_MOTION.has(selector),
    );
    expect(
      unguarded,
      "these selectors start an animation that the reduced-motion block never switches off, so Reduce Motion does nothing for them — switch them off in that block, or add them to EXEMPT_FROM_REDUCED_MOTION with the reason",
    ).toEqual([]);
  });

  it("keeps the reduced-motion exemptions honest", () => {
    // An exemption for a selector that no longer animates is a note about
    // nothing, and it would go on excusing whatever later took the name.
    const layerBase = INDEX_CSS.indexOf("@layer base {");
    const unlayered = layerBase >= 0 ? INDEX_CSS.slice(0, layerBase) : INDEX_CSS;
    const stale = [...EXEMPT_FROM_REDUCED_MOTION.keys()].filter(
      (selector) => !unlayered.includes(selector),
    );
    expect(
      stale,
      "these selectors are excused from the reduced-motion block but no longer exist in index.css",
    ).toEqual([]);
  });

  it("puts the reduced-motion block below every animated rule it must beat", () => {
    // The one assertion that would have caught the real defect. Every
    // declaration in that block carries the SAME specificity as the rule it
    // overrides, so the cascade falls back to source order — and the block
    // sat above `.icon-effect-pulse`, `.icon-effect-shake` and
    // `.icon-effect-glow::after`. Each `animation: none` was dead, and a
    // subscriber who asked their system for no motion got a pulsing header
    // anyway. Counting blocks and reading keyframe bodies both stayed green.
    //
    // `@layer base` is exempt on purpose: layered rules always lose to
    // unlayered ones whatever their position.
    // The opening brace matters: `@layer base` also appears in prose above.
    const layerBase = INDEX_CSS.indexOf("@layer base {");
    const unlayered = layerBase >= 0 ? INDEX_CSS.slice(0, layerBase) : INDEX_CSS;
    const guardAt = unlayered.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(guardAt, "the reduced-motion block must be unlayered").toBeGreaterThan(-1);

    // Every `animation:` that actually starts one, by position. No regex:
    // the property name is enough, and "not `none`" is the whole
    // distinction that matters here.
    const NEEDLE = "animation:";
    const animated: Array<{ at: number; text: string }> = [];
    for (let at = unlayered.indexOf(NEEDLE); at !== -1; at = unlayered.indexOf(NEEDLE, at + 1)) {
      const semicolon = unlayered.indexOf(";", at);
      const value = unlayered.slice(at + NEEDLE.length, semicolon === -1 ? undefined : semicolon);
      if (value.trim().startsWith("none")) continue;
      const lineStart = unlayered.lastIndexOf(String.fromCharCode(10), at) + 1;
      animated.push({ at, text: unlayered.slice(lineStart, at + 40).trim() });
    }
    expect(
      animated.length,
      "no animated rules found — the scan stopped matching, so this guard is asserting nothing",
    ).toBeGreaterThan(0);

    const late = animated.filter((rule) => rule.at > guardAt).map((rule) => rule.text);
    expect(
      late,
      "these rules are declared AFTER the reduced-motion block, so their animations beat it at equal specificity and Reduce Motion does nothing for them",
    ).toEqual([]);
  });
});

describe("iOS input zoom contract", () => {
  it("clamps sub-16px glass fields to 16px on touch pointers", () => {
    // Below 16px iOS zooms the page on focus (still true through iOS 26), and
    // inside the dvh-locked shell that zoom never settles back cleanly.
    const coarse = cssBlock("@media (pointer: coarse)");
    const rules = rulesIn(coarse);

    for (const selector of [".glass-input.text-xs", ".glass-input.text-sm"]) {
      // Every rule that targets it, in source order — the LAST one wins at
      // equal specificity, so that is the one the browser applies.
      const matching = rules.filter((rule) => rule.selectors.includes(selector));
      expect(
        matching.length,
        `\`${selector}\` is no longer clamped inside @media (pointer: coarse) — iOS will zoom the dvh-locked shell on focus again`,
      ).toBeGreaterThan(0);

      const winner = matching[matching.length - 1];
      expect(
        winner.body,
        `the last @media (pointer: coarse) rule for \`${selector}\` does not set font-size: 1rem — anything below 16px still triggers the iOS focus zoom. (This assertion is tied to the rule on purpose: a bare "the block contains 1rem somewhere" check passed while the inputs were set back to 0.875rem.)`,
      ).toMatch(/font-size:\s*1rem\s*;/);

      // `.glass-input.text-sm`, not `.auth-screen .glass-input.text-sm`: the
      // clamp is app-wide by decision, because iOS zooms on the support form
      // and the quests dialog too. Narrowing it is a behaviour change and has
      // to be an explicit edit here, not a quiet one in a stylesheet.
      expect(
        winner.selectors.includes(selector),
        `the 16px clamp for \`${selector}\` has been scoped to an ancestor (${winner.selectors.join(", ")}) — the fields outside that scope will zoom on iOS`,
      ).toBe(true);
    }

    // Only `font-size`. Tailwind v4 expresses `text-sm`/`text-xs` leading as a
    // unitless ratio, so the line box scales with the clamp by itself; pinning
    // a line-height here would crush the multi-line fields (ai-chat, support).
    for (const rule of rules) {
      if (!rule.selectors.some((selector) => selector.startsWith(".glass-input"))) continue;
      expect(
        rule.body,
        "the clamp sets line-height as well as font-size — Tailwind v4's text-sm/text-xs leading is a unitless ratio that already scales, so a fixed value here only crowds the multi-line glass fields",
      ).not.toMatch(/(^|[;{\s])line-height\s*:/);
    }
  });

  /**
   * The clamp is app-wide, so a glass field with a HARD-CODED width has to fit
   * its content at 16px, not at the 12–14px it was designed against.
   *
   * This is not hypothetical: the quests dialog's partner-code input shipped as
   * `w-24` (96px), which at `px-2` leaves 78px of content — under 8 characters
   * of a 16px activation code, so the value scrolled inside its own box on
   * every touch device the clamp applies to.
   */
  it("leaves every fixed-width glass field wide enough for 16px text", () => {
    /** Roughly 10 characters at the ~9.6px advance of 16px uppercase sans. */
    const MIN_CONTENT_PX = 96;
    const SPACING_PX = 4; // Tailwind's --spacing default, 0.25rem
    const BORDER_PX = 2; // .glass-input is 1px all round

    const offenders: string[] = [];
    let checked = 0;
    for (const [file, source] of readWebSources()) {
      for (const classList of source.matchAll(/["'`]([^"'`\n]*\bglass-input\b[^"'`\n]*)["'`]/g)) {
        const classes = classList[1].split(/\s+/);
        if (!classes.includes("text-xs") && !classes.includes("text-sm")) continue;
        const width = classes.find((token) => /^w-\d+(\.\d+)?$/.test(token));
        if (width === undefined) continue; // w-full / flex-1 / w-[…] size themselves
        checked += 1;

        const boxPx = Number(width.slice(2)) * SPACING_PX;
        const padding = classes.find((token) => /^px-\d+(\.\d+)?$/.test(token));
        const paddingPx = padding === undefined ? 0 : Number(padding.slice(3)) * SPACING_PX * 2;
        const contentPx = boxPx - paddingPx - BORDER_PX;
        if (contentPx < MIN_CONTENT_PX) {
          offenders.push(
            `${file}: \`${width}\` + \`${padding ?? "no px-*"}\` leaves ${contentPx}px of content`,
          );
        }
      }
    }

    expect(
      checked,
      "no fixed-width glass field was inspected — the scan is broken, not the app",
    ).toBeGreaterThan(0);
    expect(
      offenders,
      `a .glass-input with a fixed width is too narrow for the 16px it is clamped to on touch devices (needs >= ${MIN_CONTENT_PX}px of content box): ${offenders.join("; ")}`,
    ).toEqual([]);
  });
});

describe("subscription card artwork contract", () => {
  it("never mutates normal artwork when the operator changes text colour", () => {
    expect(CARD_FRAME_SOURCE).not.toContain("staticArtworkVeil");
    expect(CARD_FRAME_SOURCE).not.toContain("animatedArtwork");
    // A short-lived creation reveal is allowed; it is not contrast policy.
    expect(CARD_FRAME_SOURCE).toContain("creationPresentation && (");
  });

  it("keeps the card copy free of outlines and capsules", () => {
    for (const source of [CARD_FRAME_SOURCE, CARD_CONTENT_SOURCE]) {
      expect(source).not.toContain("textShadow");
      expect(source).not.toContain("WebkitTextStroke");
      expect(source).not.toContain("paintOrder");
      expect(source).not.toContain("supportBackground");
      expect(source).not.toContain("localReadability");
    }
  });
});

describe("semantic glass contrast CSS", () => {
  it("does not compound alpha on validated secondary text tokens", () => {
    expect(cssBlock(".glass-input::placeholder")).toContain(
      "color: var(--brand-muted-foreground);",
    );
    expect(cssBlock(".theme-subtle")).toContain(
      "color: var(--brand-muted-foreground);",
    );
  });

  it("keeps keyboard focus visible on glass icon buttons", () => {
    const focus = cssBlock(".glass-icon-btn:focus-visible");

    expect(focus).toContain(
      "outline: 2px solid var(--brand-foreground);",
    );
    expect(focus).toContain("outline-offset: 2px;");
    expect(focus).toContain(
      "border-color: var(--color-border-strong);",
    );
  });
});

describe("cold concept background parity", () => {
  it("uses the bootstrap texture blend mode before React mounts", () => {
    expect(cssBlock("body")).toContain(
      "background-blend-mode: var(--bootstrap-app-background-blend, normal);",
    );
  });
});

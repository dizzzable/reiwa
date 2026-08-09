import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Entry-screen contract for iOS/WebKit.
 *
 * The entry screens (`/`, `/tma`, and the six auth forms) are the first thing
 * every subscriber sees, and they were the measurably worst frames in the app
 * on iPhone. Three separate causes, all structural rather than cosmetic, are
 * pinned here because each one is trivially re-introduced by an ordinary
 * "make the entrance nicer" edit:
 *
 *   1. Geometry motion (spring `scale`, `y`-slide) wrapped around an element
 *      that carries `backdrop-filter`. WebKit re-samples and re-blurs the
 *      backdrop on EVERY frame of that animation.
 *   2. `autoFocus` on a touch device: the iOS keyboard rises during the mount
 *      animation and the sub-16px field zooms the page on top of it.
 *   3. No inner scroll container. `html/body/#root` are `100dvh; overflow:
 *      hidden`, and the iOS keyboard shrinks only the VISUAL viewport — with
 *      nothing scrollable inside, WebKit jerks the layout viewport instead.
 *
 * These are source-text contracts (the pattern `visual-css-contract.test.ts`
 * already uses): the invariants are about which markup exists, and rendering
 * eight route components would need the whole router/query/i18n/branding stack
 * to assert less.
 */

const AUTH = new URL("../../web/src/features/auth/", import.meta.url);

/**
 * Source with block/JSX comments removed. Every rule below is about markup
 * that ships; the comments explaining these very rules name the same tokens
 * ("a y-slide re-blurs their backdrop-filter…") and would otherwise trip them.
 */
function authSource(name: string): string {
  return readFileSync(new URL(`${name}.tsx`, AUTH), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** The six screens that carry input fields and therefore raise the keyboard. */
const FORM_SCREENS = [
  "sign-in-page",
  "register-page",
  "recover-page",
  "claim-page",
  "finish-setup-page",
  "change-password-page",
];
/** The two keyboard-less splash screens. */
const SPLASH_SCREENS = ["web-home-page", "tma-bootstrap-page"];
const ENTRY_SCREENS = [...FORM_SCREENS, ...SPLASH_SCREENS];

const ENTRY_TILE_SOURCE = readFileSync(
  new URL("../../web/src/components/ui/entry-brand-tile.tsx", import.meta.url),
  "utf8",
);

/** Motion props that move or resize an element, as opposed to fading it. */
const GEOMETRY_PROPERTIES = /\b(scale|rotate|x|y)\s*:/;

/** The `initial={{ … }}` of a `<motion.*>` opening tag, plus whether it closes itself. */
function readMotionTag(source: string, start: number): {
  readonly initial: string;
  readonly selfClosing: boolean;
} {
  // Attribute values are brace-delimited, and the arrow functions inside them
  // contain `>`; only a `>` at brace depth 0 ends the tag.
  let depth = 0;
  let index = start;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth === 0) break;
  }
  const tag = source.slice(start, index);
  return {
    initial: /initial=\{\{([^}]*)\}\}/.exec(tag)?.[1] ?? "",
    selfClosing: tag.trimEnd().endsWith("/"),
  };
}

/**
 * The `initial` of every `<motion.*>` element that ENCLOSES `offset`.
 *
 * A real ancestor walk, not "the nearest one above": entry screens legitimately
 * put a spring on a sibling that has no backdrop-filter (recover-page's result
 * panel scales in), and that must not be read as governing the blurred pill
 * further down the page.
 */
function enclosingMotionInitials(source: string, offset: number): string[] {
  const stack: string[] = [];
  const token = /<motion\.\w+|<\/motion\.\w+>/g;
  for (
    let match = token.exec(source);
    match !== null && match.index < offset;
    match = token.exec(source)
  ) {
    if (match[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const tag = readMotionTag(source, match.index);
    if (!tag.selfClosing) stack.push(tag.initial);
  }
  return stack;
}

/**
 * Everything on an entry screen that carries `backdrop-filter`, and is
 * therefore ruinous to animate geometrically:
 *   - `.glass-input`     — `backdrop-filter: blur(var(--glass-blur))` (index.css)
 *   - `<EntryBrandTile>` — `backdrop-blur-xl` on the tile itself
 *   - `<GuestSupportLink>` — `backdrop-blur-xl` on the pill (sign-in, recover)
 */
const BLURRED_MARKERS = ["glass-input", "<EntryBrandTile", "<GuestSupportLink"];

describe("entry screens never animate geometry on a blurred backdrop", () => {
  it("keeps the shared brand tile opacity-only", () => {
    // `backdrop-blur-xl` lives here now, so this is the one place a spring can
    // do the damage — and the one place it has to stay out of.
    expect(ENTRY_TILE_SOURCE).toContain("backdrop-blur-xl");
    for (const prop of ["initial={{", "animate={{"]) {
      const start = ENTRY_TILE_SOURCE.indexOf(prop);
      expect(start, `EntryBrandTile lost its ${prop} entrance`).toBeGreaterThanOrEqual(0);
      const body = ENTRY_TILE_SOURCE.slice(
        start + prop.length,
        ENTRY_TILE_SOURCE.indexOf("}}", start),
      );
      expect(
        body,
        `EntryBrandTile animates geometry in ${prop} — it carries backdrop-blur-xl, so WebKit re-blurs its whole backdrop on every frame`,
      ).not.toMatch(GEOMETRY_PROPERTIES);
      expect(body).toContain("opacity");
    }
  });

  it("routes every entry screen's logo through that one tile", () => {
    // Four screens had four copies of the same tile; one of them can no longer
    // regress on its own.
    for (const screen of ["sign-in-page", "change-password-page", ...SPLASH_SCREENS]) {
      expect(
        authSource(screen),
        `${screen} builds its own brand tile again instead of using EntryBrandTile`,
      ).toContain("<EntryBrandTile");
    }
    // Visual parity with the four originals: 80px/rounded-3xl + 44px mark on
    // the form screens, 96px/28px-radius + 56px mark on the splash screens.
    expect(ENTRY_TILE_SOURCE).toContain("h-24 w-24 rounded-[28px]");
    expect(ENTRY_TILE_SOURCE).toContain("h-20 w-20 rounded-3xl");
    expect(ENTRY_TILE_SOURCE).toContain("h-14 w-14");
    expect(ENTRY_TILE_SOURCE).toContain("h-11 w-11");
  });

  it("leaves no backdrop-filter element on an entry screen outside that tile", () => {
    for (const screen of ENTRY_SCREENS) {
      const source = authSource(screen);
      for (const marker of ["backdrop-blur", "backdropFilter", "backdrop-filter"]) {
        expect(
          source,
          `${screen} declares \`${marker}\` inline — a blurred backdrop on an entry screen belongs in EntryBrandTile, where the motion contract is enforced`,
        ).not.toContain(marker);
      }
    }
  });

  it("fades, never slides, the motion around every blurred element", () => {
    let checked = 0;
    for (const screen of ENTRY_SCREENS) {
      const source = authSource(screen);
      for (const marker of BLURRED_MARKERS) {
        for (
          let at = source.indexOf(marker);
          at !== -1;
          at = source.indexOf(marker, at + 1)
        ) {
          checked += 1;
          for (const initial of enclosingMotionInitials(source, at)) {
            expect(
              initial,
              `a motion element wrapping \`${marker}\` in ${screen} animates geometry ({${initial.trim()}}) — moving a backdrop-filtered element forces WebKit to re-blur its whole backdrop on every frame`,
            ).not.toMatch(GEOMETRY_PROPERTIES);
          }
        }
      }
    }
    expect(
      checked,
      "no blurred elements were inspected — the scan is broken",
    ).toBeGreaterThan(12);
  });
});

/** The one sanctioned gate: `const autoFocusFinePointer = … pointer: fine …`. */
const FINE_POINTER_GATE = "autoFocusFinePointer";
const FINE_POINTER_DERIVATION = /matchMedia\(\s*(['"`])\(pointer: fine\)\1\s*\)\s*\.matches/;

interface AutoFocusUse {
  /** The prop as written, for the failure message. */
  readonly raw: string;
  /** The `{…}` expression, or `null` for the bare and string-literal forms. */
  readonly expression: string | null;
}

/**
 * Every `autoFocus` prop in a source file, WITH ITS VALUE.
 *
 * The value is the whole point, and its absence was the defect. This rule used
 * to be a single `not.toMatch(/\bautoFocus\b(?!=\{)/)` — "no bare `autoFocus`,
 * no `autoFocus="…"`" — and an audit showed that adding `autoFocus={true}` to
 * register-page survived all six cases in this file, which is defect #2 in the
 * docblock above, un-guarded, in the file written to guard it. Matching on the
 * spelling of the prop can only ever forbid the spellings someone thought of;
 * reading the expression lets the rule be an allowlist instead.
 *
 * (`\bautoFocus\b` does not match the identifier `autoFocusFinePointer` — `F`
 * is a word character, so there is no boundary after `autoFocus` there.)
 */
function autoFocusUses(source: string): AutoFocusUse[] {
  const uses: AutoFocusUse[] = [];
  const token = /\bautoFocus\b/g;
  for (let match = token.exec(source); match !== null; match = token.exec(source)) {
    let index = match.index + "autoFocus".length;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== "=") {
      // `<input autoFocus />` — JSX shorthand for `true`.
      uses.push({ raw: "autoFocus", expression: null });
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;

    if (source[index] !== "{") {
      // `autoFocus="false"` — a non-empty JSX string, so still truthy.
      const quote = source[index];
      const end = source.indexOf(quote, index + 1);
      uses.push({ raw: source.slice(match.index, end + 1), expression: null });
      continue;
    }

    let depth = 0;
    let end = index;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    uses.push({
      raw: source.slice(match.index, end + 1),
      expression: source.slice(index + 1, end).trim(),
    });
  }
  return uses;
}

describe("entry screens do not raise the iOS keyboard on arrival", () => {
  it("gates every autoFocus on every entry screen behind a fine pointer", () => {
    let inspected = 0;
    for (const screen of ENTRY_SCREENS) {
      const source = authSource(screen);
      const uses = autoFocusUses(source);
      if (uses.length === 0) continue;

      // A screen that autofocuses must own the gate, not merely mention it.
      expect(
        source,
        `${screen} autofocuses but never derives the fine-pointer gate from \`matchMedia('(pointer: fine)').matches\` — on a touch device the iOS keyboard rises during the mount animation and the field zooms the page underneath it`,
      ).toMatch(FINE_POINTER_DERIVATION);

      for (const use of uses) {
        inspected += 1;
        const complaint = `${screen} renders \`${use.raw}\` — that autofocuses on touch devices too (\`autoFocus={true}\`, a bare \`autoFocus\`, and \`autoFocus="…"\` are all unconditional). The value must be \`${FINE_POINTER_GATE}\`, or a conjunction containing it.`;
        // Allowlist, not blacklist: the expression has to REACH the gate.
        // `true`, `1`, `!!something`, `isDesktop` and every other always-truthy
        // or differently-derived spelling fail here without being enumerated.
        expect(use.expression ?? "<no expression>", complaint).toMatch(
          new RegExp(`\\b${FINE_POINTER_GATE}\\b`),
        );
        // `autoFocusFinePointer || whatever` would re-admit an ungated branch.
        expect(use.expression ?? "", complaint).not.toContain("||");
      }
    }

    expect(
      inspected,
      "no autoFocus prop was inspected on any entry screen — either the scan is broken or the parser stopped seeing the prop",
    ).toBeGreaterThanOrEqual(2);

    // The two screens that autofocus today still do; losing it silently on a
    // desktop refactor is a usability regression in the other direction.
    for (const screen of ["sign-in-page", "recover-page"]) {
      expect(
        autoFocusUses(authSource(screen)),
        `${screen} no longer autofocuses its first field at all — desktop users have to click before typing`,
      ).not.toEqual([]);
    }
  });

  // The scan is only worth what its parser is; nothing else exercises it.
  it("reads the value of every autoFocus spelling", () => {
    const cases: Array<readonly [string, string | null]> = [
      ["<input autoFocus />", null],
      ["<input autoFocus/>", null],
      ['<input autoFocus="true" />', null],
      ["<input autoFocus={true} />", "true"],
      ["<input autoFocus = {true} />", "true"],
      ["<input autoFocus={autoFocusFinePointer} />", "autoFocusFinePointer"],
      ["<input autoFocus={\n  autoFocusFinePointer && step === 1\n} />", "autoFocusFinePointer && step === 1"],
      ["<input autoFocus={{ a: 1 }.a > 0} />", "{ a: 1 }.a > 0"],
    ];
    for (const [snippet, expected] of cases) {
      const uses = autoFocusUses(snippet);
      expect(uses, `the autoFocus parser found nothing in \`${snippet}\``).toHaveLength(1);
      expect(uses[0].expression, `the autoFocus parser misread \`${snippet}\``).toBe(expected);
    }
    expect(
      autoFocusUses("const autoFocusFinePointer = true"),
      "the autoFocus parser mistakes the gate's own declaration for a prop",
    ).toEqual([]);
  });
});

const INDEX_CSS = readFileSync(
  new URL("../../web/src/index.css", import.meta.url),
  "utf8",
);

/** The declarations of a single flat CSS rule, or `null` if it is absent. */
function cssRuleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(INDEX_CSS)?.[1] ?? null;
}

describe("entry forms scroll inside themselves", () => {
  it("gives every keyboard-bearing screen its own scroller, still centred when closed", () => {
    for (const screen of FORM_SCREENS) {
      const source = authSource(screen);
      // The root is the scroller and is pinned to the dynamic viewport…
      expect(
        source,
        `${screen} has no inner scroll container — iOS will jerk the layout viewport to reveal the focused field`,
      ).toMatch(/className="[^"]*\bscroll-area\b[^"]*\bh-dvh\b/);
      // …and it carries the class that gives that scroller a scroll RANGE. A
      // scroller with nothing to scroll is not a scroller: `min-h-full` +
      // `justify-center` makes the column exactly 100dvh on a one-field form
      // like /recover, so scrollHeight === clientHeight and iOS goes straight
      // back to panning the visual viewport.
      expect(
        source,
        `${screen} lost \`entry-scroller\`, so on a form that fits the viewport its scroller has zero scroll range and the iOS keyboard reveal falls back to jerking the visual viewport — the exact behaviour the inner scroller exists to prevent`,
      ).toMatch(/className="[^"]*\bentry-scroller\b/);
      // …and the column inside it fills that height and centres, so a short
      // form still looks identical with the keyboard closed.
      expect(
        source,
        `${screen} lost the min-h-full/justify-center column, so its content no longer centres when the keyboard is closed`,
      ).toMatch(/min-h-full[^"]*justify-center|justify-center[^"]*min-h-full/);
      // The old shell clipped instead of scrolling.
      expect(
        source,
        `${screen} is back on the clipping shell (min-h-dvh + overflow-hidden), which cannot scroll a revealed field into view`,
      ).not.toMatch(/min-h-dvh[^"]*overflow-hidden|overflow-hidden[^"]*min-h-dvh/);
    }
  });

  it("keeps real reveal room past the fold, without moving the resting layout", () => {
    const resting = cssRuleBody(".entry-scroller::after");
    expect(
      resting,
      "`.entry-scroller::after` is gone from index.css — the class on the six auth screens now does nothing and every short form is back to zero scroll range",
    ).not.toBeNull();
    expect(resting).toContain('content: ""');
    expect(resting).toContain("display: block");

    // A rem floor, not just `env(keyboard-inset-height)`. That env() resolves
    // to its fallback in every browser we ship to — WebKit has no
    // VirtualKeyboard API and we do not set `virtualKeyboard.overlaysContent`
    // on Chromium — so an env()-only height is 0px, i.e. no room at all.
    for (const [name, body] of [
      ["resting", resting],
      ["focused", cssRuleBody(".entry-scroller:focus-within::after")],
    ] as const) {
      expect(body, `the ${name} .entry-scroller::after rule is missing`).not.toBeNull();
      const height = /height:\s*([^;]+);/.exec(body ?? "")?.[1] ?? "";
      const rem = /(\d+(?:\.\d+)?)rem/.exec(height)?.[1];
      expect(
        rem,
        `the ${name} reveal room resolves to 0 on iOS: \`height: ${height}\` has no static floor, and env(keyboard-inset-height) is never reported by WebKit`,
      ).toBeDefined();
      expect(Number(rem), `the ${name} reveal room is zero`).toBeGreaterThan(0);
    }

    // The room is a trailing box, never padding on the scroller. `min-h-full`
    // resolves against the scroller's content box (box-sizing is border-box
    // globally), so padding-bottom would shrink the centred column and lift
    // the content off centre with the keyboard CLOSED — visible on every load,
    // to fix something only visible while typing.
    expect(
      cssRuleBody(".entry-scroller"),
      "`.entry-scroller` grew its own rule — if that is padding-bottom, it shrinks the min-h-full column and the resting layout is no longer centred. The reveal room belongs on ::after.",
    ).toBeNull();
  });
});

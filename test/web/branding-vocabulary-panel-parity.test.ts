import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { isPublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port.js";
import { normalizeNavItems } from "@/components/layout/nav-config";
import { buildTextureCss } from "@/lib/app-texture";
import {
  DEFAULT_PUBLIC_CONFIG,
  NAV_DESTINATIONS as CABINET_NAV_DESTINATIONS,
  resolveAppBackgroundKind,
  resolveBrandPaletteSource,
  resolveCardGradientSource,
  resolvePlanCardText,
  resolveSubscriptionCardText,
  type AppBackgroundTexture,
  type NavDestinationId,
  type NavItemSetting,
  type SubscriptionCardText,
  type SubscriptionCardTextMode,
} from "@/types/branding";

/**
 * Every closed vocabulary in the branding contract, checked against the panel
 * that fills it — not against itself.
 *
 * `app-background-kind-open-vocabulary.test.ts` next door fixed ONE field by
 * opening it. This file asks the other question, about the fields that stayed
 * closed: does the cabinet accept every value rezeis-admin can actually emit?
 *
 * That question cannot be answered inside this repository. A test that lists
 * the cabinet's own allowed values and then asserts the cabinet allows them
 * proves nothing — it certifies the copy, and the copy is exactly what goes
 * stale. So each vocabulary below is READ OUT OF THE PANEL'S SOURCE and pushed
 * through the cabinet's real guard and its real renderer.
 *
 * The penalty for a mismatch is why this is worth the reach. `isPublicConfigSnapshot`
 * is one first-rejection-wins chain over the WHOLE public config: one value the
 * cabinet has not heard of fails the entire snapshot, `fetchFreshPayload` throws
 * before it can `save`, and `src/api/routes/branding.ts` serves the PREVIOUS
 * snapshot instead — indefinitely, not until a restart. Colours, logo, texts and
 * navigation all stop tracking the panel while the panel keeps reporting that
 * every save succeeded. That has already happened twice here, on `navItems` and
 * on `cardEffect`.
 *
 * Two guard shapes appear below, and the choice per field is recorded on each
 * `describe`:
 *
 *   - PARITY — the field is genuinely closed (the cabinet must draw one of N,
 *     and there is no way to draw an N+1 it has never seen). The guard is that
 *     the panel's list and the cabinet's acceptance are the same list, so the
 *     day the panel grows a member this file goes red HERE instead of the
 *     cabinet going quiet in production;
 *   - FALLBACK — the field is open, or the consumer has a defined degradation.
 *     The guard is that an unrecognised value still travels and still resolves
 *     to something the subscriber can see.
 *
 * Most fields get both: parity on the acceptance, fallback on the render.
 */

/** The sibling checkout itself: `<workspace>/rezeis/rezeis-admin/`. */
const PANEL_REPO_URL = new URL("../../../rezeis/rezeis-admin/", import.meta.url);
const PANEL_REPO_PATH = fileURLToPath(PANEL_REPO_URL);

/**
 * The three panel files that decide what can reach the cabinet, in the order a
 * value passes through them:
 *
 *   1. the FORM SCHEMA — what the operator's picker will even offer;
 *   2. the DTO — the single writing stage, which refuses anything else;
 *   3. the INTERFACE — the vocabularies both of the above import, AND the
 *      shape `readBrandingSettings` re-reads out of the database before
 *      serving `/public-config`.
 *
 * Number 3 is the authority for "what can arrive", because it is the last one
 * the value passes on the way out. A panel that stops offering a value in its
 * picker keeps SERVING it from a row written years ago.
 */
const PANEL_INTERFACE_PATH = fileURLToPath(
  new URL("src/modules/settings/interfaces/branding-settings.interface.ts", PANEL_REPO_URL),
);
const PANEL_DTO_PATH = fileURLToPath(
  new URL("src/modules/settings/dto/update-branding-settings.dto.ts", PANEL_REPO_URL),
);
const PANEL_FORM_SCHEMA_PATH = fileURLToPath(
  new URL("web/src/features/branding/branding-form-schema.ts", PANEL_REPO_URL),
);

/** Cabinet files read as source text, for the vocabularies that are types. */
const CABINET_BRANDING_TYPES_PATH = fileURLToPath(
  new URL("../../web/src/types/branding.ts", import.meta.url),
);
const CABINET_NAV_TABS_PATH = fileURLToPath(
  new URL("../../web/src/components/layout/use-nav-tabs.ts", import.meta.url),
);
const CABINET_CARD_WATERMARK_PATH = fileURLToPath(
  new URL("../../web/src/components/ui/card-watermark.tsx", import.meta.url),
);

// Only meaningful on a machine holding both checkouts side by side, which is
// the working setup here. reiwa's CI clones reiwa alone, so there the
// cross-repo cases skip.
//
// A skipped guard guards nothing, so the skip is as narrow as it can be made:
// allowed ONLY when the whole sibling repository is absent. If the repo is
// there and a file is not, it moved, and the first case below turns that into a
// red test rather than a silent skip that goes on reporting "skipped" for as
// long as it takes anyone to notice.
const hasPanelRepo = existsSync(PANEL_REPO_PATH);
const hasPanelSources =
  existsSync(PANEL_INTERFACE_PATH) &&
  existsSync(PANEL_DTO_PATH) &&
  existsSync(PANEL_FORM_SCHEMA_PATH);
const skipCrossRepo = !hasPanelSources;

/* ────────────────────────────── source reading ───────────────────────────── */

/**
 * The panel's lists are read with the TypeScript parser rather than a regular
 * expression, for the reason the card-effect parity test already states: a text
 * pattern can silently miss an entry written on one line, or with a quoted key,
 * or with a comment after the brace — and a comparison that drops a value from
 * ONE side is precisely the failure this file exists to prevent. The AST sees
 * what the compiler sees.
 */
function sourceOf(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Strip `satisfies` / `as` / parentheses to reach the literal underneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function keyText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

/**
 * The initializer of `const <name> = …`, found ANYWHERE in the file.
 *
 * Deliberately recursive rather than a scan of top-level statements: the
 * cabinet's nav registry — the map from a destination id to its route, icon and
 * label — is declared inside `useNavTabs`, and it is one of the three layers a
 * nav destination has to survive. A finder that only saw the top level would
 * have reported "not found" there, and the guard for the field that already
 * caused an outage would have been the one guard missing.
 */
function findInitializer(source: ts.SourceFile, name: string): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found = unwrap(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/** `const NAME = ['a', 'b'] as const` → `['a', 'b']`. */
function readStringArrayConst(path: string, name: string): readonly string[] {
  const initializer = findInitializer(sourceOf(path), name);
  expect(initializer, `no \`${name}\` declaration in ${path}`).not.toBeNull();
  expect(
    ts.isArrayLiteralExpression(initializer!),
    `\`${name}\` in ${path} is no longer a literal array — this test can no longer read the vocabulary it is supposed to compare`,
  ).toBe(true);

  const values = (initializer as unknown as ts.ArrayLiteralExpression).elements.map(
    (element) => {
      const value = unwrap(element);
      // Refused rather than skipped: an entry this cannot read would drop out
      // of the comparison in silence, which is the whole problem.
      expect(
        ts.isStringLiteral(value),
        `\`${name}\` in ${path} holds an entry that is not a string literal`,
      ).toBe(true);
      return (value as ts.StringLiteral).text;
    },
  );
  expect(values.length, `\`${name}\` in ${path} parsed as empty`).toBeGreaterThan(0);
  return values;
}

/** `const NAME = { 'a': …, b: … }` → `['a', 'b']`. */
function readObjectKeysConst(path: string, name: string): readonly string[] {
  const initializer = findInitializer(sourceOf(path), name);
  expect(initializer, `no \`${name}\` declaration in ${path}`).not.toBeNull();
  expect(
    ts.isObjectLiteralExpression(initializer!),
    `\`${name}\` in ${path} is no longer an object literal`,
  ).toBe(true);

  const keys = (initializer as unknown as ts.ObjectLiteralExpression).properties.map(
    (property) => {
      expect(
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
        `\`${name}\` in ${path} holds a ${ts.SyntaxKind[property.kind]}; this test can only read a flat record`,
      ).toBe(true);
      const key = property.name === undefined ? null : keyText(property.name);
      expect(key, `\`${name}\` in ${path} has a key this test cannot read`).not.toBeNull();
      return key!;
    },
  );
  expect(keys.length, `\`${name}\` in ${path} parsed as empty`).toBeGreaterThan(0);
  return keys;
}

/**
 * `type NAME = "a" | "b"` → `["a", "b"]`.
 *
 * This is the reader that exists for the DANGEROUS half of the problem. A
 * vocabulary written as a named `const` at least has a name to grep for; an
 * inline literal union on a branding field has nothing pointing at it, is never
 * imported by the guard that would have to agree with it, and goes stale
 * without leaving a mark. Every such union in `web/src/types/branding.ts` is
 * compared against the panel below through this function.
 */
function readLiteralUnionType(path: string, name: string): readonly string[] {
  const source = sourceOf(path);
  let alias: ts.TypeAliasDeclaration | null = null;
  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) continue;
    if (statement.name.text === name) alias = statement;
  }
  expect(alias, `no \`type ${name}\` in ${path}`).not.toBeNull();

  const node = alias!.type;
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  const values = members.map((member) => {
    expect(
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal),
      `\`type ${name}\` in ${path} has a member that is not a string literal — it stopped being a closed literal union, and this comparison would silently drop it`,
    ).toBe(true);
    return ((member as ts.LiteralTypeNode).literal as ts.StringLiteral).text;
  });
  expect(values.length, `\`type ${name}\` in ${path} parsed as empty`).toBeGreaterThan(0);
  return values;
}

/* ─────────────────────────── the panel's vocabularies ─────────────────────── */

/**
 * Read once, eagerly, so a parse that silently returned nothing cannot make a
 * later `toEqual` compare two empty lists and pass.
 */
const panel = skipCrossRepo
  ? null
  : {
      bgEffects: readStringArrayConst(PANEL_INTERFACE_PATH, "BG_EFFECTS"),
      appBackgroundKinds: readStringArrayConst(PANEL_INTERFACE_PATH, "APP_BACKGROUND_KINDS"),
      appBackgroundTextures: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "APP_BACKGROUND_TEXTURES",
      ),
      iconColorModes: readStringArrayConst(PANEL_INTERFACE_PATH, "ICON_COLOR_MODES"),
      subscriptionCardTextModes: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "SUBSCRIPTION_CARD_TEXT_MODES",
      ),
      planCardTextModes: readStringArrayConst(PANEL_INTERFACE_PATH, "PLAN_CARD_TEXT_MODES"),
      cardEffectSlotModes: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "CARD_EFFECT_SLOT_MODES",
      ),
      cardLogoPresets: readStringArrayConst(PANEL_INTERFACE_PATH, "CARD_LOGO_PRESETS"),
      navDestinations: readStringArrayConst(PANEL_INTERFACE_PATH, "NAV_DESTINATIONS"),
      navEssentials: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "NAV_ESSENTIAL_DESTINATIONS",
      ),
      brandPaletteSources: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "BRAND_PALETTE_SOURCES",
      ),
      cardGradientSources: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "CARD_GRADIENT_SOURCES",
      ),
      borderRadiusClasses: readStringArrayConst(
        PANEL_INTERFACE_PATH,
        "BORDER_RADIUS_CLASSES",
      ),
      // The panel's SPA copies. They are a THIRD statement of most of these
      // lists, and the earliest place a new member appears, since the picker is
      // what an operator uses. A value here that the backend refuses is the
      // panel rejecting its own picker; a value here the cabinet refuses is the
      // outage, one release early.
      formBgEffects: readStringArrayConst(PANEL_FORM_SCHEMA_PATH, "BRANDING_BG_EFFECTS"),
      formIconColorModes: readStringArrayConst(
        PANEL_FORM_SCHEMA_PATH,
        "BRANDING_ICON_COLOR_MODES",
      ),
      formSubscriptionCardTextModes: readStringArrayConst(
        PANEL_FORM_SCHEMA_PATH,
        "BRANDING_SUBSCRIPTION_CARD_TEXT_MODES",
      ),
      formPlanCardTextModes: readStringArrayConst(
        PANEL_FORM_SCHEMA_PATH,
        "BRANDING_PLAN_CARD_TEXT_MODES",
      ),
      formAppBackgroundKinds: readStringArrayConst(
        PANEL_FORM_SCHEMA_PATH,
        "BRANDING_APP_BG_KINDS",
      ),
      formAppBackgroundTextures: readStringArrayConst(
        PANEL_FORM_SCHEMA_PATH,
        "BRANDING_APP_BG_TEXTURES",
      ),
      formNavDestinations: readStringArrayConst(
        PANEL_FORM_SCHEMA_PATH,
        "BRANDING_NAV_DESTINATIONS",
      ),
      // Derived in the panel from the radii map rather than restated, so read
      // the map's keys — which is what the panel's own dropdown offers.
      formBorderRadiusClasses: readObjectKeysConst(
        PANEL_FORM_SCHEMA_PATH,
        "CORNER_RADII_BY_LEGACY_CLASS",
      ),
    };

/** Non-null accessor, so a `skipIf` that stops working fails loudly. */
function fromPanel(): NonNullable<typeof panel> {
  if (panel === null) throw new Error("panel sources are absent; this case must have skipped");
  return panel;
}

/* ──────────────────────────────── fixtures ───────────────────────────────── */

const BRANDING = DEFAULT_PUBLIC_CONFIG.branding;
const DEFAULT_APP_BACKGROUND = BRANDING.appBackground;
if (DEFAULT_APP_BACKGROUND === undefined) {
  throw new Error("DEFAULT_PUBLIC_CONFIG must ship an appBackground block");
}

function withBranding(overrides: Record<string, unknown>): unknown {
  return { ...DEFAULT_PUBLIC_CONFIG, branding: { ...BRANDING, ...overrides } };
}

function withAppBackground(overrides: Record<string, unknown>): unknown {
  return withBranding({ appBackground: { ...DEFAULT_APP_BACKGROUND, ...overrides } });
}

function withTexture(overrides: Record<string, unknown>): unknown {
  return withAppBackground({
    kind: "texture",
    texture: { ...DEFAULT_APP_BACKGROUND!.texture, ...overrides },
  });
}

/** A complete brightness variant, which `isThemeVariant` checks field by field. */
function themeVariant(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    primary: BRANDING.primary,
    primaryFg: BRANDING.primaryFg,
    bgPrimary: BRANDING.bgPrimary,
    bgSecondary: BRANDING.bgSecondary,
    cardGradient: BRANDING.cardGradient,
    cardPattern: BRANDING.cardPattern,
    cardEffect: BRANDING.cardEffect,
    cardEffectProps: {},
    cardEffectOpacity: 1,
    cardEffectsByIndex: [],
    bgEffect: BRANDING.bgEffect,
    appBackground: DEFAULT_APP_BACKGROUND,
    borderRadius: BRANDING.borderRadius,
    cornerRadii: BRANDING.cornerRadii,
    fontFamily: BRANDING.fontFamily,
    surfaceTheme: BRANDING.surfaceTheme,
    ...overrides,
  };
}

function withThemeVariants(overrides: Record<string, unknown>): unknown {
  return withBranding({
    themeVariants: { light: themeVariant(overrides), dark: themeVariant(overrides) },
  });
}

/**
 * Which of `values` the cabinet's snapshot guard actually accepts.
 *
 * Returned as a filtered LIST rather than asserted one by one so the failure is
 * a whole-list diff: the value the panel gained and the cabinet refuses shows
 * up by name, next to the ones that still work.
 */
function acceptedByCabinet(
  values: readonly string[],
  build: (value: string) => unknown,
): readonly string[] {
  return values.filter((value) => isPublicConfigSnapshot(build(value)));
}

/* ────────────────────────────────── cases ────────────────────────────────── */

describe("branding vocabulary parity with the rezeis-admin panel", () => {
  it("finds the panel's vocabularies wherever the sibling checkout exists", () => {
    // Not a parity assertion — an assertion about this file's own reach, and
    // the only case here that always runs. It says in the log which mode the
    // run is in, and fails outright in the one situation where a skip would be
    // a lie: the sibling repo is present but its sources are not where this
    // test looks.
    console.info(
      hasPanelSources
        ? `branding vocabulary parity: reading the panel at ${PANEL_REPO_PATH}`
        : `branding vocabulary parity: no sibling checkout at ${PANEL_REPO_PATH} — cross-repo cases skip`,
    );
    if (hasPanelRepo) {
      expect(
        hasPanelSources,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but its branding sources are not where this test looks (${PANEL_INTERFACE_PATH}, ${PANEL_DTO_PATH}, ${PANEL_FORM_SCHEMA_PATH}) — they moved, and every case below is skipping instead of guarding`,
      ).toBe(true);
    }
    // Anchors the fixture: every case builds on this snapshot being valid, and
    // an invalid baseline would make the `false` expectations below pass for
    // the wrong reason.
    expect(isPublicConfigSnapshot(DEFAULT_PUBLIC_CONFIG)).toBe(true);
  });

  /**
   * NAV_DESTINATIONS — PARITY, on three layers.
   *
   * The field that already cost an outage, and the only one whose value has to
   * survive three independent cabinet vocabularies rather than one. Each layer
   * fails differently and none of them says anything:
   *
   *   1. the snapshot guard — an unknown id fails the WHOLE public config, so
   *      the cabinet freezes on its previous branding entirely;
   *   2. `NAV_DESTINATIONS` in `web/src/types/branding.ts` — `normalizeNavItems`
   *      drops an id that is not in it, so the destination just is not there;
   *   3. the registry inside `useNavTabs` — an id with no route/icon/label
   *      entry is skipped by `if (tab)`, so the destination is still not there,
   *      one layer further down.
   */
  describe("NAV_DESTINATIONS", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel destination", () => {
      const destinations = fromPanel().navDestinations;
      expect(destinations.length).toBeGreaterThan(5);

      const accepted = acceptedByCabinet(destinations, (id) =>
        withBranding({ navItems: [{ id, visible: true }] }),
      );
      expect(
        accepted,
        "the panel can put a navigation destination in `navItems` that the cabinet's snapshot guard refuses — one such id discards the ENTIRE public config and the cabinet serves its previous branding indefinitely",
      ).toEqual(destinations);
    });

    it.skipIf(skipCrossRepo)("survives a full navItems array, not just a single entry", () => {
      // The realistic payload: `readNavItems` on the panel always returns ALL
      // destinations, hidden ones appended. A per-entry check would miss the
      // array-level rules (length cap, duplicate detection).
      const destinations = fromPanel().navDestinations;
      const navItems = destinations.map((id, index) => ({ id, visible: index < 3 }));
      expect(
        isPublicConfigSnapshot(withBranding({ navItems })),
        "the cabinet refuses the complete navigation array the panel always sends",
      ).toBe(true);
    });

    it.skipIf(skipCrossRepo)("keeps every panel destination through normalizeNavItems", () => {
      const destinations = fromPanel().navDestinations;
      expect(
        [...CABINET_NAV_DESTINATIONS].sort(),
        "the cabinet's own NAV_DESTINATIONS and the panel's have diverged — `normalizeNavItems` silently DROPS every id it does not hold, so the operator enables a destination and the nav bar simply does not show it",
      ).toEqual([...destinations].sort());

      const input = destinations.map((id) => ({ id, visible: true }) as NavItemSetting);
      const kept = normalizeNavItems(input).map((item) => item.id);
      expect([...kept].sort()).toEqual([...destinations].sort());
    });

    it.skipIf(skipCrossRepo)("has a route, icon and label for every panel destination", () => {
      // Layer three. Typed `Record<NavDestinationId, NavTab>`, so the compiler
      // enforces it against the CABINET's list — which is exactly the list that
      // can be the stale one. Read the keys directly instead.
      const registry = readObjectKeysConst(CABINET_NAV_TABS_PATH, "registry");
      expect(
        [...registry].sort(),
        "`useNavTabs`'s registry has no entry for a destination the panel can enable — `if (tab)` skips it, so the tab is silently absent from the bottom bar and the side nav",
      ).toEqual([...fromPanel().navDestinations].sort());
    });

    it.skipIf(skipCrossRepo)("agrees with the panel about which destinations are essential", () => {
      // Essentials are force-shown on BOTH sides. Disagreement is not an
      // outage, it is a nav bar with a destination the operator cannot remove
      // in one place and cannot keep in the other.
      expect([...fromPanel().navEssentials].sort()).toEqual(["settings", "subscriptions"]);
    });

    it.skipIf(skipCrossRepo)("offers the same destinations in the panel's own picker", () => {
      const { navDestinations, formNavDestinations } = fromPanel();
      expect(
        [...formNavDestinations].sort(),
        "the panel's branding form and the panel's backend disagree about the destinations that exist",
      ).toEqual([...navDestinations].sort());
    });

    it("pins both visible-count caps, which now agree", () => {
      // These two used to diverge, and this test was written to pin the
      // divergence. It is kept — with the same assertions — to pin the
      // agreement, because the way they disagreed is easy to re-introduce.
      //
      // What it was: the panel counted the two essentials toward
      // `NAV_MAX_VISIBLE` and then exempted them from the cap, so the optional
      // budget was "5 minus however many essentials happened to sort before
      // the overflow point" — four under the normal ordering, and
      // order-dependent, which is why it read as a rounding difference rather
      // than a bug. The cabinet's `normalizeNavItems` had it right all along:
      // essentials always visible, optional `.slice(0, 3)`, five in the bar.
      // The panel's `readNavItems` now derives the same budget from
      // `NAV_MAX_VISIBLE - NAV_ESSENTIAL_DESTINATIONS.length`.
      //
      // Note the fix was the panel's ARITHMETIC, not the constant.
      // `NAV_MAX_VISIBLE` stays 5 — it means total visible tabs, which is
      // exactly what the cabinet computes. Lowering it to 3 would look like it
      // reconciles the two and would instead cap the bar at three tabs total.
      //
      // The snapshot guard used to enforce a count too and that was removed,
      // correctly: how crowded a bar looks must never cost the operator their
      // whole configuration. This is the other half, and it is now closed.
      const everything = CABINET_NAV_DESTINATIONS.map(
        (id) => ({ id, visible: true }) as NavItemSetting,
      );
      const visible = normalizeNavItems(everything).filter((item) => item.visible);
      const optional = visible.filter(
        (item) => item.id !== "subscriptions" && item.id !== "settings",
      );

      expect(optional.length, "the cabinet's optional-destination cap moved").toBe(3);
      expect(visible.length, "the cabinet's total visible-tab count moved").toBe(5);
      if (!skipCrossRepo) {
        // `NAV_MAX_VISIBLE` is a number, not a list, so it is asserted rather
        // than parsed. It must stay 5: it is the TOTAL, and the panel derives
        // its optional budget by subtracting the essentials from it. A change
        // here has to be re-checked against the cabinet's two numbers above.
        const panelSource = readFileSync(PANEL_INTERFACE_PATH, "utf8");
        expect(
          panelSource,
          "the panel's NAV_MAX_VISIBLE changed — re-check it against the cabinet's cap of 3 optional destinations above",
        ).toContain("export const NAV_MAX_VISIBLE = 5");
      }
    });
  });

  /**
   * APP_BACKGROUND_TEXTURES — PARITY, on the guard AND on the renderer.
   *
   * Genuinely closed: a tile is a hand-written SVG path, and there is no way to
   * draw a pattern nobody drew. The renderer's fallback is `dots`, which is
   * safe (the subscriber sees a background) but INVISIBLE to the operator, who
   * picked something else and is shown dots with no explanation. So the tile
   * comparison below is what makes this guard worth more than the guard on the
   * snapshot: the snapshot check catches a freeze, the tile check catches a
   * silent substitution.
   */
  describe("APP_BACKGROUND_TEXTURES", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel pattern", () => {
      const patterns = fromPanel().appBackgroundTextures;
      expect(patterns.length).toBeGreaterThan(4);

      const accepted = acceptedByCabinet(patterns, (pattern) => withTexture({ pattern }));
      expect(
        accepted,
        "the panel offers an app-background texture the cabinet's snapshot guard refuses — the whole public config is discarded and the cabinet's appearance freezes",
      ).toEqual(patterns);
    });

    it.skipIf(skipCrossRepo)("survives it as a per-plan texturePreset too", () => {
      // The same vocabulary, checked a second time in `isPlanCardStyle`. A
      // `planCardStyles` map holds up to 500 independently written entries, so
      // it is the likeliest place for one stale value to meet a stricter reader.
      const patterns = fromPanel().appBackgroundTextures;
      const accepted = acceptedByCabinet(patterns, (texturePreset) =>
        withBranding({ planCardStyles: { plan: { texturePreset } } }),
      );
      expect(
        accepted,
        "the panel can set a per-plan texture preset the cabinet's snapshot guard refuses",
      ).toEqual(patterns);
    });

    it.skipIf(skipCrossRepo)("draws a distinct tile for every pattern the panel offers", () => {
      // `patternSvg` answers an unknown id with the DOTS tile. That is the
      // right degradation and `app-texture.test.ts` pins it — but it also means
      // a pattern the panel gained and the renderer never learned is
      // indistinguishable from the operator choosing dots. Comparing against the
      // dots tile is how that becomes visible here instead of on a subscriber's
      // screen.
      const patterns = fromPanel().appBackgroundTextures;
      const tileFor = (pattern: string): string =>
        buildTextureCss({
          ...DEFAULT_APP_BACKGROUND!.texture,
          pattern: pattern as AppBackgroundTexture,
        }).backgroundImage;

      const dots = tileFor("dots");
      const indistinguishable = patterns.filter(
        (pattern) => pattern !== "dots" && tileFor(pattern) === dots,
      );
      expect(
        indistinguishable,
        "the panel offers app-background textures the cabinet cannot draw — `patternSvg` falls through to the dots tile, so the operator picks one pattern and every subscriber sees another",
      ).toEqual([]);
    });

    it("still falls back visibly for a pattern it has never heard of", () => {
      // The FALLBACK half. Not tolerance for its own sake: a texture the
      // renderer cannot draw must still paint something, because the tile is
      // the whole app background.
      const unknown = buildTextureCss({
        ...DEFAULT_APP_BACKGROUND!.texture,
        pattern: "patternFromAFuturePanelRelease" as AppBackgroundTexture,
      });
      expect(unknown.backgroundImage).toBe(
        buildTextureCss({ ...DEFAULT_APP_BACKGROUND!.texture, pattern: "dots" })
          .backgroundImage,
      );
      expect(unknown.backgroundColor).toBe(DEFAULT_APP_BACKGROUND!.texture.background);
      expect(unknown.backgroundImage).not.toBe("");
      expect(unknown.backgroundImage).not.toBe("none");
    });
  });

  /**
   * SUBSCRIPTION_CARD_TEXT_MODES — PARITY on the guard, FALLBACK on the render.
   *
   * Closed on both sides and it should stay closed: the mode decides a literal
   * foreground colour and there is no way to honour a policy this build cannot
   * name. `resolveSubscriptionCardText` degrades an unknown one to `auto` — the
   * automatic contrast computation every card used before the control existed,
   * which is a readable card rather than an invisible one.
   */
  describe("SUBSCRIPTION_CARD_TEXT_MODES", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel mode", () => {
      const modes = fromPanel().subscriptionCardTextModes;
      expect(modes.length).toBeGreaterThan(2);

      // `custom` is the one mode that must carry an opaque colour, and every
      // other mode must carry `null`. Building each fixture the way the panel
      // builds it keeps a rejection meaning "unknown mode" rather than "wrong
      // colour for that mode".
      const accepted = acceptedByCabinet(modes, (mode) =>
        withBranding({
          subscriptionCardText: { mode, color: mode === "custom" ? "#ffffff" : null },
        }),
      );
      expect(
        accepted,
        "the panel offers a subscription-card text mode the cabinet's snapshot guard refuses — the whole public config is discarded",
      ).toEqual(modes);
    });

    it.skipIf(skipCrossRepo)("survives it inside a brightness variant", () => {
      // Variants may carry a transport copy, and it must equal the root or the
      // snapshot is refused. So the mode has to be accepted in both places at
      // once, which is a stricter question than either alone.
      const modes = fromPanel().subscriptionCardTextModes;
      const accepted = acceptedByCabinet(modes, (mode) => {
        const text = { mode, color: mode === "custom" ? "#ffffff" : null };
        return {
          ...DEFAULT_PUBLIC_CONFIG,
          branding: {
            ...BRANDING,
            subscriptionCardText: text,
            themeVariants: {
              light: themeVariant({ subscriptionCardText: text }),
              dark: themeVariant({ subscriptionCardText: text }),
            },
          },
        };
      });
      expect(accepted).toEqual(modes);
    });

    it.skipIf(skipCrossRepo)("keeps every panel mode through the resolver", () => {
      // Acceptance is not enough: a mode the guard lets through and the
      // resolver collapses to `auto` is an operator decision quietly discarded.
      const modes = fromPanel().subscriptionCardTextModes;
      const collapsed = modes.filter((mode) => {
        const input = {
          mode: mode as SubscriptionCardTextMode,
          color: mode === "custom" ? "#ffffff" : null,
        } satisfies SubscriptionCardText;
        return resolveSubscriptionCardText(input).mode !== mode;
      });
      expect(
        collapsed,
        "`resolveSubscriptionCardText` discards a card-text mode the panel can set — the operator's choice becomes automatic contrast with nothing to say so",
      ).toEqual([]);
    });

    it.skipIf(skipCrossRepo)("offers the same modes in the panel's own form", () => {
      const { subscriptionCardTextModes, formSubscriptionCardTextModes } = fromPanel();
      expect([...formSubscriptionCardTextModes].sort()).toEqual(
        [...subscriptionCardTextModes].sort(),
      );
    });

    it("resolves a mode it has never heard of to automatic contrast", () => {
      expect(
        resolveSubscriptionCardText({
          mode: "modeFromAFuturePanelRelease" as SubscriptionCardTextMode,
          color: null,
        }),
      ).toEqual({ mode: "auto", color: null });
    });
  });

  /**
   * PLAN_CARD_TEXT_MODES — FALLBACK, deliberately.
   *
   * The one field in this family that is already OPEN in the snapshot guard,
   * and the asymmetry is on purpose: `hasOptionalPlanCardText` accepts any
   * short string because 500 per-plan entries are 500 chances for one stale
   * value to freeze the cabinet, while the cost of tolerating one is a single
   * card inheriting the global policy. These cases hold that decision in place.
   */
  describe("PLAN_CARD_TEXT_MODES", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel mode", () => {
      const modes = fromPanel().planCardTextModes;
      const accepted = acceptedByCabinet(modes, (mode) =>
        withBranding({
          planCardStyles: {
            plan: { text: { mode, color: mode === "custom" ? "#ffffff" : null } },
          },
        }),
      );
      expect(accepted).toEqual(modes);
    });

    it.skipIf(skipCrossRepo)("honours every per-plan mode the panel can set", () => {
      const modes = fromPanel().planCardTextModes;
      const global = { mode: "dark", color: null } satisfies SubscriptionCardText;
      const resolved = modes.map((mode) =>
        resolvePlanCardText(
          {
            mode: mode as SubscriptionCardTextMode,
            color: mode === "custom" ? "#ffffff" : null,
          },
          global,
        ).mode,
      );
      // `inherit` is the one that is SUPPOSED to become the global policy;
      // every other mode must reach the card intact.
      const expected = modes.map((mode) => (mode === "inherit" ? global.mode : mode));
      expect(
        resolved,
        "`resolvePlanCardText` discards a per-plan text mode the panel can set",
      ).toEqual(expected);
    });

    it("keeps an unrecognised per-plan mode travelling, and inherits it", () => {
      expect(
        isPublicConfigSnapshot(
          withBranding({
            planCardStyles: { plan: { text: { mode: "modeFromAFuturePanel", color: null } } },
          }),
        ),
        "the per-plan text mode became a closed set — 500 entries each able to freeze the whole cabinet",
      ).toBe(true);
      expect(
        resolvePlanCardText(
          { mode: "modeFromAFuturePanel" as SubscriptionCardTextMode, color: null },
          { mode: "light", color: null },
        ),
      ).toEqual({ mode: "light", color: null });
    });

    it("still refuses a per-plan text block that cannot be a policy at all", () => {
      // Tolerance is not absence of checking.
      for (const text of ["dark", 7, [], { mode: 3 }, { mode: "" }, { mode: "m".repeat(33) }]) {
        expect(
          isPublicConfigSnapshot(withBranding({ planCardStyles: { plan: { text } } })),
        ).toBe(false);
      }
    });
  });

  /**
   * ICON_COLOR_MODES — PARITY on the guard, FALLBACK on the render.
   *
   * Genuinely closed: three strategies, each a different source for a colour,
   * and a fourth cannot be guessed. The consumer already degrades correctly —
   * an unrecognised mode yields no tint, which leaves each icon its own accent,
   * i.e. the `default` look the cabinet had before the control existed.
   */
  describe("ICON_COLOR_MODES", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel mode", () => {
      const modes = fromPanel().iconColorModes;
      expect(modes.length).toBeGreaterThan(1);

      const accepted = acceptedByCabinet(modes, (iconColorMode) =>
        withBranding({ iconColorMode }),
      );
      expect(
        accepted,
        "the panel offers an icon colour mode the cabinet's snapshot guard refuses — the whole public config is discarded and the cabinet's appearance freezes",
      ).toEqual(modes);
    });

    it.skipIf(skipCrossRepo)("matches the cabinet's own inline union", () => {
      // The union is what every consumer narrows against. Nothing imports it
      // from the panel and nothing checks it, so it is exactly the kind of copy
      // that goes stale without leaving a mark.
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "IconColorMode")].sort(),
        "`IconColorMode` in the cabinet and `ICON_COLOR_MODES` in the panel have diverged",
      ).toEqual([...fromPanel().iconColorModes].sort());
    });

    it.skipIf(skipCrossRepo)("offers the same modes in the panel's own form", () => {
      expect([...fromPanel().formIconColorModes].sort()).toEqual(
        [...fromPanel().iconColorModes].sort(),
      );
    });
  });

  /**
   * BG_EFFECTS — PARITY.
   *
   * A legacy vocabulary written only by theme presets; the panel has no control
   * for it. In this build the cabinet does nothing with the value but copy it to
   * a `data-bg-effect` attribute that no stylesheet and no component reads — so
   * the ONLY consequence a member of this set has today is whether the snapshot
   * guard accepts it. That makes the closed set here pure downside: a sixth
   * effect name would freeze every branding field in the cabinet in exchange for
   * an attribute nobody looks at. Left closed and guarded rather than opened,
   * because opening it is a production change and this is a test; but the
   * asymmetry is worth knowing when the sixth name is proposed.
   */
  describe("BG_EFFECTS", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel effect", () => {
      const effects = fromPanel().bgEffects;
      expect(effects.length).toBeGreaterThan(3);

      const accepted = acceptedByCabinet(effects, (bgEffect) => withBranding({ bgEffect }));
      expect(
        accepted,
        "the panel can write a background effect the cabinet's snapshot guard refuses — the whole public config is discarded over a value nothing in the cabinet renders",
      ).toEqual(effects);
    });

    it.skipIf(skipCrossRepo)("survives it inside both brightness variants", () => {
      // Theme presets are the only writer, and a preset writes `bgEffect` into
      // each variant as well as the root, so a new name arrives three times per
      // snapshot.
      const effects = fromPanel().bgEffects;
      const accepted = acceptedByCabinet(effects, (bgEffect) =>
        withThemeVariants({ bgEffect }),
      );
      expect(accepted).toEqual(effects);
    });

    it.skipIf(skipCrossRepo)("matches the cabinet's own inline union", () => {
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "BgEffect")].sort(),
        "`BgEffect` in the cabinet and `BG_EFFECTS` in the panel have diverged",
      ).toEqual([...fromPanel().bgEffects].sort());
    });

    it.skipIf(skipCrossRepo)("offers the same effects in the panel's own form", () => {
      expect([...fromPanel().formBgEffects].sort()).toEqual([...fromPanel().bgEffects].sort());
    });
  });

  /**
   * borderRadius — PARITY, and the one field here whose panel side is NOT
   * clamped.
   *
   * Every other vocabulary in this file is enforced twice on the panel: the DTO
   * refuses a bad write, and `readBrandingSettings` re-checks the stored value
   * on the way out. `borderRadius` is read with a bare `readString`, so the
   * ONLY thing standing between an arbitrary persisted class and the cabinet's
   * six-member `BORDER_RADII` set is `@IsBorderRadiusClass()` on the DTO. Take
   * that decorator away — or write the row by any path that is not the DTO —
   * and the cabinet refuses the whole snapshot and freezes.
   *
   * So this describe guards the panel's decorator as well as the list.
   */
  describe("borderRadius", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel class", () => {
      const classes = fromPanel().borderRadiusClasses;
      expect(classes.length).toBeGreaterThan(3);

      const accepted = acceptedByCabinet(classes, (borderRadius) =>
        withBranding({ borderRadius }),
      );
      expect(
        accepted,
        "the panel can write a border-radius class the cabinet's snapshot guard refuses — the whole public config is discarded and the cabinet's appearance freezes",
      ).toEqual(classes);
    });

    it.skipIf(skipCrossRepo)("survives it inside both brightness variants", () => {
      const classes = fromPanel().borderRadiusClasses;
      const accepted = acceptedByCabinet(classes, (borderRadius) =>
        withThemeVariants({ borderRadius }),
      );
      expect(accepted).toEqual(classes);
    });

    it.skipIf(skipCrossRepo)("is offered as the same list by the panel's radius dropdown", () => {
      expect(
        [...fromPanel().formBorderRadiusClasses].sort(),
        "the panel's radius dropdown and its request DTO disagree about the classes that exist",
      ).toEqual([...fromPanel().borderRadiusClasses].sort());
    });

    it.skipIf(skipCrossRepo)("is still validated at the panel's writing stage", () => {
      // This used to say the DTO was the panel's ENTIRE defence, because
      // `readBrandingSettings` passed the field through unchecked
      // (`readString`) on the root and on each brightness variant. That was
      // true and it was the hazard: any row that did not come through the DTO
      // — a legacy row, a restored backup, a seed, a hand edit — reached the
      // cabinet, which refuses the whole public config over one bad radius and
      // then serves its previous snapshot forever. Every OTHER vocabulary here
      // is enforced twice on the panel; this one was enforced once.
      //
      // The read side is guarded now (`readBorderRadius`, both levels,
      // substituting the default rather than propagating the rejection — a
      // wrong corner beats no branding at all). So this test no longer guards
      // against an outage; it guards the layer that tells the OPERATOR their
      // input was wrong. Lose the decorator and a bad class is silently
      // repaired on read instead of refused on write: the panel stops
      // disagreeing with the operator, which is how a typo becomes a
      // permanent, invisible substitution.
      const dto = readFileSync(PANEL_DTO_PATH, "utf8");
      const declarations = dto.match(/public borderRadius[!?]?:/g) ?? [];
      expect(
        declarations.length,
        "the panel's DTO no longer declares borderRadius where this guard expects it",
      ).toBeGreaterThanOrEqual(2);
      expect(
        (dto.match(/@IsBorderRadiusClass\(\)/g) ?? []).length,
        "a `borderRadius` property in the panel's DTO lost `@IsBorderRadiusClass()` — the read side would now silently substitute the default instead of refusing the write, so an operator's typo becomes an invisible, permanent substitution",
      ).toBeGreaterThanOrEqual(declarations.length);
    });

    it("refuses a radius class outside the six, on purpose", () => {
      // Pinning the hazard where a reader will meet it. This is NOT a value the
      // panel's DTO can produce today; it is what a legacy row, a restored
      // backup or a non-DTO writer produces, and the cost is the whole snapshot.
      expect(isPublicConfigSnapshot(withBranding({ borderRadius: "rounded-md" }))).toBe(false);
      expect(isPublicConfigSnapshot(withBranding({ borderRadius: "rounded-sm" }))).toBe(false);
    });
  });

  /**
   * APP_BACKGROUND_KINDS — FALLBACK, already, and this is the case that would
   * have caught `plain` a release early.
   *
   * The guard is open (see `app-background-kind-open-vocabulary.test.ts`), so
   * an unknown kind travels. What that file cannot say — because it names the
   * kinds itself — is whether the cabinet can DRAW every kind the panel offers.
   * An unknown kind resolves to `none`, the built-in background: safe, and
   * silently not what the operator picked.
   */
  describe("APP_BACKGROUND_KINDS", () => {
    it.skipIf(skipCrossRepo)("draws every kind the panel's picker offers", () => {
      const kinds = fromPanel().appBackgroundKinds;
      expect(kinds.length).toBeGreaterThan(3);

      const undrawable = kinds.filter((kind) => resolveAppBackgroundKind(kind) !== kind);
      expect(
        undrawable,
        "the panel offers an app-background mode the cabinet cannot draw — `resolveAppBackgroundKind` degrades it to `none`, so the operator selects one background and every subscriber sees the built-in one",
      ).toEqual([]);
    });

    it.skipIf(skipCrossRepo)("matches the cabinet's own inline union", () => {
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "AppBackgroundKind")].sort(),
      ).toEqual([...fromPanel().appBackgroundKinds].sort());
    });

    it.skipIf(skipCrossRepo)("offers the same kinds in the panel's own picker", () => {
      expect([...fromPanel().formAppBackgroundKinds].sort()).toEqual(
        [...fromPanel().appBackgroundKinds].sort(),
      );
    });

    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel kind", () => {
      const kinds = fromPanel().appBackgroundKinds;
      const accepted = acceptedByCabinet(kinds, (kind) =>
        // `texture` is the one kind that requires its own block to be present
        // and valid; build the fixture the way the panel would.
        kind === "texture" ? withTexture({}) : withAppBackground({ kind }),
      );
      expect(accepted).toEqual(kinds);
    });
  });

  /**
   * CARD_EFFECT_SLOT_MODES — PARITY.
   *
   * A two-member discriminator that decides whether a positional card slot
   * follows the global artwork or replaces it. The snapshot guard refuses a
   * third value outright, so a panel that gained one would freeze the cabinet.
   */
  describe("CARD_EFFECT_SLOT_MODES", () => {
    it.skipIf(skipCrossRepo)("survives the snapshot guard for every panel mode", () => {
      const modes = fromPanel().cardEffectSlotModes;
      const accepted = acceptedByCabinet(modes, (mode) =>
        withBranding({
          cardEffectsByIndex: [
            { mode, cardEffect: "aurora", cardEffectProps: {}, cardEffectOpacity: 1 },
          ],
        }),
      );
      expect(
        accepted,
        "the panel can write a card-effect slot mode the cabinet's snapshot guard refuses — the whole public config is discarded",
      ).toEqual(modes);
    });

    it.skipIf(skipCrossRepo)("matches the cabinet's inline union on the slot type", () => {
      // Declared inline on `CardEffectSlot.mode`, so it has no type alias to
      // read. Read the interface member's own union instead.
      const source = readFileSync(CABINET_BRANDING_TYPES_PATH, "utf8");
      const declared = /mode\?:\s*("inherit"\s*\|\s*"override")\s*;/.exec(source);
      expect(
        declared,
        "`CardEffectSlot.mode` is no longer the inline `\"inherit\" | \"override\"` union this guard compares against the panel",
      ).not.toBeNull();
      expect([...fromPanel().cardEffectSlotModes].sort()).toEqual(["inherit", "override"]);
    });
  });

  /**
   * CARD_LOGO_PRESETS — FALLBACK, and it is the right shape here.
   *
   * The snapshot guard already treats `cardLogo` as free text, so a new preset
   * cannot freeze anything. What it CAN do is arrive with no glyph behind it:
   * `CardWatermark` answers an unmapped preset with the Reiwa mark. Visible and
   * safe — and, again, not what the operator picked, which is what the parity
   * case below is for.
   */
  describe("CARD_LOGO_PRESETS", () => {
    it.skipIf(skipCrossRepo)("never freezes the snapshot over a preset name", () => {
      const presets = [...fromPanel().cardLogoPresets, "PRESET_FROM_A_FUTURE_PANEL"];
      const accepted = acceptedByCabinet(presets, (cardLogo) => withBranding({ cardLogo }));
      expect(
        accepted,
        "`cardLogo` became a closed set — a watermark glyph must never be able to discard the whole public config",
      ).toEqual(presets);
    });

    it.skipIf(skipCrossRepo)("has a glyph for every preset the panel offers", () => {
      // `DEFAULT` and `NONE` are handled before the map is consulted, so they
      // are not expected to appear in it.
      const drawnSeparately = new Set(["DEFAULT", "NONE"]);
      const mapped = new Set(readObjectKeysConst(CABINET_CARD_WATERMARK_PATH, "PRESET_ICON"));
      const missing = fromPanel()
        .cardLogoPresets.filter((preset) => !drawnSeparately.has(preset))
        .filter((preset) => !mapped.has(preset));
      expect(
        missing,
        "the panel offers a card watermark the cabinet has no glyph for — `CardWatermark` falls back to the Reiwa mark, so the operator picks a crown and every subscriber sees the Reiwa logo",
      ).toEqual([]);
    });

    it.skipIf(skipCrossRepo)("matches the cabinet's own inline union", () => {
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "CardLogoPreset")].sort(),
        "`CardLogoPreset` in the cabinet and `CARD_LOGO_PRESETS` in the panel have diverged",
      ).toEqual([...fromPanel().cardLogoPresets].sort());
    });
  });

  /**
   * The ownership discriminators — PARITY.
   *
   * `brandPaletteSource` and `cardGradientSource` decide whether the root value
   * or the concept's per-brightness snapshot is drawn, so a value the cabinet
   * cannot name repaints the whole cabinet rather than breaking loudly. Both
   * are `concept | custom` on both sides, both resolve an absent value to
   * `concept`, and both are refused outright by the guard when present and
   * unknown — which is correct here, because there is no third meaning to
   * degrade to.
   */
  describe("ownership discriminators", () => {
    it.skipIf(skipCrossRepo)("accept and resolve every source the panel can write", () => {
      const { brandPaletteSources, cardGradientSources } = fromPanel();
      expect([...brandPaletteSources].sort()).toEqual(["concept", "custom"]);
      expect([...cardGradientSources].sort()).toEqual(["concept", "custom"]);

      expect(
        acceptedByCabinet(brandPaletteSources, (brandPaletteSource) =>
          withBranding({ brandPaletteSource }),
        ),
      ).toEqual(brandPaletteSources);
      expect(
        acceptedByCabinet(cardGradientSources, (cardGradientSource) =>
          withBranding({ cardGradientSource }),
        ),
      ).toEqual(cardGradientSources);

      for (const source of brandPaletteSources) {
        expect(resolveBrandPaletteSource(source as "concept" | "custom")).toBe(source);
      }
      for (const source of cardGradientSources) {
        expect(resolveCardGradientSource(source as "concept" | "custom")).toBe(source);
      }
    });

    it.skipIf(skipCrossRepo)("match the cabinet's own inline unions", () => {
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "BrandPaletteSource")].sort(),
      ).toEqual([...fromPanel().brandPaletteSources].sort());
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "CardGradientSource")].sort(),
      ).toEqual([...fromPanel().cardGradientSources].sort());
    });

    it("resolve a legacy absent source to the concept, in both cases", () => {
      expect(resolveBrandPaletteSource(undefined)).toBe("concept");
      expect(resolveCardGradientSource(undefined)).toBe("concept");
    });
  });

  /**
   * The theme discriminators — PARITY against the DTO, which is where the panel
   * spells them out inline rather than as a named vocabulary.
   */
  describe("theme mode discriminators", () => {
    it.skipIf(skipCrossRepo)("accept the two policies and the two modes the panel writes", () => {
      const dto = readFileSync(PANEL_DTO_PATH, "utf8");
      expect(
        dto,
        "the panel's theme-mode policy vocabulary moved; this comparison no longer reads it",
      ).toContain("@IsIn(['fixed', 'user-selectable'] as const)");
      expect(dto).toContain("@IsIn(['light', 'dark'] as const)");

      expect(
        acceptedByCabinet(["fixed", "user-selectable"], (themeModePolicy) =>
          withBranding({ themeModePolicy }),
        ),
      ).toEqual(["fixed", "user-selectable"]);
      expect(
        acceptedByCabinet(["light", "dark"], (themeDefaultMode) =>
          withBranding({ themeDefaultMode }),
        ),
      ).toEqual(["light", "dark"]);
    });

    it.skipIf(skipCrossRepo)("match the cabinet's own inline unions", () => {
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "BrandingThemeMode")].sort(),
      ).toEqual(["dark", "light"]);
      expect(
        [...readLiteralUnionType(CABINET_BRANDING_TYPES_PATH, "BrandingThemeModePolicy")].sort(),
      ).toEqual(["fixed", "user-selectable"]);
    });
  });

  /**
   * The closed sets are still closed.
   *
   * Every case above asks whether something is accepted. Without this one they
   * would all pass on a guard that accepted everything — including the corrupt
   * snapshots these sets exist to refuse.
   */
  describe("closedness itself", () => {
    it.each([
      ["bgEffect", () => withBranding({ bgEffect: "SOMETHING_NEW" })],
      ["iconColorMode", () => withBranding({ iconColorMode: "rainbow" })],
      ["borderRadius", () => withBranding({ borderRadius: "rounded-md" })],
      ["appBackground.texture.pattern", () => withTexture({ pattern: "herringbone" })],
      ["navItems[].id", () => withBranding({ navItems: [{ id: "wallet", visible: true }] })],
      [
        "subscriptionCardText.mode",
        () => withBranding({ subscriptionCardText: { mode: "neon", color: null } }),
      ],
      [
        "planCardStyles[].texturePreset",
        () => withBranding({ planCardStyles: { plan: { texturePreset: "herringbone" } } }),
      ],
      [
        "cardEffectsByIndex[].mode",
        () =>
          withBranding({
            cardEffectsByIndex: [
              { mode: "replace", cardEffect: "aurora", cardEffectProps: {}, cardEffectOpacity: 1 },
            ],
          }),
      ],
      ["brandPaletteSource", () => withBranding({ brandPaletteSource: "preset" })],
      ["cardGradientSource", () => withBranding({ cardGradientSource: "preset" })],
      ["themeModePolicy", () => withBranding({ themeModePolicy: "operator-only" })],
      ["themeDefaultMode", () => withBranding({ themeDefaultMode: "sepia" })],
    ])("still refuses an unknown %s", (_label, build) => {
      expect(isPublicConfigSnapshot(build())).toBe(false);
    });

    it("still refuses a duplicate or over-long navItems array", () => {
      expect(
        isPublicConfigSnapshot(
          withBranding({
            navItems: [
              { id: "plans", visible: true },
              { id: "plans", visible: false },
            ],
          }),
        ),
      ).toBe(false);
      expect(
        isPublicConfigSnapshot(
          withBranding({
            navItems: [...CABINET_NAV_DESTINATIONS, "plans"].map((id) => ({
              id,
              visible: false,
            })),
          }),
        ),
      ).toBe(false);
    });
  });
});

/**
 * A compile-time nudge, not a runtime case: the ids this file feeds through
 * `normalizeNavItems` are the cabinet's own, so if `NavDestinationId` ever stops
 * covering them the type-check fails before the suite runs.
 */
const _navDestinationIdsAreStillTheCabinetsOwn: readonly NavDestinationId[] =
  CABINET_NAV_DESTINATIONS;
void _navDestinationIdsAreStillTheCabinetsOwn;

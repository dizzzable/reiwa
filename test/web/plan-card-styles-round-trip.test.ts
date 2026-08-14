import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describePublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port";
import {
  resolvePlanCardStyle,
  type ResolvedPlanCardStyle,
} from "@/features/plans/plan-card-visual";
import { buildTextureCss } from "@/lib/app-texture";
import type { AppBackgroundTexture, Branding } from "@/types/branding";

/**
 * One per-plan tariff-card style, carried the whole way from the panel control
 * that produced it to the cabinet value a subscriber sees.
 *
 * Five modules in two repositories have to agree about the same seven optional
 * fields, and every one of them can drop or refuse a value on its own:
 *
 *   1. the panel's Zod schema           (rezeis-admin/web, `branding-form-schema`)
 *   2. the API's DTO validators         (rezeis-admin, `update-branding-settings.dto`)
 *   3. the changed-field gate           (rezeis-admin, `extractUpdatedBrandingFields`)
 *   4. the persistence normalizer       (rezeis-admin, `readPlanCardStyles`)
 *   5. the cabinet's snapshot guard     (reiwa, `describePublicConfigSnapshot`)
 *   6. the cabinet's consumer           (reiwa, `resolvePlanCardStyle`)
 *
 * Each of them was individually covered before this file, and the settings
 * still did not save: the break was in the seam, not in any one module. So this
 * exercises the REAL modules end to end, with the exact objects the panel's
 * `setStyle()` builds — including the explicit `null` patches its texture and
 * effect controls emit — and asserts that what the operator set is what comes
 * out the far end. Anything less is a set of green tests around a broken chain.
 *
 * Two of the six stages fail in ways nobody sees, which is why the helper below
 * names the stage rather than just asserting the final value:
 *
 *   - stage 1 rejects BEFORE any request leaves the browser. The panel reports
 *     "validation failed" and jumps to the tab, but the issue path is
 *     `planCardStyles.<planId>.<field>`, and react-hook-form cannot attach that
 *     to any rendered input — so no field is marked and the operator sees a
 *     save button that does nothing. Both defects this file was written to find
 *     lived here;
 *   - stage 5 is all-or-nothing and FIRST-REJECTION-WINS. One unusable entry
 *     discards the entire branding snapshot, and the cabinet then goes on
 *     serving the previous one indefinitely — colours, logo, texts and all —
 *     while the panel keeps reporting successful saves. That has already
 *     happened once, over `navItems`; see the long note beside
 *     `describeNavItems` in the port.
 *
 * It lives in reiwa because reiwa's runner is the only one that can load all
 * six: the panel's schema and the cabinet's consumer are ESM behind two
 * different `@/` aliases, and rezeis-admin's `node --test` + ts-node run is
 * CommonJS and can require neither. reiwa is also the side that pays for a
 * disagreement, which makes it the right place to notice one. Same sibling
 * checkout, same narrow skip, as `card-effect-catalog-parity.test.ts` next door.
 */

/** The sibling checkout itself: `<workspace>/rezeis/rezeis-admin/`. */
const PANEL_REPO_URL = new URL("../../../rezeis/rezeis-admin/", import.meta.url);
const panelPath = (relative: string): string =>
  fileURLToPath(new URL(relative, PANEL_REPO_URL));

const PANEL_REPO_PATH = fileURLToPath(PANEL_REPO_URL);
/**
 * Everything this file has to load out of the sibling checkout. `node_modules`
 * entries are in the list on purpose: `class-validator` is how stage 2 is run
 * at all, and an un-installed sibling would otherwise turn into a stack trace
 * from inside the import rather than the one clear message below.
 */
const PANEL_MODULES = {
  schema: "web/src/features/branding/branding-form-schema.ts",
  presets: "web/src/features/branding/theme-presets.ts",
  catalog: "web/src/features/branding/card-effect-catalog.ts",
  texture: "web/src/features/branding/app-texture.ts",
  dto: "src/modules/settings/dto/update-branding-settings.dto.ts",
  persistence: "src/modules/settings/utils/branding-settings.util.ts",
  reflectMetadata: "node_modules/reflect-metadata",
  classTransformer: "node_modules/class-transformer",
  classValidator: "node_modules/class-validator",
} as const;

const hasSiblingRepo = existsSync(PANEL_REPO_PATH);
const missingModules = Object.values(PANEL_MODULES).filter(
  (relative) => !existsSync(panelPath(relative)),
);
const hasSibling = hasSiblingRepo && missingModules.length === 0;

/**
 * What this file uses out of the sibling checkout, stated as types.
 *
 * The modules are loaded by path at run time, so TypeScript can tell us
 * nothing about them — a `tsc` over this project has no idea that repository
 * exists. Writing the surface down anyway is the point: it is the list of names
 * this test depends on over there, and it keeps the round trip below readable
 * as a sequence of named calls rather than a chain of untyped property access.
 * A rename in the panel breaks the run, loudly, at the call that no longer
 * resolves — which is the correct place for a cross-repo break to appear.
 */
interface ZodIssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

type DirtyPatchResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: { readonly issues: readonly ZodIssueLike[] } };

interface PanelDraft {
  readonly planCardStyles: Record<string, Record<string, unknown> | undefined>;
}

interface PanelSchemaModule {
  createBrandingFormSchema(messages: Record<string, string>): unknown;
  createInitialBrandingDraft(input?: {
    readonly planCardStyles?: Record<string, unknown>;
  }): PanelDraft;
  getBrandingChangedFields(values: unknown, baseline: unknown): Record<string, unknown>;
  createBrandingDirtyPatch(input: {
    readonly values: unknown;
    readonly dirtyFields: Record<string, unknown>;
    readonly schema: unknown;
  }): DirtyPatchResult;
}

interface PanelPresetsModule {
  readonly CARD_GRADIENT_PRESETS: readonly { readonly id: string; readonly value: string }[];
  gradientFromPrimary(primary: string): string;
}

interface PanelCatalogModule {
  readonly CARD_EFFECT_CATALOG: Readonly<Record<string, unknown>>;
  getCardEffectDefaults(effect: string): Record<string, unknown>;
}

interface PanelTextureModule {
  readonly APP_BG_TEXTURE_PATTERNS: readonly string[];
}

interface PanelDtoModule {
  readonly UpdateBrandingSettingsDto: new () => object;
}

interface PanelPersistenceModule {
  mergeBrandingSettings(input: {
    readonly existing: unknown;
    readonly patch: unknown;
  }): Record<string, unknown>;
  readBrandingSettings(value: unknown): Record<string, unknown>;
}

interface ClassTransformerModule {
  plainToInstance(cls: new () => object, plain: object): object;
}

interface ValidationErrorLike {
  readonly property: string;
  readonly constraints?: Record<string, string>;
}

interface ClassValidatorModule {
  validateSync(
    object: object,
    options?: { readonly whitelist?: boolean },
  ): readonly ValidationErrorLike[];
}

let panelSchemaModule: PanelSchemaModule;
let panelPresets: PanelPresetsModule;
let panelCatalog: PanelCatalogModule;
let panelTexture: PanelTextureModule;
let panelDto: PanelDtoModule;
let panelPersistence: PanelPersistenceModule;
let classTransformer: ClassTransformerModule;
let classValidator: ClassValidatorModule;

if (hasSibling) {
  // `reflect-metadata` FIRST and on its own line: `class-transformer`'s
  // `@Type()` decorator reads `Reflect.getMetadata` while the DTO module is
  // still evaluating, so importing the DTO before this throws
  // "Reflect.getMetadata is not a function" from inside a decorator.
  await import(/* @vite-ignore */ panelPath(PANEL_MODULES.reflectMetadata));
  panelSchemaModule = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.schema)
  )) as PanelSchemaModule;
  panelPresets = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.presets)
  )) as PanelPresetsModule;
  panelCatalog = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.catalog)
  )) as PanelCatalogModule;
  panelTexture = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.texture)
  )) as PanelTextureModule;
  panelDto = (await import(/* @vite-ignore */ panelPath(PANEL_MODULES.dto))) as PanelDtoModule;
  panelPersistence = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.persistence)
  )) as PanelPersistenceModule;
  classTransformer = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.classTransformer)
  )) as ClassTransformerModule;
  classValidator = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.classValidator)
  )) as ClassValidatorModule;
}

const PLAN_ID = "plan_alpha";
/** The panel's own i18n strings are irrelevant here; only WHICH check fired is. */
const VALIDATION_MESSAGES = {
  hexInvalid: "hex-invalid",
  imageUrlInvalid: "image-url-invalid",
  gradientInvalid: "gradient-invalid",
} as const;

/** One entry as the panel's `setStyle()` merges it — explicit nulls included. */
type StyleDraft = Readonly<Record<string, unknown>>;

interface RoundTripResult {
  /** Stage that refused the value, or `null` when it reached the cabinet. */
  readonly rejectedBy: string | null;
  /** Human-readable cause, for the assertion message. */
  readonly reason: string | null;
  /** What `readPlanCardStyles` persisted for `PLAN_ID` (`undefined` = no entry). */
  readonly persisted: Record<string, unknown> | undefined;
  /** The whole persisted map, for the cap cases. */
  readonly persistedMap: Record<string, unknown>;
  /** What the cabinet resolves for `PLAN_ID`, or `null` when a stage refused. */
  readonly resolved: ResolvedPlanCardStyle | null;
  /** The panel draft rebuilt from the API response (the form's next baseline). */
  readonly rehydrated: Record<string, unknown> | undefined;
}

/**
 * Push a `planCardStyles` map through all six stages exactly as production
 * does, stopping at the first one that refuses it.
 *
 * `saved` is what the API last returned — the form's baseline AND the stored
 * settings the patch merges over. It defaults to nothing saved, which is the
 * common case; the clearing cases need it because the panel submits only what
 * DIFFERS from the baseline, so "remove this style" is only a real edit when
 * there was a style to remove.
 *
 * The two `JSON.parse(JSON.stringify(...))` hops are not decoration. They are
 * the HTTP boundaries, and they are where a key set to `undefined` disappears
 * — which is precisely how the panel's effect control clears an effect
 * (`{ cardEffect: null, cardEffectProps: undefined }`). A test that passed the
 * objects along in memory would be checking a shape the API never receives.
 */
function roundTrip(
  styles: Record<string, StyleDraft>,
  saved: Record<string, StyleDraft> = {},
): RoundTripResult {
  const schema = panelSchemaModule.createBrandingFormSchema(VALIDATION_MESSAGES);
  const baseline = panelSchemaModule.createInitialBrandingDraft({ planCardStyles: saved });
  const values = { ...baseline, planCardStyles: styles };

  // Stage 1 — the panel. `getBrandingChangedFields` decides what is dirty and
  // `createBrandingDirtyPatch` validates only that; a field the operator did
  // not touch must never be re-submitted.
  const dirtyFields = panelSchemaModule.getBrandingChangedFields(values, baseline);
  const patch = panelSchemaModule.createBrandingDirtyPatch({ values, dirtyFields, schema });
  if (!patch.success) {
    return {
      rejectedBy: "panel Zod schema",
      reason: patch.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" | "),
      persisted: undefined,
      persistedMap: {},
      resolved: null,
      rehydrated: undefined,
    };
  }
  const body = JSON.parse(JSON.stringify(patch.data)) as Record<string, unknown>;

  // Stage 2 — the API DTO.
  const instance = classTransformer.plainToInstance(panelDto.UpdateBrandingSettingsDto, body);
  const errors = classValidator.validateSync(instance as object, { whitelist: false });
  if (errors.length > 0) {
    return {
      rejectedBy: "backend DTO",
      reason: errors
        .map((error) => `${error.property}: ${Object.values(error.constraints ?? {}).join(", ")}`)
        .join(" | "),
      persisted: undefined,
      persistedMap: {},
      resolved: null,
      rehydrated: undefined,
    };
  }

  // Stage 3 — the changed-field gate. `extractUpdatedBrandingFields` is module
  // private, but it is `Object.prototype.hasOwnProperty` over the DTO instance
  // and nothing else, and a field missing from it makes the update a silent
  // no-op. Ask the instance the same question the service asks it.
  if (!Object.prototype.hasOwnProperty.call(instance, "planCardStyles")) {
    return {
      rejectedBy: "changed-field gate",
      reason: "planCardStyles is not an own property of the DTO instance, so the update is a no-op",
      persisted: undefined,
      persistedMap: {},
      resolved: null,
      rehydrated: undefined,
    };
  }

  // Stage 4 — persistence, over what was already stored.
  const stored = panelPersistence.mergeBrandingSettings({
    existing: { planCardStyles: saved },
    patch: body,
  });
  const branding = panelPersistence.readBrandingSettings(stored);
  const wire = JSON.parse(JSON.stringify(branding)) as Record<string, unknown>;
  const persistedMap = (wire.planCardStyles ?? {}) as Record<string, unknown>;

  // Stage 5 — the cabinet's snapshot guard, over a whole public config, because
  // that is the unit it accepts or discards.
  const rejection = describePublicConfigSnapshot({
    branding: wire,
    locales: ["en"],
    defaultLocale: "en",
    defaultCurrency: "USD",
    customIcons: [],
    botUsername: null,
    supportUsername: null,
    platformBranding: { projectName: null, webTitle: null },
    emailEnabled: false,
  });
  if (rejection !== null) {
    return {
      rejectedBy: "cabinet snapshot guard",
      reason: `${rejection.key}: ${rejection.reason} (found ${rejection.found}) — the ENTIRE branding snapshot is discarded and the cabinet freezes on the previous one`,
      persisted: persistedMap[PLAN_ID] as Record<string, unknown> | undefined,
      persistedMap,
      resolved: null,
      rehydrated: undefined,
    };
  }

  // Stage 6 — the cabinet's consumer, plus the panel's own response normalizer,
  // which is what the form re-reads after a successful save.
  return {
    rejectedBy: null,
    reason: null,
    persisted: persistedMap[PLAN_ID] as Record<string, unknown> | undefined,
    persistedMap,
    resolved: resolvePlanCardStyle(PLAN_ID, wire as unknown as Branding),
    rehydrated: panelSchemaModule.createInitialBrandingDraft({ planCardStyles: persistedMap })
      .planCardStyles[PLAN_ID],
  };
}

/** A round trip that reached the cabinet, so the resolved visual is present. */
interface SurvivedResult extends RoundTripResult {
  readonly resolved: ResolvedPlanCardStyle;
}

/** Round-trip one plan's draft, failing with the blamed stage when it does not survive. */
function survive(style: StyleDraft): SurvivedResult {
  const result = roundTrip({ [PLAN_ID]: style });
  expect(
    result.rejectedBy,
    `${JSON.stringify(style)} was refused by the ${result.rejectedBy}: ${result.reason}`,
  ).toBeNull();
  // A passing `expect` narrows nothing, and every caller reads the resolved
  // visual. Assert it here so an unreached stage 6 surfaces as this line rather
  // than as a property read on `null` somewhere below.
  expect(result.resolved).not.toBeNull();
  return result as SurvivedResult;
}

describe("per-plan tariff-card style round trip, panel → API → cabinet", () => {
  it("reaches both checkouts", () => {
    // The only case here that always runs. It says which mode the run is in and
    // fails outright in the one situation a skip would be a lie: the sibling
    // repo is present but something this file loads out of it is not.
    console.info(
      hasSibling
        ? `plan-card-style round trip: driving the panel at ${PANEL_REPO_PATH}`
        : `plan-card-style round trip: no sibling checkout at ${PANEL_REPO_PATH} — cases skip`,
    );
    if (hasSiblingRepo) {
      expect(
        missingModules,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but these are missing (a move, a rename, or a skipped install) — every case below is skipping instead of guarding`,
      ).toEqual([]);
    }
    // Anchors the cabinet half regardless of the sibling, so this file cannot
    // pass by having loaded nothing at all.
    expect(typeof resolvePlanCardStyle).toBe("function");
    expect(typeof describePublicConfigSnapshot).toBe("function");
  });

  describe.skipIf(!hasSibling)("gradient", () => {
    it("carries every preset swatch through unchanged", () => {
      const presets = panelPresets.CARD_GRADIENT_PRESETS;
      // Without this the loop could pass by iterating nothing.
      expect(presets.length).toBeGreaterThan(5);
      for (const preset of presets) {
        const result = survive({ gradient: preset.value });
        expect(result.persisted, `preset '${preset.id}'`).toEqual({ gradient: preset.value });
        expect(result.resolved.gradient, `preset '${preset.id}'`).toBe(preset.value);
      }
    });

    it("carries the 'from primary' button's output through unchanged", () => {
      const gradient = panelPresets.gradientFromPrimary("#22c55e");
      expect(gradient).toContain("linear-gradient");
      expect(survive({ gradient }).resolved.gradient).toBe(gradient);
    });

    it("carries both shapes the visual builder emits", () => {
      // `composeGradient` in `gradient-builder.tsx` produces exactly these two
      // forms — a `<angle>deg` linear stack and a centred radial one.
      for (const gradient of [
        "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
        "radial-gradient(circle at 50% 50%, #064e3b 0%, #7c3aed 55%, #22c55e 100%)",
      ]) {
        expect(survive({ gradient }).resolved.gradient).toBe(gradient);
      }
    });

    it("carries a hand-pasted gradient with colour functions and several layers", () => {
      const gradient =
        "linear-gradient(90deg, rgba(0,0,0,.5) 0%, #fff 100%), radial-gradient(circle, #111 0%, #222 100%)";
      expect(survive({ gradient }).resolved.gradient).toBe(gradient);
    });

    it("treats a cleared gradient box as no gradient, not as a failed save", () => {
      // The CSS readout is a free-text input; emptying it is how an operator
      // drops back to the auto gradient. It must not refuse the whole submit.
      const result = survive({ gradient: "", accent: "#22c55e" });
      expect(result.persisted).toEqual({ accent: "#22c55e" });
      expect(result.resolved.gradient).toBe(
        "linear-gradient(135deg, hsl(152 70% 22%), hsl(192 65% 32%))",
      );
    });

    it("still refuses a gradient that is not one", () => {
      // Half-typed CSS is an operator mistake worth naming, and the panel names
      // it. This case exists so the acceptance above cannot be read as "the
      // gradient check was removed".
      const result = roundTrip({ [PLAN_ID]: { gradient: "linear-grad" } });
      expect(result.rejectedBy).toBe("panel Zod schema");
      expect(result.reason).toContain(VALIDATION_MESSAGES.gradientInvalid);
    });
  });

  describe.skipIf(!hasSibling)("accent", () => {
    it("carries every hex length and case the colour input and the text box emit", () => {
      for (const accent of ["#fff", "#FFF", "#ffff", "#22c55e", "#22C55E", "#22c55eff", "#22C55EFF"]) {
        const result = survive({ accent });
        expect(result.persisted, accent).toEqual({ accent });
        expect(result.resolved.accent, accent).toBe(accent);
      }
    });

    it("treats a cleared accent box as no accent, keeping the rest of the entry", () => {
      // `setStyle` only deletes an entry when EVERY field is empty, so a plan
      // that also has a gradient keeps `accent: ''` in the draft. That is the
      // whole submit's problem if the schema refuses it, and it is how an
      // operator removes an accent.
      const result = survive({ gradient: "linear-gradient(90deg,#111,#222)", accent: "" });
      expect(result.persisted).toEqual({ gradient: "linear-gradient(90deg,#111,#222)" });
      expect(result.resolved.accent).toBeNull();
    });

    it("trims a pasted accent instead of refusing it", () => {
      const result = survive({ accent: "  #22c55e  " });
      expect(result.persisted).toEqual({ accent: "#22c55e" });
      expect(result.resolved.accent).toBe("#22c55e");
    });

    it("still refuses a half-typed colour", () => {
      for (const accent of ["#2", "22c55e", "#22c55", "#nothex"]) {
        const result = roundTrip({ [PLAN_ID]: { accent } });
        expect(result.rejectedBy, accent).toBe("panel Zod schema");
        expect(result.reason, accent).toContain(VALIDATION_MESSAGES.hexInvalid);
      }
    });
  });

  describe.skipIf(!hasSibling)("texture", () => {
    it("carries every preset the picker offers, and draws that preset in the cabinet", () => {
      const patterns = panelTexture.APP_BG_TEXTURE_PATTERNS;
      expect(patterns.length).toBeGreaterThan(4);

      // `patternSvg` in the cabinet falls back to `dots` for an id it does not
      // know, so a pattern the panel offers and the cabinet never heard of
      // would draw dots in silence rather than fail anything. Comparing the
      // rendered images is what makes that visible: two patterns resolving to
      // the same picture means one of them is the fallback.
      const drawn = new Map<string, string>();
      for (const texturePreset of patterns) {
        // Exactly what the picker patches: choosing a preset also clears any
        // uploaded image, because the image would otherwise win.
        const result = survive({ texturePreset, textureUrl: null });
        expect(result.persisted, texturePreset).toEqual({ texturePreset });
        expect(result.resolved.textureImage, texturePreset).toBeTruthy();
        drawn.set(texturePreset, result.resolved.textureImage as string);
      }
      expect(
        new Set(drawn.values()).size,
        `the cabinet draws the same image for two different presets, so at least one of ${[...drawn.keys()].join(", ")} is falling through to its 'dots' default`,
      ).toBe(patterns.length);
    });

    it("agrees with the cabinet's own renderer about what a preset looks like", () => {
      // The panel and the cabinet each hold a texture allowlist and neither can
      // import the other's. A pattern that exists on one side only is caught by
      // the previous case; this one checks the ids denote the same picture.
      for (const pattern of panelTexture.APP_BG_TEXTURE_PATTERNS) {
        const result = survive({ texturePreset: pattern, textureUrl: null });
        const expected = buildTextureCss({
          pattern: pattern as AppBackgroundTexture,
          color: result.resolved.accent ?? result.resolved.contrast.foreground,
          background: "transparent",
          scale: 18,
          opacity: 0.5,
        });
        expect(result.resolved.textureImage, pattern).toBe(expected.backgroundImage);
      }
    });

    it("clears the texture back to none", () => {
      // The "none" tile patches both fields at once.
      const result = survive({
        gradient: "linear-gradient(90deg,#111,#222)",
        texturePreset: null,
        textureUrl: null,
      });
      expect(result.persisted).toEqual({ gradient: "linear-gradient(90deg,#111,#222)" });
      expect(result.resolved.textureImage).toBeNull();
      expect(result.resolved.textureUrl).toBeNull();
    });

    it("carries every image URL shape the upload button and the URL box can produce", () => {
      for (const textureUrl of [
        "/uploads/branding/tex-9f2c.png",
        "https://cdn.example.com/textures/marble.webp",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      ]) {
        // The upload button patches the pair, clearing any preset behind it.
        const result = survive({ textureUrl, texturePreset: null });
        expect(result.persisted, textureUrl).toEqual({ textureUrl });
        expect(result.resolved.textureUrl, textureUrl).toBe(textureUrl);
      }
    });

    it("carries a gradient, an accent and an effect with no textureUrl key at all", () => {
      // The regression case. Every control except the texture picker patches an
      // entry that never mentions `textureUrl`, and a schema that requires the
      // key refuses the whole branding submit — which is what "the settings do
      // not save" looked like from the operator's chair.
      const result = survive({
        gradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
        accent: "#22c55e",
        cardEffect: "aurora",
        cardEffectProps: panelCatalog.getCardEffectDefaults("aurora"),
        cardEffectOpacity: 1,
      });
      expect(result.persisted?.gradient).toBe("linear-gradient(135deg, #064e3b 0%, #22c55e 100%)");
      expect(result.persisted?.accent).toBe("#22c55e");
      expect(result.persisted?.cardEffect).toBe("aurora");
    });
  });

  describe.skipIf(!hasSibling)("card effect", () => {
    it("carries an effect with the picker's own defaults", () => {
      for (const cardEffect of ["aurora", "silk", "snowfall", "wordGlobe", "antigravity"]) {
        const cardEffectProps = panelCatalog.getCardEffectDefaults(cardEffect);
        const result = survive({ cardEffect, cardEffectProps, cardEffectOpacity: 1 });
        expect(result.persisted, cardEffect).toEqual({
          cardEffect,
          cardEffectProps,
          cardEffectOpacity: 1,
        });
        expect(result.resolved.effect, cardEffect).toBe(cardEffect);
        expect(result.resolved.effectProps, cardEffect).toEqual(cardEffectProps);
      }
    });

    it("carries a changed effect together with the props that came with it", () => {
      // `onEffectChange` replaces the id AND the props in one patch; the two
      // must not be able to arrive out of step.
      const cardEffectProps = panelCatalog.getCardEffectDefaults("galaxy");
      const result = survive({
        cardEffect: "galaxy",
        cardEffectProps,
        cardEffectOpacity: 0.65,
      });
      expect(result.resolved.effect).toBe("galaxy");
      expect(result.resolved.effectProps).toEqual(cardEffectProps);
      expect(result.resolved.effectOpacity).toBe(0.65);
    });

    it("carries the opacity slider's steps, floating-point residue included", () => {
      // The slider is 0.05..1 by 0.05, and 0.05 steps do not land on exact
      // binary fractions. A bound written as an exclusive comparison, or a
      // rounding step anywhere in the chain, shows up here.
      for (const cardEffectOpacity of [0.05, 0.35000000000000003, 0.7000000000000001, 1]) {
        const result = survive({
          cardEffect: "aurora",
          cardEffectProps: panelCatalog.getCardEffectDefaults("aurora"),
          cardEffectOpacity,
        });
        expect(result.resolved.effectOpacity, String(cardEffectOpacity)).toBe(cardEffectOpacity);
      }
    });

    it("turns an effect back off without stranding its props", () => {
      // `onEffectChange('NONE')` patches `{ cardEffect: null, cardEffectProps:
      // undefined, cardEffectOpacity: undefined }`, and the undefined keys are
      // gone by the time the body is serialized.
      const result = survive({
        gradient: "linear-gradient(90deg,#111,#222)",
        cardEffect: null,
        cardEffectProps: undefined,
        cardEffectOpacity: undefined,
      });
      expect(result.persisted).toEqual({ gradient: "linear-gradient(90deg,#111,#222)" });
      expect(result.resolved.effect).toBe("NONE");
    });

    it("carries every effect the panel's catalog offers", () => {
      // The panel, the API's allow-list and the cabinet's guard each decide
      // about this id separately. An effect the picker offers and the API
      // silently drops is a card that reverts to a plain gradient with nothing
      // said; an id the cabinet's guard refused would take the whole snapshot
      // with it.
      const ids = Object.keys(panelCatalog.CARD_EFFECT_CATALOG);
      expect(ids.length).toBeGreaterThan(20);

      const lost = ids.filter((cardEffect) => {
        const result = roundTrip({
          [PLAN_ID]: {
            cardEffect,
            cardEffectProps: panelCatalog.getCardEffectDefaults(cardEffect),
            cardEffectOpacity: 1,
          },
        });
        return result.rejectedBy !== null || result.resolved?.effect !== cardEffect;
      });
      expect(lost, "effects the panel offers that do not reach the cabinet").toEqual([]);
    });
  });

  describe.skipIf(!hasSibling)("clearing and caps", () => {
    it("reverts a configured-then-cleared plan to auto instead of persisting an empty entry", () => {
      // `setStyle` deletes the entry once nothing is set, so the map arrives
      // without the plan at all — and it has to REPLACE the saved map, not be
      // merged into it, or the style the operator just removed comes straight
      // back on the next read.
      const result = roundTrip(
        {},
        { [PLAN_ID]: { gradient: "linear-gradient(90deg,#111,#222)", accent: "#22c55e" } },
      );
      expect(result.rejectedBy, result.reason ?? "").toBeNull();
      expect(result.persisted).toBeUndefined();
      expect(result.persistedMap).toEqual({});
      const resolved = result.resolved as ResolvedPlanCardStyle;
      expect(resolved.gradient).toBe("linear-gradient(135deg, hsl(152 70% 22%), hsl(192 65% 32%))");
      expect(resolved.accent).toBeNull();
    });

    it("submits nothing at all when no plan style was touched", () => {
      // Not a failure: an untouched field must never be re-submitted, and the
      // gate below turns an empty patch into a no-op on purpose. Asserted so
      // the stage-3 check above is understood to be reachable, and so a change
      // that started sending the whole map every save shows up here.
      const result = roundTrip({});
      expect(result.rejectedBy).toBe("changed-field gate");
    });

    it("persists no entry for a style whose every field is empty", () => {
      // Belt and braces for the line above: even if an all-empty entry did
      // reach the API — from an older client, or a hand-edited payload — it
      // must not be stored, or the plan would read as "custom" forever with
      // nothing to show for it.
      const result = roundTrip({
        [PLAN_ID]: { gradient: "", accent: "", texturePreset: null, textureUrl: null, cardEffect: null },
      });
      expect(result.rejectedBy).toBeNull();
      expect(result.persisted).toBeUndefined();
      expect(result.persistedMap).toEqual({});
    });

    it("carries a style map at the 500-entry cap", () => {
      const styles = Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [
          `plan_${index}`,
          { accent: "#22c55e", gradient: "linear-gradient(90deg,#111,#222)" },
        ]),
      );
      const result = roundTrip(styles);
      expect(result.rejectedBy).toBeNull();
      expect(Object.keys(result.persistedMap)).toHaveLength(500);
      expect(result.persistedMap["plan_499"]).toEqual({
        accent: "#22c55e",
        gradient: "linear-gradient(90deg,#111,#222)",
      });
    });

    it("refuses a style map over the cap in the panel, before anything is truncated", () => {
      // 501 entries means 501 configured plans, so this is a bound rather than
      // a situation. It is asserted because the two sides disagree about what
      // to do at it — the panel refuses, `readPlanCardStyles` would silently
      // keep the first 500 — and the panel refusing is the one an operator can
      // act on. A change that let the payload through would quietly drop
      // whichever plan came last in key order.
      const styles = Object.fromEntries(
        Array.from({ length: 501 }, (_, index) => [`plan_${index}`, { accent: "#22c55e" }]),
      );
      expect(roundTrip(styles).rejectedBy).toBe("panel Zod schema");
    });
  });

  describe.skipIf(!hasSibling)("returning to the form", () => {
    it("rebuilds the operator's own entry from the API response", () => {
      // After a save the form resets onto the response. If what comes back is
      // not what was sent, the operator sees their edit revert — which reads as
      // "it did not save" just as convincingly as a refused submit.
      const style = {
        gradient: "linear-gradient(135deg, #064e3b 0%, #22c55e 100%)",
        accent: "#22c55e",
        texturePreset: "carbon",
        cardEffect: "silk",
        cardEffectProps: panelCatalog.getCardEffectDefaults("silk"),
        cardEffectOpacity: 0.8,
      };
      const result = survive(style);
      expect(result.rehydrated).toEqual(result.persisted);
      expect(result.rehydrated).toEqual({
        gradient: style.gradient,
        accent: style.accent,
        texturePreset: style.texturePreset,
        cardEffect: style.cardEffect,
        cardEffectProps: style.cardEffectProps,
        cardEffectOpacity: style.cardEffectOpacity,
      });
    });
  });
});

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describePublicConfigSnapshot } from "../../src/application/ports/public-config-persistence.port";
import { resolveBrandingThemeMode, resolveIconEffect } from "@/types/branding";
import type { Branding } from "@/types/branding";

/**
 * One dashboard-icon decoration, carried from the panel control that set it to
 * the value the cabinet reads.
 *
 * WHY THIS EXISTS. The icon effects shipped, and the first operator to use them
 * reported that the panel saves and the cabinet does not change. Every stage was
 * already covered on its own — `dashboard-icon-decor.test.tsx` next door proves
 * the renderer, and the panel has its own schema tests — but every one of those
 * mocks `useBranding`, so the DELIVERY between them was guarded by nothing at
 * all. That is the same gap, in the same payload, that
 * `plan-card-styles-round-trip` was written for: "each of them was individually
 * covered, and the settings still did not save; the break was in the seam".
 *
 * Six modules across two repositories have to agree, and each can drop the
 * value on its own:
 *
 *   1. the panel's Zod schema        (rezeis-admin/web, `branding-form-schema`)
 *   2. the API's DTO validator       (rezeis-admin, `IsIconDecorMap`)
 *   3. the changed-field gate        (rezeis-admin, `extractUpdatedBrandingFields`)
 *   4. the persistence normalizer    (rezeis-admin, `readIconDecorMap`)
 *   5. the cabinet's snapshot guard  (reiwa, `describePublicConfigSnapshot`)
 *   6. the cabinet's theme resolver  (reiwa, `resolveBrandingThemeMode`)
 *
 * STAGE 5 IS THE DANGEROUS ONE and it is why this file checks a whole snapshot
 * rather than the field alone: the guard is all-or-nothing and first-rejection
 * wins. A single unusable value ANYWHERE in the branding payload discards the
 * entire snapshot, and the cabinet then serves the previous one indefinitely —
 * colours, logo, texts, icons and all — while the panel goes on reporting
 * successful saves. That has already happened once over `navItems`. An operator
 * seeing "nothing I change appears" is describing that failure, not this field.
 *
 * STAGE 6 IS THE QUIET ONE. `resolveBrandingThemeMode` rebuilds the branding
 * object when a theme variant exists, and it copies the visual subset
 * EXPLICITLY on purpose — an untrusted nested payload must not be able to
 * overwrite the root. Anything it forgets to carry is silently absent for every
 * operator who uses light/dark variants and present for everyone else, which is
 * as close to unreproducible as a bug gets.
 */

/** The sibling checkout itself: `<workspace>/rezeis/rezeis-admin/`. */
const PANEL_REPO_URL = new URL("../../../rezeis/rezeis-admin/", import.meta.url);
const panelPath = (relative: string): string =>
  fileURLToPath(new URL(relative, PANEL_REPO_URL));

const PANEL_REPO_PATH = fileURLToPath(PANEL_REPO_URL);

const PANEL_MODULES = {
  schema: "web/src/features/branding/branding-form-schema.ts",
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

interface ZodIssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

type DirtyPatchResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: { readonly issues: readonly ZodIssueLike[] } };

interface PanelDraft {
  readonly iconDecor: Record<string, Record<string, unknown> | undefined>;
}

interface PanelSchemaModule {
  createBrandingFormSchema(messages: Record<string, string>): unknown;
  createInitialBrandingDraft(input?: {
    readonly iconDecor?: Record<string, unknown>;
  }): PanelDraft;
  getBrandingChangedFields(values: unknown, baseline: unknown): Record<string, unknown>;
  createBrandingDirtyPatch(input: {
    readonly values: unknown;
    readonly dirtyFields: Record<string, unknown>;
    readonly schema: unknown;
  }): DirtyPatchResult;
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
    instance: object,
    options?: { readonly whitelist?: boolean },
  ): readonly ValidationErrorLike[];
}

let panelSchemaModule: PanelSchemaModule;
let panelDto: PanelDtoModule;
let panelPersistence: PanelPersistenceModule;
let classTransformer: ClassTransformerModule;
let classValidator: ClassValidatorModule;

if (hasSibling) {
  // `reflect-metadata` first: the DTO's decorators register against it.
  await import(/* @vite-ignore */ panelPath(PANEL_MODULES.reflectMetadata));
  panelSchemaModule = (await import(
    /* @vite-ignore */ panelPath(PANEL_MODULES.schema)
  )) as PanelSchemaModule;
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

const VALIDATION_MESSAGES = {
  hexInvalid: "hex-invalid",
  imageUrlInvalid: "image-url-invalid",
  gradientInvalid: "gradient-invalid",
} as const;

/** Exactly the five keys the panel's section offers and the cabinet reads. */
const ICON_KEYS = ["quests", "wheel", "bell", "buy", "promo"] as const;

interface RoundTripResult {
  /** Stage that refused the value, or `null` when it reached the cabinet. */
  readonly rejectedBy: string | null;
  readonly reason: string | null;
  /** What the API persisted. */
  readonly persisted: Record<string, unknown>;
  /** What the cabinet ends up reading, after the theme resolver. */
  readonly delivered: Record<string, { glyph?: string; effect?: string; color?: string }> | null;
}

/**
 * Push an `iconDecor` map through all six stages exactly as production does.
 *
 * `withThemeVariants` exists because stage 6 only runs its explicit rebuild
 * when a variant is present — an installation with a light/dark concept takes a
 * different code path from one without, and the field must survive both.
 */
function roundTrip(
  decor: Record<string, Record<string, unknown>>,
  saved: Record<string, Record<string, unknown>> = {},
  withThemeVariants = false,
): RoundTripResult {
  const schema = panelSchemaModule.createBrandingFormSchema(VALIDATION_MESSAGES);
  const baseline = panelSchemaModule.createInitialBrandingDraft({ iconDecor: saved });
  const values = { ...baseline, iconDecor: decor };

  // Stage 1 — the panel decides what is dirty and validates only that.
  const dirtyFields = panelSchemaModule.getBrandingChangedFields(values, baseline);
  const patch = panelSchemaModule.createBrandingDirtyPatch({ values, dirtyFields, schema });
  if (!patch.success) {
    return {
      rejectedBy: "panel Zod schema",
      reason: patch.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" | "),
      persisted: {},
      delivered: null,
    };
  }
  // The HTTP boundary, where a key set to `undefined` disappears.
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
      persisted: {},
      delivered: null,
    };
  }

  // Stage 3 — the changed-field gate. A field missing from it makes the whole
  // update a silent no-op: `200 OK`, nothing written.
  if (!Object.prototype.hasOwnProperty.call(instance, "iconDecor")) {
    return {
      rejectedBy: "changed-field gate",
      reason: "iconDecor is not an own property of the DTO instance, so the update is a no-op",
      persisted: {},
      delivered: null,
    };
  }

  // Stage 4 — persistence, merged over what was already stored.
  const stored = panelPersistence.mergeBrandingSettings({
    existing: { iconDecor: saved },
    patch: body,
  });
  const branding = panelPersistence.readBrandingSettings(stored);
  const wire = JSON.parse(JSON.stringify(branding)) as Record<string, unknown>;
  if (withThemeVariants) wire.themeVariants = deriveThemeVariants(wire);
  const persisted = (wire.iconDecor ?? {}) as Record<string, unknown>;

  // Stage 5 — the cabinet's guard, over a whole public config, because that is
  // the unit it accepts or discards.
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
      persisted,
      delivered: null,
    };
  }

  // Stage 6 — the theme resolver, which is the object `useIconDecor` reads.
  const effective = resolveBrandingThemeMode(wire as unknown as Branding, "dark");
  return {
    rejectedBy: null,
    reason: null,
    persisted,
    delivered: (effective.iconDecor ?? {}) as RoundTripResult["delivered"] extends null
      ? never
      : NonNullable<RoundTripResult["delivered"]>,
  };
}

/**
 * A light/dark pair built out of the branding the API just produced.
 *
 * Written this way rather than by hand because the cabinet's guard demands
 * sixteen specific fields of a variant, and a hand-made fixture would be
 * refused for the wrong reason — as the first draft of this file was, hiding
 * the case it exists to run. Copying the root's own values guarantees a variant
 * that is valid for exactly as long as the root is.
 */
function deriveThemeVariants(wire: Record<string, unknown>): Record<string, unknown> {
  const variant = Object.fromEntries(
    [
      "primary",
      "primaryFg",
      "bgPrimary",
      "bgSecondary",
      "cardGradient",
      "cardPattern",
      "cardEffect",
      "cardEffectProps",
      "cardEffectOpacity",
      "cardEffectsByIndex",
      "bgEffect",
      "appBackground",
      "borderRadius",
      "cornerRadii",
      "fontFamily",
      "surfaceTheme",
    ].map((key) => [key, wire[key]]),
  );
  return { light: variant, dark: variant };
}

/** Round-trip a decoration, failing with the blamed stage when it does not survive. */
function survive(
  decor: Record<string, Record<string, unknown>>,
  saved?: Record<string, Record<string, unknown>>,
  withThemeVariants = false,
): NonNullable<RoundTripResult["delivered"]> {
  const result = roundTrip(decor, saved, withThemeVariants);
  expect(
    result.rejectedBy,
    `${JSON.stringify(decor)} was refused by the ${result.rejectedBy}: ${result.reason}`,
  ).toBeNull();
  expect(result.delivered).not.toBeNull();
  return result.delivered as NonNullable<RoundTripResult["delivered"]>;
}

describe("dashboard icon decoration round trip, panel → API → cabinet", () => {
  it("reaches both checkouts", () => {
    console.info(
      hasSibling
        ? `icon-decor round trip: driving the panel at ${PANEL_REPO_PATH}`
        : `icon-decor round trip: no sibling checkout at ${PANEL_REPO_PATH} — cases skip`,
    );
    if (hasSiblingRepo) {
      expect(
        missingModules,
        `the rezeis-admin checkout is at ${PANEL_REPO_PATH} but these are missing (a move, a rename, or a skipped install) — every case below is skipping instead of guarding`,
      ).toEqual([]);
    }
    expect(typeof resolveBrandingThemeMode).toBe("function");
    expect(typeof describePublicConfigSnapshot).toBe("function");
  });

  describe.skipIf(!hasSibling)("the operator's actual edit", () => {
    it("carries an effect and a colour all the way to the cabinet", () => {
      // Verbatim the reported case: a glow on the quests icon and a pulse on
      // the cart, each with a fill colour.
      const delivered = survive({
        quests: { effect: "glow", color: "#f59e0b" },
        buy: { effect: "pulse", color: "#22c55e" },
      });
      expect(delivered.quests).toEqual({ effect: "glow", color: "#f59e0b" });
      expect(delivered.buy).toEqual({ effect: "pulse", color: "#22c55e" });
    });

    it("survives an installation that has light and dark variants", () => {
      // Stage 6 rebuilds the branding object field by field when a variant
      // exists. A field it forgets is absent for exactly those operators.
      const delivered = survive({ quests: { effect: "glow", color: "#f59e0b" } }, {}, true);
      expect(delivered.quests).toEqual({ effect: "glow", color: "#f59e0b" });
    });

    it.each(ICON_KEYS)("delivers the '%s' icon, which the cabinet reads by that exact key", (key) => {
      // The five keys are written in one repository and read in the other, with
      // nothing but agreement between them. A rename on either side lands here.
      const delivered = survive({ [key]: { effect: "pulse", color: "#ff0055" } });
      expect(delivered[key]).toEqual({ effect: "pulse", color: "#ff0055" });
    });

    it.each(["pulse", "shake", "glow"] as const)(
      "delivers the '%s' effect as something the cabinet can draw",
      (effect) => {
        // Both halves: the value survives the trip, AND the cabinet does not
        // clamp it away as unknown. A vocabulary that drifted apart would leave
        // the field delivered and the icon unchanged, which is the harder half
        // of this bug to see.
        const delivered = survive({ quests: { effect } });
        expect(delivered.quests?.effect).toBe(effect);
        expect(resolveIconEffect(delivered.quests?.effect)).toBe(effect);
      },
    );

    it("keeps an icon the operator did not touch", () => {
      // The panel submits only what differs from the baseline, and the API
      // merges. An operator adding a second icon must not clear the first.
      const delivered = survive(
        { quests: { effect: "glow" }, bell: { color: "#00aaff" } },
        { quests: { effect: "glow" } },
      );
      expect(delivered.quests).toEqual({ effect: "glow" });
      expect(delivered.bell).toEqual({ color: "#00aaff" });
    });

    it("clears an icon the operator reset", () => {
      // Resetting drops the entry entirely — a stored `{}` would read as
      // "configured" forever with nothing on screen to show for it.
      const result = roundTrip({}, { quests: { effect: "glow" } });
      expect(result.rejectedBy).toBeNull();
      expect(result.delivered).toEqual({});
    });
  });

  describe.skipIf(!hasSibling)("what would silently freeze the whole cabinet", () => {
    it("refuses a colour without its hash instead of storing nothing", () => {
      // `ff4081` is what a colour input yields if a `#` is dropped anywhere
      // along the way. The normalizer would drop it and answer `200 OK`, and
      // the operator would find the icon unchanged with nothing to point at.
      const result = roundTrip({ quests: { color: "ff4081" } });
      expect(result.rejectedBy).not.toBeNull();
    });

    it("does not let an unknown effect discard the snapshot", () => {
      // The panel ships ahead of the cabinet, so an effect named by a newer
      // panel MUST pass the guard and be clamped by the reader — refusing it at
      // stage 5 would freeze every other setting too.
      const delivered = survive({ quests: { effect: "supernova" } });
      expect(delivered.quests?.effect).toBe("supernova");
      expect(resolveIconEffect(delivered.quests?.effect)).toBe("none");
    });
  });
});

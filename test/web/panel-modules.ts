import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The sibling panel checkout, loaded by path so a round-trip test can drive the
 * real modules from the other repository.
 *
 * WHY A SHARED FILE. Two round-trip tests already carry their own copy of this
 * loader — `plan-card-styles-round-trip` and `icon-decor-round-trip` — because
 * each was written to chase one specific broken payload. A third copy is where
 * the boilerplate stops being incidental, so it lives here now; the two older
 * files are left alone rather than churned, and the next one should use this.
 *
 * Everything is loaded by absolute path at run time, so TypeScript knows
 * nothing about it. That is deliberate: `tsc` over this project has no idea the
 * panel exists, and a rename over there should break the RUN, loudly, at the
 * call that no longer resolves — which is the correct place for a cross-repo
 * break to appear.
 */

const PANEL_REPO_URL = new URL("../../../rezeis/rezeis-admin/", import.meta.url);

export const PANEL_REPO_PATH = fileURLToPath(PANEL_REPO_URL);

const panelPath = (relative: string): string =>
  fileURLToPath(new URL(relative, PANEL_REPO_URL));

/**
 * What a branding round trip has to load out of the panel.
 *
 * The `node_modules` entries are in the list on purpose: `class-validator` is
 * how the DTO stage runs at all, and an un-installed sibling would otherwise
 * surface as a stack trace from inside an import rather than as the one clear
 * message the caller prints.
 */
const PANEL_MODULES = {
  schema: "web/src/features/branding/branding-form-schema.ts",
  dto: "src/modules/settings/dto/update-branding-settings.dto.ts",
  persistence: "src/modules/settings/utils/branding-settings.util.ts",
  reflectMetadata: "node_modules/reflect-metadata",
  classTransformer: "node_modules/class-transformer",
  classValidator: "node_modules/class-validator",
} as const;

export const hasPanelRepo = existsSync(PANEL_REPO_PATH);
export const missingPanelModules = Object.values(PANEL_MODULES).filter(
  (relative) => !existsSync(panelPath(relative)),
);
export const hasPanel = hasPanelRepo && missingPanelModules.length === 0;

export interface ZodIssueLike {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type DirtyPatchResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: { readonly issues: readonly ZodIssueLike[] } };

export interface PanelSchemaModule {
  createBrandingFormSchema(messages: Record<string, string>): unknown;
  createInitialBrandingDraft(input?: Record<string, unknown>): Record<string, unknown>;
  getBrandingChangedFields(values: unknown, baseline: unknown): Record<string, unknown>;
  createBrandingDirtyPatch(input: {
    readonly values: unknown;
    readonly dirtyFields: Record<string, unknown>;
    readonly schema: unknown;
  }): DirtyPatchResult;
}

export interface PanelDtoModule {
  readonly UpdateBrandingSettingsDto: new () => object;
}

export interface PanelPersistenceModule {
  mergeBrandingSettings(input: {
    readonly existing: unknown;
    readonly patch: unknown;
  }): Record<string, unknown>;
  readBrandingSettings(value: unknown): Record<string, unknown>;
}

export interface ValidationErrorLike {
  readonly property: string;
  readonly constraints?: Record<string, string>;
}

export interface PanelBundle {
  readonly schema: PanelSchemaModule;
  readonly dto: PanelDtoModule;
  readonly persistence: PanelPersistenceModule;
  readonly plainToInstance: (cls: new () => object, plain: object) => object;
  readonly validateSync: (
    instance: object,
    options?: { readonly whitelist?: boolean; readonly forbidNonWhitelisted?: boolean },
  ) => readonly ValidationErrorLike[];
}

/** Loads the panel's branding modules. Only call it when `hasPanel` is true. */
export async function loadPanelBundle(): Promise<PanelBundle> {
  // `reflect-metadata` first: the DTO's decorators register against it.
  await import(/* @vite-ignore */ panelPath(PANEL_MODULES.reflectMetadata));
  const [schema, dto, persistence, transformer, validator] = await Promise.all([
    import(/* @vite-ignore */ panelPath(PANEL_MODULES.schema)),
    import(/* @vite-ignore */ panelPath(PANEL_MODULES.dto)),
    import(/* @vite-ignore */ panelPath(PANEL_MODULES.persistence)),
    import(/* @vite-ignore */ panelPath(PANEL_MODULES.classTransformer)),
    import(/* @vite-ignore */ panelPath(PANEL_MODULES.classValidator)),
  ]);
  return {
    schema: schema as PanelSchemaModule,
    dto: dto as PanelDtoModule,
    persistence: persistence as PanelPersistenceModule,
    plainToInstance: (transformer as { plainToInstance: PanelBundle["plainToInstance"] })
      .plainToInstance,
    validateSync: (validator as { validateSync: PanelBundle["validateSync"] }).validateSync,
  };
}

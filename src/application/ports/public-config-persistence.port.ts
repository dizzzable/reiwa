/**
 * Durable last-known-good storage for the public SPA bootstrap payload.
 *
 * The public config is fetched from rezeis-admin, but it must remain
 * available through a Reiwa restart while that upstream is unavailable.
 * Implementations are best-effort: a Redis failure must never prevent the
 * caller from serving an already-loaded snapshot or the first-boot defaults.
 */

/**
 * The stable minimum of the public-config contract. Additional fields are
 * preserved verbatim so adding an admin-side field does not make older Reiwa
 * snapshots unusable.
 */
export interface PublicConfigSnapshot {
  readonly branding: Readonly<Record<string, unknown>>;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly [key: string]: unknown;
}

export interface PublicConfigPersistencePort {
  /** Load a structurally-valid snapshot, or `null` if none is usable. */
  load(): Promise<PublicConfigSnapshot | null>;
  /** Save a structurally-valid, upstream-successful snapshot. */
  save(snapshot: PublicConfigSnapshot): Promise<void>;
}

/** No-op persistence for tests and Redis-free deployments. */
export const NOOP_PUBLIC_CONFIG_PERSISTENCE: PublicConfigPersistencePort = {
  load: async () => null,
  save: async () => undefined,
};

/**
 * Runtime structural validation shared by the route and durable adapter.
 *
 * This checks every structured field consumed by the SPA, while retaining
 * unknown fields for forward compatibility with rezeis-admin. The browser
 * snapshot reader reuses this guard so local and Redis persistence cannot
 * disagree about what is safe to render.
 */
export function isPublicConfigSnapshot(value: unknown): value is PublicConfigSnapshot {
  if (!isRecord(value) || !isRecord(value["branding"])) return false;

  const locales = value["locales"];
  const defaultLocale = value["defaultLocale"];
  if (
    !Array.isArray(locales) ||
    locales.length === 0 ||
    !locales.every(isNonEmptyString) ||
    !isNonEmptyString(defaultLocale) ||
    !locales.includes(defaultLocale)
  ) {
    return false;
  }

  const branding = value["branding"];
  return (
    isNonEmptyString(branding["brandName"]) &&
    hasOptionalStringOrNull(branding, "tagline") &&
    isNullableString(branding["logoUrl"]) &&
    hasOptionalStringOrNull(branding, "pwaIconUrl") &&
    isString(branding["primary"]) &&
    isString(branding["primaryFg"]) &&
    isString(branding["bgPrimary"]) &&
    isString(branding["bgSecondary"]) &&
    isString(branding["cardGradient"]) &&
    isNullableString(branding["cardPattern"]) &&
    isString(branding["cardLogo"]) &&
    isNullableString(branding["cardLogoUrl"]) &&
    isString(branding["cardEffect"]) &&
    isRecord(branding["cardEffectProps"]) &&
    isFiniteNumber(branding["cardEffectOpacity"]) &&
    Array.isArray(branding["cardEffectsByIndex"]) &&
    branding["cardEffectsByIndex"].every(isCardEffectSlot) &&
    isString(branding["bgEffect"]) &&
    hasOptionalAppBackground(branding, "appBackground") &&
    isString(branding["iconColorMode"]) &&
    isStringRecord(branding["iconColors"]) &&
    isString(branding["borderRadius"]) &&
    isString(branding["fontFamily"]) &&
    isString(value["defaultCurrency"]) &&
    Array.isArray(value["customIcons"]) &&
    value["customIcons"].every(isCustomIcon) &&
    hasOptionalNullableString(value, "botUsername") &&
    hasOptionalNullableString(value, "supportUsername") &&
    hasOptionalPlatformBranding(value, "platformBranding") &&
    hasOptionalBoolean(value, "emailEnabled") &&
    hasOptionalPlanCardStyles(branding, "planCardStyles") &&
    hasOptionalNavItems(branding, "navItems") &&
    hasOptionalFiniteNumber(branding, "navGap")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOptionalStringOrNull(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || typeof value === "string";
}

function hasOptionalNullableString(record: Record<string, unknown>, key: string): boolean {
  return hasOptionalStringOrNull(record, key);
}

function hasOptionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function hasOptionalRecord(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || isRecord(value);
}

function hasOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === "boolean";
}

function hasOptionalAppBackground(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (!isRecord(value) || !isRecord(value["texture"])) return false;

  const texture = value["texture"];
  return (
    isString(value["kind"]) &&
    isString(value["effect"]) &&
    isRecord(value["props"]) &&
    isFiniteNumber(value["opacity"]) &&
    isString(value["gradient"]) &&
    isString(texture["pattern"]) &&
    isString(texture["color"]) &&
    isString(texture["background"]) &&
    isFiniteNumber(texture["scale"]) &&
    isFiniteNumber(texture["opacity"])
  );
}

function hasOptionalPlanCardStyles(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (isRecord(value) && Object.values(value).every(isPlanCardStyle));
}

function hasOptionalNavItems(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (Array.isArray(value) && value.every(isNavItem));
}

function isCardEffectSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["cardEffect"]) &&
    isRecord(value["cardEffectProps"]) &&
    isFiniteNumber(value["cardEffectOpacity"]) &&
    hasOptionalStringOrNull(value, "cardGradient")
  );
}

function isPlanCardStyle(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOptionalStringOrNull(value, "gradient") &&
    hasOptionalStringOrNull(value, "accent") &&
    hasOptionalStringOrNull(value, "texturePreset") &&
    hasOptionalStringOrNull(value, "textureUrl") &&
    hasOptionalStringOrNull(value, "cardEffect") &&
    hasOptionalRecord(value, "cardEffectProps") &&
    hasOptionalNullableFiniteNumber(value, "cardEffectOpacity")
  );
}

function isNavItem(value: unknown): boolean {
  return isRecord(value) && isString(value["id"]) && typeof value["visible"] === "boolean";
}

function isCustomIcon(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isString(value["name"]) &&
    isString(value["url"]) &&
    (value["color"] === null || isString(value["color"]))
  );
}

function hasOptionalPlatformBranding(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return (
    value === undefined ||
    (isRecord(value) &&
      (value["projectName"] === null || isString(value["projectName"])) &&
      (value["webTitle"] === null || isString(value["webTitle"])))
  );
}

function hasOptionalNullableFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || isFiniteNumber(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

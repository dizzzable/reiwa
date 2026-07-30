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

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CARD_EFFECTS = new Set([
  "NONE",
  "aurora",
  "threads",
  "softAurora",
  "rippleGrid",
  "radar",
  "plasma",
  "particles",
  "liquidChrome",
  "lineWaves",
  "iridescence",
  "grainient",
  "galaxy",
  "balatro",
  "waves",
  "silk",
  "beams",
  "dither",
  "paperMesh",
  "paperWarp",
  "paperGrain",
  "paperDither",
  "paperSwirl",
  "paperMetaballs",
]);
const BG_EFFECTS = new Set(["NONE", "MESH", "PARTICLES", "NOISE", "AURORA"]);
const APP_BACKGROUND_KINDS = new Set(["none", "gradient", "texture", "effect"]);
const APP_BACKGROUND_TEXTURES = new Set([
  "dots",
  "grid",
  "diagonal",
  "cross",
  "waves",
  "carbon",
  "triangles",
  "noise",
]);
const ICON_COLOR_MODES = new Set(["default", "theme", "custom"]);
const BORDER_RADII = new Set([
  "rounded-none",
  "rounded-lg",
  "rounded-xl",
  "rounded-2xl",
  "rounded-3xl",
  "rounded-full",
]);
const NAV_DESTINATIONS = new Set([
  "subscriptions",
  "plans",
  "referrals",
  "devices",
  "activity",
  "promo",
  "support",
  "faq",
  "settings",
]);
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DATA_IMAGE_BASE64_PATTERN =
  /^data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=]+$/i;
const BRANDING_UPLOAD_PATTERN =
  /^\/uploads\/branding\/(?![A-Za-z0-9._-]*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_IMAGE_URL_LENGTH = 524_288;
const MAX_CSS_IMAGE_LENGTH = 8_192;

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
    hasOptionalPresetId(branding, "themePresetId") &&
    hasOptionalPresetVersion(branding, "themePresetVersion") &&
    isNonEmptyString(branding["brandName"]) &&
    hasOptionalStringOrNull(branding, "tagline") &&
    isNullableImageUrl(branding["logoUrl"]) &&
    hasOptionalImageUrlOrNull(branding, "pwaIconUrl") &&
    isHex(branding["primary"]) &&
    isHex(branding["primaryFg"]) &&
    isHex(branding["bgPrimary"]) &&
    isHex(branding["bgSecondary"]) &&
    isSafeGradient(branding["cardGradient"]) &&
    isNullableSafeGradient(branding["cardPattern"]) &&
    isString(branding["cardLogo"]) &&
    isNullableImageUrl(branding["cardLogoUrl"]) &&
    isAllowedString(branding["cardEffect"], CARD_EFFECTS) &&
    isRecord(branding["cardEffectProps"]) &&
    isNumberInRange(branding["cardEffectOpacity"], 0.05, 1) &&
    Array.isArray(branding["cardEffectsByIndex"]) &&
    branding["cardEffectsByIndex"].length <= 20 &&
    branding["cardEffectsByIndex"].every(isCardEffectSlot) &&
    isAllowedString(branding["bgEffect"], BG_EFFECTS) &&
    hasOptionalAppBackground(branding, "appBackground") &&
    isAllowedString(branding["iconColorMode"], ICON_COLOR_MODES) &&
    isHexRecord(branding["iconColors"]) &&
    isAllowedString(branding["borderRadius"], BORDER_RADII) &&
    hasOptionalCornerRadii(branding, "cornerRadii") &&
    isString(branding["fontFamily"]) &&
    hasOptionalSurfaceTheme(branding, "surfaceTheme") &&
    isString(value["defaultCurrency"]) &&
    Array.isArray(value["customIcons"]) &&
    value["customIcons"].every(isCustomIcon) &&
    hasOptionalNullableString(value, "botUsername") &&
    hasOptionalNullableString(value, "supportUsername") &&
    hasOptionalPlatformBranding(value, "platformBranding") &&
    hasOptionalBoolean(value, "emailEnabled") &&
    hasOptionalPlanCardStyles(branding, "planCardStyles") &&
    hasOptionalNavItems(branding, "navItems") &&
    hasOptionalNumberInRange(branding, "navGap", 0, 24)
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

function hasOptionalNumberInRange(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): boolean {
  const value = record[key];
  return value === undefined || isNumberInRange(value, minimum, maximum);
}

function hasOptionalRecord(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || isRecord(value);
}

function hasOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === "boolean";
}

function hasOptionalCornerRadii(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return (
    value === undefined ||
    (isRecord(value) &&
      isNumberInRange(value["cardPx"], 0, 48) &&
      isNumberInRange(value["itemPx"], 0, 32) &&
      isNumberInRange(value["pillPx"], 0, 9999))
  );
}

function hasOptionalAppBackground(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (!isRecord(value)) return false;

  const effect = value["effect"];
  const kind =
    value["kind"] === undefined && isAllowedString(effect, CARD_EFFECTS)
      ? effect === "NONE"
        ? "none"
        : "effect"
      : value["kind"];
  const texture = value["texture"];
  const textureIsValid =
    texture === undefined
      ? kind !== "texture"
      : isAppBackgroundTexture(texture);

  return (
    isAllowedString(kind, APP_BACKGROUND_KINDS) &&
    isAllowedString(effect, CARD_EFFECTS) &&
    isRecord(value["props"]) &&
    isNumberInRange(value["opacity"], 0.05, 1) &&
    isSafeGradient(value["gradient"]) &&
    textureIsValid
  );
}

function isAppBackgroundTexture(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAllowedString(value["pattern"], APP_BACKGROUND_TEXTURES) &&
    isHex(value["color"]) &&
    isHex(value["background"]) &&
    isNumberInRange(value["scale"], 8, 256) &&
    isNumberInRange(value["opacity"], 0.05, 1)
  );
}

function hasOptionalPlanCardStyles(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 500 &&
    entries.every(
      ([planId, style]) =>
        planId.length > 0 && planId.length <= 64 && isPlanCardStyle(style),
    )
  );
}

function hasOptionalNavItems(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > NAV_DESTINATIONS.size || !value.every(isNavItem)) {
    return false;
  }
  const ids = value.map((item) => (item as Record<string, unknown>)["id"]);
  const visibleCount = value.filter(
    (item) => (item as Record<string, unknown>)["visible"] === true,
  ).length;
  return new Set(ids).size === ids.length && visibleCount <= 5;
}

function isCardEffectSlot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAllowedString(value["cardEffect"], CARD_EFFECTS) &&
    isRecord(value["cardEffectProps"]) &&
    isNumberInRange(value["cardEffectOpacity"], 0.05, 1) &&
    hasOptionalSafeGradientOrNull(value, "cardGradient")
  );
}

function isPlanCardStyle(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOptionalSafeGradientOrNull(value, "gradient") &&
    hasOptionalHexOrNull(value, "accent") &&
    hasOptionalAllowedStringOrNull(value, "texturePreset", APP_BACKGROUND_TEXTURES) &&
    hasOptionalImageUrlOrNull(value, "textureUrl") &&
    hasOptionalAllowedStringOrNull(value, "cardEffect", CARD_EFFECTS) &&
    hasOptionalRecord(value, "cardEffectProps") &&
    hasOptionalNullableNumberInRange(value, "cardEffectOpacity", 0.05, 1)
  );
}

function isNavItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAllowedString(value["id"], NAV_DESTINATIONS) &&
    typeof value["visible"] === "boolean"
  );
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

function hasOptionalNullableNumberInRange(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): boolean {
  const value = record[key];
  return value === undefined || value === null || isNumberInRange(value, minimum, maximum);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

/**
 * Accept only CSS gradient image values. Public snapshots may live in Redis
 * and localStorage, so no persisted field is allowed to trigger an external
 * CSS image request after React mounts. Multiple gradient layers and nested
 * colour functions remain supported.
 */
export function isSafeGradient(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const input = value.trim();
  if (
    input.length === 0 ||
    input.length > MAX_CSS_IMAGE_LENGTH ||
    /(?:url|image-set|-webkit-image-set|cross-fade|element|paint)\s*\(/i.test(input) ||
    /[;{}@\\]/.test(input) ||
    /\/\*|\*\//.test(input) ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    return false;
  }

  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    const match = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(/i.exec(
      input.slice(index),
    );
    if (!match) return false;
    index += match[0].length;

    let depth = 1;
    while (index < input.length && depth > 0) {
      const character = input[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      index += 1;
    }
    if (depth !== 0) return false;

    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    if (index === input.length) return true;
    if (input[index] !== ",") return false;
    index += 1;
  }
  return false;
}

function isNullableSafeGradient(value: unknown): value is string | null {
  return value === null || value === "none" || isSafeGradient(value);
}

function hasOptionalSafeGradientOrNull(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || value === null || value === "none" || isSafeGradient(value);
}

function isHexRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 100 &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 && key.length <= 64 && isHex(entry),
    )
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): boolean {
  return isFiniteNumber(value) && value >= minimum && value <= maximum;
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_PATTERN.test(value.trim());
}

function hasOptionalHexOrNull(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || value === null || isHex(value);
}

function hasOptionalImageUrlOrNull(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || isNullableImageUrl(value);
}

function isNullableImageUrl(value: unknown): boolean {
  return value === null || (typeof value === "string" && isAllowedImageUrl(value));
}

function isAllowedImageUrl(value: string): boolean {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IMAGE_URL_LENGTH
  ) {
    return false;
  }
  if (
    DATA_IMAGE_BASE64_PATTERN.test(normalized) ||
    BRANDING_UPLOAD_PATTERN.test(normalized)
  ) {
    return true;
  }
  try {
    const parsed = new URL(normalized);
    return (
      // Rezeis rejects new plain-HTTP writes. Keep reading legacy HTTP
      // snapshots so one old logo cannot invalidate the entire durable
      // last-known-good payload during migration.
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function isAllowedString(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function hasOptionalAllowedStringOrNull(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): boolean {
  const value = record[key];
  return value === undefined || value === null || isAllowedString(value, allowed);
}

function hasOptionalPresetId(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && PRESET_ID_PATTERN.test(value))
  );
}

function hasOptionalPresetVersion(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 2_147_483_647)
  );
}

function hasOptionalSurfaceTheme(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isHex(value["foreground"]) &&
    isHex(value["mutedForeground"]) &&
    isHex(value["surface"]) &&
    isHex(value["surfaceHigh"]) &&
    isHex(value["borderSoft"]) &&
    isHex(value["borderStrong"]) &&
    isNumberInRange(value["surfaceOpacity"], 0, 1) &&
    isNumberInRange(value["surfaceHighOpacity"], 0, 1) &&
    isNumberInRange(value["borderSoftOpacity"], 0, 1) &&
    isNumberInRange(value["borderStrongOpacity"], 0, 1) &&
    isNumberInRange(value["glassBlurPx"], 0, 40)
  );
}

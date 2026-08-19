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
// The card-effect vocabulary that used to live here is gone on purpose; see
// `isEffectId`. It was the only enum in this guard that rezeis-admin extends on
// its own release cadence, and keeping a copy of it here made every such
// extension a silent outage. `bgEffect` below is a closed legacy set that has
// not gained a member since it was introduced, so it stays checked.
const BG_EFFECTS = new Set(["NONE", "MESH", "PARTICLES", "NOISE", "AURORA"]);
// `appBackground.kind` used to be a Set here too, and it is gone for the same
// reason the card-effect vocabulary is — see `isAppBackgroundKind`.
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
const SUBSCRIPTION_CARD_TEXT_MODES = new Set([
  "auto",
  "light",
  "dark",
  "custom",
]);
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
 * Why a snapshot was rejected: which key failed, and what was actually there.
 *
 * `found` is deliberately lossy — a type, a length, a bounded literal for
 * short scalars. Enough to recognise a stale enum member or an out-of-range
 * number at a glance, never enough to spill a logo data-URL, a gradient stack
 * or the operator's whole payload into the log.
 */
export interface PublicConfigRejection {
  /** Dotted path of the offending key, e.g. `branding.navItems`. */
  readonly key: string;
  /** Stable machine-readable cause, e.g. `not-an-allowed-value`. */
  readonly reason: string;
  /** Redacted description of the offending value. */
  readonly found: string;
}

/**
 * Runtime structural validation shared by the route and durable adapter.
 *
 * This checks every structured field consumed by the SPA, while retaining
 * unknown fields for forward compatibility with rezeis-admin. The browser
 * snapshot reader reuses this guard so local and Redis persistence cannot
 * disagree about what is safe to render.
 *
 * All-or-nothing is deliberate: half-applied branding looks worse than the
 * previous theme, so one bad key still discards the whole payload. What was
 * NOT deliberate is doing it in silence. The rejection used to be a bare
 * `false`; the caller threw, the cabinet went on serving the last stored
 * snapshot for as long as the bad key survived, and nothing in the log ever
 * named it. `describePublicConfigSnapshot` is the same decision with a reason
 * attached, and this is its boolean face — it accepts exactly the same set of
 * values, field for field.
 */
export function isPublicConfigSnapshot(value: unknown): value is PublicConfigSnapshot {
  return describePublicConfigSnapshot(value) === null;
}

/**
 * The guard above, but naming the first failing key instead of returning
 * `false`. Checks run in the original short-circuit order, so the blamed key
 * is the first one a reader of the old `&&` chain would have reached.
 *
 * Keep this module free of I/O — the browser bundle imports it too. The
 * reason is handed back to the caller; nothing is logged from here.
 */
export function describePublicConfigSnapshot(
  value: unknown,
): PublicConfigRejection | null {
  if (!isRecord(value)) return reject("<root>", "not-an-object", value);
  if (!isRecord(value["branding"])) {
    return reject("branding", "not-an-object", value["branding"]);
  }

  const locales = value["locales"];
  if (!Array.isArray(locales)) return reject("locales", "not-an-array", locales);
  if (locales.length === 0) return reject("locales", "empty", locales);
  if (!locales.every(isNonEmptyString)) {
    return reject("locales", "contains-a-blank-entry", locales);
  }

  const defaultLocale = value["defaultLocale"];
  if (!isNonEmptyString(defaultLocale)) {
    return reject("defaultLocale", "not-a-non-empty-string", defaultLocale);
  }
  if (!locales.includes(defaultLocale)) {
    return reject("defaultLocale", "not-listed-in-locales", defaultLocale);
  }

  const branding = value["branding"];
  const inBranding = (
    key: string,
    reason: string,
    ok: boolean,
  ): PublicConfigRejection | null =>
    ok ? null : reject(`branding.${key}`, reason, branding[key]);
  const inRoot = (
    key: string,
    reason: string,
    ok: boolean,
  ): PublicConfigRejection | null => (ok ? null : reject(key, reason, value[key]));

  return firstRejection([
    () => inBranding("themePresetId", "not-a-preset-id", hasOptionalPresetId(branding, "themePresetId")),
    () => inBranding("themePresetVersion", "not-a-preset-version", hasOptionalPresetVersion(branding, "themePresetVersion")),
    () => inBranding("themeModePolicy", "not-an-allowed-value", hasOptionalThemeModePolicy(branding, "themeModePolicy")),
    () => inBranding("themeDefaultMode", "not-an-allowed-value", hasOptionalThemeDefaultMode(branding, "themeDefaultMode")),
    () => inBranding("themeVariants", "not-a-valid-theme-variant-pair", hasOptionalThemeVariants(branding, "themeVariants")),
    () => inBranding("brandName", "not-a-non-empty-string", isNonEmptyString(branding["brandName"])),
    () => inBranding("tagline", "not-a-string-or-null", hasOptionalStringOrNull(branding, "tagline")),
    () => inBranding("logoUrl", "not-an-allowed-image-url", isNullableImageUrl(branding["logoUrl"])),
    () => inBranding("pwaIconUrl", "not-an-allowed-image-url", hasOptionalImageUrlOrNull(branding, "pwaIconUrl")),
    () => inBranding("primary", "not-a-hex-colour", isHex(branding["primary"])),
    () => inBranding("primaryFg", "not-a-hex-colour", isHex(branding["primaryFg"])),
    () => inBranding("bgPrimary", "not-a-hex-colour", isHex(branding["bgPrimary"])),
    () => inBranding("bgSecondary", "not-a-hex-colour", isHex(branding["bgSecondary"])),
    () => inBranding("brandPaletteSource", "not-an-allowed-value", hasOptionalOwnershipSource(branding, "brandPaletteSource")),
    () => inBranding("cardGradient", "not-a-safe-css-gradient", isSafeGradient(branding["cardGradient"])),
    () => inBranding("cardGradientSource", "not-an-allowed-value", hasOptionalOwnershipSource(branding, "cardGradientSource")),
    () => inBranding("cardPattern", "not-a-safe-css-gradient-or-null", isNullableSafeGradient(branding["cardPattern"])),
    () => inBranding("subscriptionCardText", "not-a-valid-card-text-policy", hasOptionalSubscriptionCardText(branding, "subscriptionCardText")),
    () =>
      hasConsistentVariantSubscriptionCardText(branding)
        ? null
        : reject(
            "branding.themeVariants.subscriptionCardText",
            "does-not-match-the-root-card-text-policy",
            branding["themeVariants"],
          ),
    () => inBranding("subscriptionCardGlass", "not-a-valid-glass-layer", hasOptionalSubscriptionCardGlass(branding, "subscriptionCardGlass")),
    // `brandLogo` and `cardLogoStyle` are deliberately absent from this list.
    // A failing check here discards the ENTIRE branding payload — name,
    // palette, navigation — and both are decorative numbers that the SPA
    // clamps at the point of use (`resolveBrandLogo`, `resolveCardLogoStyle`
    // in `web/src/types/branding.ts`). A malformed one costs a default-looking
    // logo; rejecting the snapshot over it would cost the operator their whole
    // identity. Do not "complete" the list.
    () => inBranding("cardLogo", "not-a-string", isString(branding["cardLogo"])),
    () => inBranding("cardLogoUrl", "not-an-allowed-image-url", isNullableImageUrl(branding["cardLogoUrl"])),
    () => inBranding("cardEffect", "not-an-effect-id", isEffectId(branding["cardEffect"])),
    () => inBranding("cardEffectProps", "not-an-object", isRecord(branding["cardEffectProps"])),
    () => inBranding("cardEffectOpacity", "out-of-range[0.05..1]", isNumberInRange(branding["cardEffectOpacity"], 0.05, 1)),
    () => describeCardEffectSlots(branding),
    () => inBranding("bgEffect", "not-an-allowed-value", isAllowedString(branding["bgEffect"], BG_EFFECTS)),
    () => inBranding("appBackground", "not-a-valid-app-background", hasOptionalAppBackground(branding, "appBackground")),
    () => inBranding("iconColorMode", "not-an-allowed-value", isAllowedString(branding["iconColorMode"], ICON_COLOR_MODES)),
    () => inBranding("iconColors", "not-a-hex-colour-map", isHexRecord(branding["iconColors"])),
    () => inBranding("borderRadius", "not-an-allowed-value", isAllowedString(branding["borderRadius"], BORDER_RADII)),
    () => inBranding("cornerRadii", "not-a-valid-corner-radius-set", hasOptionalCornerRadii(branding, "cornerRadii")),
    () => inBranding("fontFamily", "not-a-string", isString(branding["fontFamily"])),
    () => inBranding("surfaceTheme", "not-a-valid-surface-theme", hasOptionalSurfaceTheme(branding, "surfaceTheme")),
    () => inRoot("defaultCurrency", "not-a-string", isString(value["defaultCurrency"])),
    () => describeCustomIcons(value),
    () => inRoot("botUsername", "not-a-string-or-null", hasOptionalNullableString(value, "botUsername")),
    () => inRoot("supportUsername", "not-a-string-or-null", hasOptionalNullableString(value, "supportUsername")),
    () => inRoot("platformBranding", "not-a-valid-platform-branding", hasOptionalPlatformBranding(value, "platformBranding")),
    () => inRoot("emailEnabled", "not-a-boolean", hasOptionalBoolean(value, "emailEnabled")),
    () => inBranding("planCardStyles", "not-a-valid-plan-card-style-map", hasOptionalPlanCardStyles(branding, "planCardStyles")),
    () => describeNavItems(branding),
    () => inBranding("navGap", "out-of-range[0..24]", hasOptionalNumberInRange(branding, "navGap", 0, 24)),
  ]);
}

function reject(
  key: string,
  reason: string,
  value: unknown,
  found?: string,
): PublicConfigRejection {
  return { key, reason, found: found ?? describeValue(value) };
}

function firstRejection(
  checks: readonly (() => PublicConfigRejection | null)[],
): PublicConfigRejection | null {
  for (const run of checks) {
    const rejection = run();
    if (rejection !== null) return rejection;
  }
  return null;
}

/** Longest string reproduced verbatim in a rejection. */
const MAX_QUOTED_VALUE_LENGTH = 32;

/**
 * A bounded, non-identifying description of a value.
 *
 * Short scalars travel verbatim because that is what makes a rejection
 * actionable — `"rounded-md"` or `0` names the mistake outright. Anything
 * longer or structured collapses to a shape, so a logo data-URL, a gradient
 * stack or a whole branding record can never reach the log through here.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  switch (typeof value) {
    case "string":
      return value.length <= MAX_QUOTED_VALUE_LENGTH
        ? `string "${redactForLog(value)}"`
        : `string(length=${value.length})`;
    case "number":
      return `number ${String(value)}`;
    case "boolean":
      return `boolean ${String(value)}`;
    case "object":
      return `object(keys=${Object.keys(value as object).length})`;
    default:
      return typeof value;
  }
}

/** Neutralise control characters and quotes so a value cannot forge a log line. */
function redactForLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f"\\]/g, ".");
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

/**
 * Shared shape of the `concept | custom` discriminators that say who owns a
 * visual — the brand palette and the card gradient today.
 *
 * These are the fields that decide whether the root value or the concept's
 * per-brightness snapshot is drawn, so a garbled one silently repaints the
 * whole cabinet rather than breaking loudly. Snapshots written before either
 * control existed omit the key entirely and keep resolving as `concept`,
 * exactly as they did before; anything present but outside the pair is a
 * corrupt snapshot and must not be served.
 */
function hasOptionalOwnershipSource(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || value === "concept" || value === "custom";
}

function hasOptionalSubscriptionCardText(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    !isAllowedString(value["mode"], SUBSCRIPTION_CARD_TEXT_MODES)
  ) {
    return false;
  }
  // Custom card copy has no meaningful safe default colour. Rejecting an
  // incomplete snapshot lets the durable last-known-good config continue
  // serving instead of silently changing what the operator selected.
  return value["mode"] === "custom"
    ? isOpaqueHex(value["color"])
    : value["color"] === null;
}

/**
 * Glass is a root-level card presentation control, never a brightness token.
 * Keep the validation intentionally strict so a corrupt cache cannot place an
 * opaque/expensive layer over every animated card.
 */
function hasOptionalSubscriptionCardGlass(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value["enabled"] === "boolean" &&
      isOpaqueHex(value["tint"]) &&
      isNumberInRange(value["opacity"], 0, 1) &&
      isNumberInRange(value["blurPx"], 0, 40) &&
      isNumberInRange(value["borderOpacity"], 0, 1))
  );
}

/**
 * Card text is a global operator policy, not a light/dark concept token.
 * Variants written before the control existed omit it and intentionally fall
 * back to the root. New snapshots may include a transport copy, but it must
 * be exactly the root value or the snapshot is unsafe to serve.
 */
function hasConsistentVariantSubscriptionCardText(
  branding: Record<string, unknown>,
): boolean {
  const variants = branding["themeVariants"];
  if (variants === undefined || variants === null) return true;
  if (!isRecord(variants)) return false;

  const root = branding["subscriptionCardText"];
  if (root === undefined) {
    // Pre-control snapshots did not carry the field anywhere. A variant-only
    // value cannot be a valid legacy fallback because there is no global
    // operator source to inherit.
    return [variants["light"], variants["dark"]].every(
      (variant) => isRecord(variant) && variant["subscriptionCardText"] === undefined,
    );
  }
  const rootText = readSubscriptionCardText(root);
  if (rootText === null) return false;

  return [variants["light"], variants["dark"]].every((variant) => {
    if (!isRecord(variant)) return false;
    const candidate = variant["subscriptionCardText"];
    if (candidate === undefined) return true;
    const candidateText = readSubscriptionCardText(candidate);
    if (candidateText === null) return false;
    return (
      candidateText.mode === rootText.mode &&
      candidateText.color === rootText.color
    );
  });
}

function readSubscriptionCardText(
  value: unknown,
): { readonly mode: string; readonly color: string | null } | null {
  if (!isRecord(value) || !isAllowedString(value["mode"], SUBSCRIPTION_CARD_TEXT_MODES)) {
    return null;
  }
  if (value["mode"] === "custom") {
    return isOpaqueHex(value["color"])
      ? { mode: value["mode"], color: value["color"].trim() }
      : null;
  }
  return value["color"] === null ? { mode: value["mode"], color: null } : null;
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
    value["kind"] === undefined && isEffectId(effect)
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
    isAppBackgroundKind(kind) &&
    isEffectId(effect) &&
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

function describeNavItems(branding: Record<string, unknown>): PublicConfigRejection | null {
  const value = branding["navItems"];
  if (value === undefined) return null;
  if (!Array.isArray(value)) return reject("branding.navItems", "not-an-array", value);
  if (value.length > NAV_DESTINATIONS.size) {
    return reject(
      "branding.navItems",
      `too-many-entries[max=${NAV_DESTINATIONS.size}]`,
      value,
    );
  }
  const invalid = value.findIndex((item) => !isNavItem(item));
  if (invalid !== -1) {
    return reject(`branding.navItems[${invalid}]`, "not-a-valid-nav-item", value[invalid]);
  }
  const ids = value.map((item) => (item as Record<string, unknown>)["id"]);
  const unique = new Set(ids).size;
  if (unique !== ids.length) {
    return reject(
      "branding.navItems",
      "duplicate-destination-id",
      value,
      `array(length=${ids.length}, unique=${unique})`,
    );
  }
  // NO VISIBLE-COUNT LIMIT HERE, DELIBERATELY. There used to be one, and it
  // rejected payloads the panel is entitled to send.
  //
  // rezeis-admin's `readNavItems` caps non-essential destinations at five, but
  // the two essentials (`subscriptions`, `settings`) are FORCED visible and
  // EXEMPT from the cap while still counting toward it. Order the essentials
  // last and the cap hides nothing: five non-essentials plus two essentials
  // leaves SEVEN visible. (Its own suite asserts `<= 6`, which is the number
  // you get for one particular ordering, not the bound.) An operator who merely
  // dragged `settings` down the list therefore produced a snapshot this guard
  // threw away — and throwing it away freezes the cabinet's entire appearance
  // on the previous snapshot, indefinitely.
  //
  // The deeper mistake was the category. How many items crowd a bottom nav bar
  // is a LAYOUT question, and the answer is "it looks tight". Structural
  // validity is what this guard decides, and its verdict costs the operator
  // every colour, gradient and effect they have ever configured. A rule whose
  // worst case is a crowded bar must never be enforced with that penalty.
  // What genuinely makes `navItems` unusable is checked above and still is:
  // wrong shape, unknown destination, duplicate id, more entries than
  // destinations exist.
  return null;
}

function describeCardEffectSlots(
  branding: Record<string, unknown>,
): PublicConfigRejection | null {
  const slots = branding["cardEffectsByIndex"];
  if (!Array.isArray(slots)) {
    return reject("branding.cardEffectsByIndex", "not-an-array", slots);
  }
  if (slots.length > 20) {
    return reject("branding.cardEffectsByIndex", "too-many-entries[max=20]", slots);
  }
  const index = slots.findIndex((slot) => !isCardEffectSlot(slot));
  return index === -1
    ? null
    : reject(
        `branding.cardEffectsByIndex[${index}]`,
        "not-a-valid-card-effect-slot",
        slots[index],
      );
}

function describeCustomIcons(value: Record<string, unknown>): PublicConfigRejection | null {
  const icons = value["customIcons"];
  if (!Array.isArray(icons)) return reject("customIcons", "not-an-array", icons);
  const index = icons.findIndex((icon) => !isCustomIcon(icon));
  return index === -1
    ? null
    : reject(`customIcons[${index}]`, "not-a-valid-custom-icon", icons[index]);
}

function isCardEffectSlot(value: unknown): boolean {
  if (!isRecord(value) || !hasOptionalSafeGradientOrNull(value, "cardGradient")) {
    return false;
  }
  const mode = value["mode"];
  if (mode !== undefined && mode !== "inherit" && mode !== "override") {
    return false;
  }
  // `inherit` is intentionally lightweight. A legacy slot without a mode is
  // rendered as inherit, but must still be structurally complete; otherwise
  // one malformed stale field could make the complete public config invalid.
  if (mode === "inherit") return true;
  return (
    isEffectId(value["cardEffect"]) &&
    isRecord(value["cardEffectProps"]) &&
    isNumberInRange(value["cardEffectOpacity"], 0.05, 1)
  );
}

function isPlanCardStyle(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOptionalSafeGradientOrNull(value, "gradient") &&
    hasOptionalHexOrNull(value, "accent") &&
    hasOptionalAllowedStringOrNull(value, "texturePreset", APP_BACKGROUND_TEXTURES) &&
    hasOptionalImageUrlOrNull(value, "textureUrl") &&
    hasOptionalEffectIdOrNull(value, "cardEffect") &&
    hasOptionalRecord(value, "cardEffectProps") &&
    hasOptionalNullableNumberInRange(value, "cardEffectOpacity", 0.05, 1) &&
    hasOptionalPlanCardText(value, "text")
  );
}

/**
 * Per-plan card text policy. Absent (or null) is the overwhelmingly common
 * case — it means "inherit the global `subscriptionCardText`" and it is the
 * shape of every entry written before the control existed.
 *
 * DELIBERATELY LOOSER THAN `hasOptionalSubscriptionCardText`, in two places,
 * and the asymmetry is the point rather than an oversight:
 *
 *   - an UNKNOWN MODE is accepted. rezeis-admin is allowed to ship a fifth
 *     policy before this deployment knows it — the same forward-compatibility
 *     promise `isEffectId` makes a few lines down, for the same reason and
 *     after the same outage. The consumer resolves an unrecognised mode to
 *     inherit, so the worst case is one card wearing the global policy;
 *   - a COLOUR THAT IS NOT AN OPAQUE HEX is accepted as long as it is a short
 *     string. `resolvePlanCardText` treats an unusable custom colour as no
 *     decision and falls back to the global policy, which is a visible but
 *     survivable result.
 *
 * What is still refused is a value that cannot be a text policy at all: a
 * string, an array, a number, or a mode that is not a string. Those indicate a
 * corrupt writer rather than a newer one.
 *
 * The penalty for refusing decides all of this. This guard is one
 * first-rejection-wins chain over the WHOLE public config: a single unusable
 * entry discards the entire branding snapshot, and the cabinet then serves the
 * previous one indefinitely — every colour, logo and text — while the panel
 * keeps reporting successful saves. That has already happened twice, over
 * `navItems` and over `cardEffect`; see the notes on both. A `planCardStyles`
 * map holds up to 500 independently written entries, so it is the single most
 * likely place for one stale value to meet a stricter reader — five hundred
 * chances to freeze the cabinet over one card's text colour.
 */
function hasOptionalPlanCardText(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  const mode = value["mode"];
  if (typeof mode !== "string" || mode.length === 0 || mode.length > 32) return false;
  const color = value["color"];
  return (
    color === undefined ||
    color === null ||
    (typeof color === "string" && color.length <= 32)
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

function isOpaqueHex(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
  );
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

/**
 * The animated-effect vocabulary is OPEN, unlike every other enum here.
 *
 * `cardEffect` names a decorative animation, and rezeis-admin is allowed to
 * ship a new one before this deployment knows it — that is precisely the
 * forward compatibility the header of this file promises. Checking it against
 * a closed set broke that promise in the worst available way: the guard is one
 * `&&` chain, so a single unrecognised id invalidated the ENTIRE snapshot. The
 * caller then threw before reaching `save`, so the cabinet went on serving the
 * last stored snapshot — not until a restart, forever — and every later
 * branding edit, colours and logo and texts alike, was discarded in silence
 * while the panel reported the save had succeeded.
 *
 * An unknown id is therefore accepted here and resolved where it is used: the
 * card effect layer renders nothing for an id it has no component for, leaving
 * the operator's gradient in view. One card drawn plainly is a blemish; a
 * configuration frozen for good is an outage.
 *
 * The consumers must treat this value as arbitrary text, because it now is —
 * see `isKnownCardEffect` in the SPA's `card-effect-catalog.ts`, which exists
 * so that an id like `toString` cannot be found by an inherited-property
 * lookup.
 */
function isEffectId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

/**
 * `appBackground.kind` — an OPEN vocabulary, exactly like `isEffectId` above
 * and for exactly the same reason.
 *
 * rezeis-admin decides what background modes exist and releases on its own
 * cadence, so a `kind` arriving here may name a mode this build has never
 * heard of. A closed Set would turn every such release into the outage that
 * has already happened twice in this guard: one unrecognised decorative field
 * fails the whole first-rejection-wins chain, `fetchFreshPayload` throws before
 * it can `save`, and `src/api/routes/branding.ts` falls back to the previous
 * snapshot — indefinitely, for every branding field at once, while the panel
 * keeps reporting successful saves.
 *
 * The escape is the same as for effect ids: accept the name, resolve it where
 * it is used. `resolveAppBackgroundKind` in `web/src/types/branding.ts` maps an
 * unrecognised kind to `"none"`, which is the cabinet's built-in background —
 * the picture this deployment was already showing. Rendering the familiar
 * default for a mode we cannot draw is a blemish; a configuration frozen for
 * good is an outage.
 *
 * What is still refused is a value that cannot be a kind at all: a non-string,
 * an empty string, or one longer than any identifier. Those mean a corrupt
 * writer, not a newer one.
 */
function isAppBackgroundKind(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function hasOptionalEffectIdOrNull(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || isEffectId(value);
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

function hasOptionalThemeModePolicy(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || value === "fixed" || value === "user-selectable";
}

function hasOptionalThemeDefaultMode(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === undefined || value === "light" || value === "dark";
}

function hasOptionalThemeVariants(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) && isThemeVariant(value["light"]) && isThemeVariant(value["dark"]))
  );
}

function isThemeVariant(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const appBackground = value["appBackground"];
  const cornerRadii = value["cornerRadii"];
  const surfaceTheme = value["surfaceTheme"];
  return (
    isHex(value["primary"]) &&
    isHex(value["primaryFg"]) &&
    isHex(value["bgPrimary"]) &&
    isHex(value["bgSecondary"]) &&
    isSafeGradient(value["cardGradient"]) &&
    isNullableSafeGradient(value["cardPattern"]) &&
    hasOptionalSubscriptionCardText(value, "subscriptionCardText") &&
    isEffectId(value["cardEffect"]) &&
    isRecord(value["cardEffectProps"]) &&
    isNumberInRange(value["cardEffectOpacity"], 0.05, 1) &&
    Array.isArray(value["cardEffectsByIndex"]) &&
    value["cardEffectsByIndex"].length <= 20 &&
    value["cardEffectsByIndex"].every(isCardEffectSlot) &&
    isAllowedString(value["bgEffect"], BG_EFFECTS) &&
    isRecord(appBackground) &&
    hasOptionalAppBackground({ appBackground }, "appBackground") &&
    isAllowedString(value["borderRadius"], BORDER_RADII) &&
    isRecord(cornerRadii) &&
    hasOptionalCornerRadii({ cornerRadii }, "cornerRadii") &&
    isNonEmptyString(value["fontFamily"]) &&
    isRecord(surfaceTheme) &&
    hasOptionalSurfaceTheme({ surfaceTheme }, "surfaceTheme")
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

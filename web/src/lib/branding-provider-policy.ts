import {
  DEFAULT_PUBLIC_CONFIG,
  type PublicConfig,
} from "../types/branding";

/**
 * Selects the configuration exposed during bootstrap. A failed refresh must
 * retain the validated browser snapshot instead of flashing back to defaults.
 */
export function selectBrandingProviderConfig(
  data: PublicConfig | undefined,
  snapshot: PublicConfig | null,
): PublicConfig {
  return data ?? snapshot ?? DEFAULT_PUBLIC_CONFIG;
}

/** Only confirmed, non-placeholder query data may replace the snapshot. */
export function shouldPersistPublicConfig(
  data: PublicConfig | undefined,
  dataUpdatedAt: number,
  isPlaceholderData: boolean,
  isSuccess: boolean,
): data is PublicConfig {
  return isSuccess && !isPlaceholderData && data !== undefined && dataUpdatedAt > 0;
}

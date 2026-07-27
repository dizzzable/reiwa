import { describe, expect, it } from "vitest";

import {
  selectBrandingProviderConfig,
  shouldPersistPublicConfig,
} from "../../web/src/lib/branding-provider-policy.js";
import {
  DEFAULT_PUBLIC_CONFIG,
  type PublicConfig,
} from "../../web/src/types/branding.js";

const STORED_SNAPSHOT: PublicConfig = {
  ...DEFAULT_PUBLIC_CONFIG,
  branding: {
    ...DEFAULT_PUBLIC_CONFIG.branding,
    brandName: "Stored Northern Lights",
    primary: "#6750a4",
  },
};

describe("BrandingProvider snapshot fallback", () => {
  it("uses the stored snapshot on first paint before query data exists", () => {
    expect(selectBrandingProviderConfig(undefined, STORED_SNAPSHOT)).toBe(STORED_SNAPSHOT);
  });

  it("replaces the stored snapshot only when a fetched config is available", () => {
    expect(selectBrandingProviderConfig(DEFAULT_PUBLIC_CONFIG, STORED_SNAPSHOT)).toBe(
      DEFAULT_PUBLIC_CONFIG,
    );
  });

  it("does not make a failed fetch eligible to overwrite the stored snapshot", () => {
    expect(shouldPersistPublicConfig(undefined, 0, true, false)).toBe(false);
    expect(shouldPersistPublicConfig(STORED_SNAPSHOT, Date.now(), true, true)).toBe(false);
    expect(shouldPersistPublicConfig(STORED_SNAPSHOT, Date.now(), false, true)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { isConnectScreenEnabled, readCatalog } from "../src/features/connect/connect-catalog";

/**
 * The switch that decides where "Подключить" goes.
 *
 * It rides inside the catalog rather than in the platform policy so the flag
 * and the thing it switches on travel in one payload, behind one cache and one
 * invalidation — they can never disagree with each other for a TTL. Its off
 * position is the rollback: no deploy, one toggle, back to the external page.
 *
 * Everything here is about defaulting in the safe direction. The screen replaces
 * a flow that works, so anything short of an explicit `true` has to keep the old
 * behaviour: an install that never opted in, a panel that is down, a cabinet
 * newer than its panel, a value that is not a boolean.
 */

const CATALOG = {
  version: 2,
  connectScreenEnabled: true,
  showConnectionKeys: false,
  icons: {},
  platforms: [
    {
      id: "ios",
      title: { en: "iOS" },
      iconKey: null,
      apps: [
        {
          id: "happ",
          name: "Happ",
          iconKey: null,
          featured: true,
          steps: [{ title: { en: "Add" }, body: null, iconKey: null, buttons: [] }],
        },
      ],
    },
  ],
};

describe("where the button goes", () => {
  it("opens the cabinet screen only on an explicit yes", () => {
    expect(isConnectScreenEnabled(CATALOG)).toBe(true);
  });

  it("keeps redirecting outward for everything short of one", () => {
    // The absent case is the one that matters most: it is every install that
    // has not opted in, and it is the shape a panel older than this field sends.
    expect(isConnectScreenEnabled({ ...CATALOG, connectScreenEnabled: false })).toBe(false);
    expect(isConnectScreenEnabled({ ...CATALOG, connectScreenEnabled: undefined })).toBe(false);
    expect(isConnectScreenEnabled({ ...CATALOG, connectScreenEnabled: "true" })).toBe(false);
    expect(isConnectScreenEnabled({ ...CATALOG, connectScreenEnabled: 1 })).toBe(false);
  });

  it("keeps redirecting outward while the panel is unreachable", () => {
    // The edge answers `null` during a panel outage. Reading that as "on" would
    // switch every customer onto the new screen at the exact moment its catalog
    // cannot be fetched.
    expect(isConnectScreenEnabled(null)).toBe(false);
    expect(isConnectScreenEnabled(undefined)).toBe(false);
  });

  it("stays on even when not one platform could be read", () => {
    // THE CASE THAT MADE THIS A SEPARATE FUNCTION. A catalog whose platforms all
    // failed to parse gives `readCatalog` null — but the screen still has the
    // subscription link, which is the action that never needed a catalog.
    // Deciding from the parsed value would send those customers back outward
    // and hide the failure behind a working-looking redirect.
    const unreadable = { ...CATALOG, platforms: [{ id: "windows11", title: { en: "?" }, apps: [] }] };

    expect(readCatalog(unreadable)).toBeNull();
    expect(isConnectScreenEnabled(unreadable)).toBe(true);
  });
});

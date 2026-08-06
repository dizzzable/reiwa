// @vitest-environment node

/**
 * The shared rule every device reader branches on. The component specs
 * (`devices-page-load-failure`, `dashboard-devices-load-failure`) prove
 * production reaches this function; these pin the rule itself, including the
 * cases a rendered spec cannot easily stage (a failed REFRESH over rows we
 * already hold).
 */

import { describe, expect, it } from "vitest";

import { resolveDevicesViewState } from "../src/lib/devices-view-state";
import type { HwidDevice } from "../src/types/api";

const DEVICE: HwidDevice = {
  hwid: "hwid-1",
  platform: "android",
  osVersion: "14",
  deviceModel: "Pixel 8",
  userAgent: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  lastSeenAt: "2026-08-05T10:00:00.000Z",
};

describe("resolveDevicesViewState", () => {
  it("never shows the empty state for a failed first read", () => {
    const state = resolveDevicesViewState(undefined, true);
    expect(state.showLoadError).toBe(true);
    expect(state.showEmptyState).toBe(false);
    expect(state.devices).toEqual([]);
  });

  it("yields no count at all for a failed first read", () => {
    // `null`, not 0 — a caller that printed 0 here would be telling the same
    // lie the whole change exists to end.
    expect(resolveDevicesViewState(undefined, true).deviceCount).toBeNull();
    expect(resolveDevicesViewState(undefined, true).deviceCount).not.toBe(0);
  });

  it("shows the empty state for a genuinely empty list", () => {
    const state = resolveDevicesViewState({ devices: [], total: 0 }, false);
    expect(state.showEmptyState).toBe(true);
    expect(state.showLoadError).toBe(false);
    expect(state.deviceCount).toBe(0);
  });

  it("keeps the empty state off the screen while the first read is in flight", () => {
    const state = resolveDevicesViewState(undefined, false);
    expect(state.showEmptyState).toBe(false);
    expect(state.showLoadError).toBe(false);
    expect(state.deviceCount).toBe(0);
  });

  it("passes a successful list through with its panel-reported count", () => {
    const state = resolveDevicesViewState({ devices: [DEVICE], total: 3 }, false);
    expect(state.devices).toEqual([DEVICE]);
    expect(state.deviceCount).toBe(3);
    expect(state.showLoadError).toBe(false);
    expect(state.showEmptyState).toBe(false);
  });

  it("falls back to the row count when the panel omits `total`", () => {
    expect(resolveDevicesViewState({ devices: [DEVICE] }, false).deviceCount).toBe(1);
  });

  it("keeps rows we already hold when a REFRESH fails, flagged as stale", () => {
    const state = resolveDevicesViewState({ devices: [DEVICE], total: 1 }, true);
    expect(state.devices).toEqual([DEVICE]);
    expect(state.showLoadError).toBe(true);
    // Not the empty card, and not a count of 0: they were true when read.
    expect(state.showEmptyState).toBe(false);
    expect(state.deviceCount).toBe(1);
  });
});

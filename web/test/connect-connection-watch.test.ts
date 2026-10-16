import { describe, expect, it } from "vitest";

import {
  connectionVerdict,
  ONLINE_FRESH_MS,
  readConnection,
  type ConnectionReading,
} from "../src/features/connect/wizard/connection-watch";

/**
 * «Подключение есть!» is a claim made on the customer's behalf, so the rule
 * behind it is pinned here. The one thing it must never do is say "connected"
 * for a device it cannot tell apart from another one — that is a customer
 * walking away from a phone that has no VPN on it.
 */

const T0 = Date.parse("2026-10-16T12:00:00.000Z");
const reading = (onlineAt: number | null, checkedAt = T0): ConnectionReading => ({ onlineAt, checkedAt });

describe("readConnection", () => {
  it("reads the panel's answer into milliseconds", () => {
    expect(
      readConnection({
        state: "known",
        onlineAt: "2026-10-16T11:59:00.000Z",
        firstConnectedAt: null,
        checkedAt: "2026-10-16T12:00:00.000Z",
      }),
    ).toEqual({ onlineAt: T0 - 60_000, checkedAt: T0 });
  });

  it("treats anything it cannot vouch for as no reading at all", () => {
    expect(readConnection({ state: "unknown", onlineAt: null, checkedAt: null })).toBeNull();
    expect(readConnection({ state: "known", onlineAt: "yesterday", checkedAt: "2026-10-16T12:00:00Z" })).toBeNull();
    expect(readConnection({ state: "known", onlineAt: null })).toBeNull();
    expect(readConnection("known")).toBeNull();
    expect(readConnection(null)).toBeNull();
  });
});

describe("connectionVerdict", () => {
  it("says connected once onlineAt moves past where it stood at the start", () => {
    expect(connectionVerdict(reading(null), reading(T0 + 30_000, T0 + 40_000))).toBe("connected");
    const old = T0 - 2 * ONLINE_FRESH_MS;
    expect(connectionVerdict(reading(old), reading(T0 + 5_000, T0 + 9_000))).toBe("connected");
  });

  it("keeps waiting while onlineAt has not moved", () => {
    expect(connectionVerdict(reading(null), reading(null, T0 + 20_000))).toBe("waiting");
    const old = T0 - 2 * ONLINE_FRESH_MS;
    expect(connectionVerdict(reading(old), reading(old, T0 + 20_000))).toBe("waiting");
  });

  it("refuses to decide when another device was online at the start", () => {
    // Remnawave's `onlineAt` is per profile: a phone already on the VPN moves
    // it whether or not this device ever connects.
    const fresh = T0 - 20_000;
    expect(connectionVerdict(reading(fresh), reading(T0 + 30_000, T0 + 35_000))).toBe("busy");
  });

  it("is unknown with no reading, never 'not connected'", () => {
    expect(connectionVerdict(null, null)).toBe("unknown");
  });

  it("compares the panel's readings with each other, never with the phone's clock", () => {
    // A phone set a day ahead changes nothing: only the two readings are compared.
    const base = reading(null, T0);
    expect(connectionVerdict(base, reading(T0 + 1_000, T0 + 4_000))).toBe("connected");
  });
});

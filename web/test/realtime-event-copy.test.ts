import { describe, expect, it } from "vitest";

import { REALTIME_EVENT_TYPES, realtimeEventText } from "@/hooks/realtime-event-copy";
import { ru } from "@/i18n/ru";
import { en } from "@/i18n/en";

/**
 * THE OPERATOR'S SENTENCE MUST NOT REACH A CUSTOMER'S SCREEN.
 *
 * The panel forwards `projection.message ?? event.message` down the customer's
 * live stream, and the cabinet renders it as a toast. Until the projection
 * required a message of its own, that fell through to the sentence the emitter
 * wrote for the OPERATOR'S feed — English, and naming things the customer has
 * no business reading:
 *
 *   "Remnawave profile created: rz_<their login>_vpn"
 *   "Payment completed for a BLOCKED customer: SUBSCRIPTION"
 *   "Promocode X reward synced with delay (enqueue failed: …)"
 *
 * Two halves fix it and both have to hold. The panel now sends a neutral
 * sentence, which is what protects a cabinet that predates this file. This
 * cabinet renders its OWN words instead, in the customer's language — and falls
 * back to the panel's sentence rather than to nothing.
 *
 * ONLY THIS HALF IS CHECKED HERE. The panel's guard lives in the panel's own
 * suite (`user-realtime-message-safety.spec.ts`), because reaching across the
 * repository boundary would make this file fail wherever the panel is not
 * checked out beside the cabinet — which is every CI runner but one.
 */

const t =
  (dict: Record<string, string>) =>
  (key: string): string =>
    dict[key] ?? key;

function dict(bundle: unknown): Record<string, string> {
  const events = (bundle as Record<string, unknown>)["realtimeEvents"] as Record<string, string>;
  return Object.fromEntries(
    Object.entries(events ?? {}).map(([type, text]) => [`realtimeEvents.${type}`, text]),
  );
}

describe("what a live event says to the customer", () => {
  it("covers every type this cabinet claims to know, in both languages", () => {
    // Anti-emptiness anchor first: an empty list would make the loop agree with
    // a cabinet that translates nothing.
    expect(REALTIME_EVENT_TYPES.length).toBeGreaterThan(10);

    const missing: string[] = [];
    for (const type of REALTIME_EVENT_TYPES) {
      if ((dict(ru)[`realtimeEvents.${type}`] ?? "").length === 0) missing.push(`ru: ${type}`);
      if ((dict(en)[`realtimeEvents.${type}`] ?? "").length === 0) missing.push(`en: ${type}`);
    }

    expect(missing).toEqual([]);
  });

  it("uses its own words, not the sentence the panel sent", () => {
    const text = realtimeEventText(t(dict(ru)) as never, {
      type: "subscription.created",
      message: "Remnawave profile created: rz_dizzable_vpn",
    });

    expect(text).toBe("Подписка готова");
    expect(text).not.toMatch(/Remnawave|rz_/);
  });

  it("falls back to the panel's sentence for a type it has never heard of", () => {
    // Showing nothing would drop a notification the customer was meant to get,
    // and showing the raw key would be worse than the English it replaced.
    const text = realtimeEventText(t(dict(ru)) as never, {
      type: "something.new",
      message: "Something happened",
    });

    expect(text).toBe("Something happened");
  });

  it("falls back rather than rendering a key when the copy is missing", () => {
    // A type listed as known whose translation was deleted. `t` returns the key
    // itself in that case, and a toast reading `realtimeEvents.payment.failed`
    // is the worst of the three outcomes.
    const text = realtimeEventText(t({}) as never, {
      type: "payment.failed",
      message: "The payment did not go through",
    });

    expect(text).toBe("The payment did not go through");
  });
});

describe("the list against what this cabinet actually receives", () => {
  it("names every type the query-key registry subscribes to", async () => {
    // THE GAP THIS FILE COULD NOT SEE. Every case above iterates
    // `REALTIME_EVENT_TYPES` — the same list it is meant to be checking — so a
    // type the cabinet genuinely receives and this list forgets is invisible,
    // and it falls straight through to the panel's own sentence. That is how
    // `subscription.trial_granted` was missed: registered here, unnamed there.
    const { userRealtimeQueryKeysByType } = await import("@/lib/user-realtime-query-keys");
    const registered = Object.keys(userRealtimeQueryKeysByType);

    expect(registered.length).toBeGreaterThan(5);
    const unnamed = registered.filter(
      (type) => !(REALTIME_EVENT_TYPES as readonly string[]).includes(type),
    );

    expect(unnamed, "these arrive as toasts wearing the panel's own words").toEqual([]);
  });
});

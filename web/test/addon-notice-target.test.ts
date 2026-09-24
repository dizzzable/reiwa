/**
 * A tap on a paid add-on's notice in the feed.
 *
 * The panel tells a customer three days before a paid add-on ends and when it
 * has (`addon_*`, six types: traffic, and devices with either word for what
 * the end does to them). A tap opens the add-on page on that subscription —
 * where it is bought again — the address the notice's «Купить снова» and its
 * push open. It opened the notice's text in a window before: the type was
 * unknown here.
 */
import { describe, expect, it } from "vitest";

import { resolveNotificationTarget } from "../src/lib/notification-target";

const TYPES = [
  "addon_ends_in_3_days",
  "addon_ended",
  "addon_devices_ends_in_3_days",
  "addon_devices_ended",
  "addon_devices_auto_ends_in_3_days",
  "addon_devices_auto_ended",
];

describe("a tap on an add-on’s notice", () => {
  it("opens the add-on page on the subscription it names", () => {
    for (const type of TYPES) {
      expect(resolveNotificationTarget(type, { subscriptionId: "cmsub0001abcdefghijklmno" }), type).toEqual({
        kind: "route",
        path: "/addons?subscriptionId=cmsub0001abcdefghijklmno",
      });
    }
  });

  it("opens the add-on page itself when it names none", () => {
    for (const payload of [undefined, null, {}, { subscriptionId: 42 }, { subscriptionId: "" }]) {
      expect(resolveNotificationTarget("addon_ended", payload)).toEqual({ kind: "route", path: "/addons" });
    }
  });
});

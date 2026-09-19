/**
 * Tapping «Не получилось подключиться?» in the notification feed.
 *
 * The feed maps a notification TYPE to a destination, by substring for the
 * older families. `connect_help` matches none of them, so it fell to the
 * default — a modal repeating the text the customer had just tapped — instead
 * of the one place that can help: the dashboard's deep link, which picks the
 * card and opens the operator's connect door. The same address the push, the
 * bot's button and the pop-up use.
 */
import { describe, expect, it } from "vitest";

import { resolveNotificationTarget } from "../src/lib/notification-target";

describe("the connect-help notices in the feed", () => {
  it("open the dashboard's deep link", () => {
    expect(resolveNotificationTarget("connect_help")).toEqual({
      kind: "route",
      path: "/dashboard?connect=help",
    });
  });

  it("do the same for the trial-and-gift twin", () => {
    expect(resolveNotificationTarget("connect_help_trial")).toEqual({
      kind: "route",
      path: "/dashboard?connect=help",
    });
  });

  it("name the subscription when the payload carries it", () => {
    expect(resolveNotificationTarget("connect_help", { subscriptionId: "cmsub001" })).toEqual({
      kind: "route",
      path: "/dashboard?connect=help&subscriptionId=cmsub001",
    });
  });

  it("leave out an id that could reshape the address", () => {
    expect(resolveNotificationTarget("connect_help", { subscriptionId: "../../renew" })).toEqual({
      kind: "route",
      path: "/dashboard?connect=help",
    });
    expect(resolveNotificationTarget("connect_help", { subscriptionId: 42 })).toEqual({
      kind: "route",
      path: "/dashboard?connect=help",
    });
  });

  it("are read regardless of case, like every other type here", () => {
    expect(resolveNotificationTarget("CONNECT_HELP")).toEqual({
      kind: "route",
      path: "/dashboard?connect=help",
    });
  });
});

describe("the families that were already mapped", () => {
  it("keep their destinations", () => {
    expect(resolveNotificationTarget("support_reply")).toEqual({ kind: "route", path: "/support" });
    expect(resolveNotificationTarget("referral.reward_issued")).toEqual({ kind: "route", path: "/referrals" });
    expect(resolveNotificationTarget("expires_in_3_days")).toEqual({ kind: "route", path: "/renew" });
    expect(resolveNotificationTarget("broadcast")).toEqual({ kind: "modal" });
  });
});

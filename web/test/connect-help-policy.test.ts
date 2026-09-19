/**
 * «Не получилось подключиться?» — the decisions under the banner, the deep link,
 * the feed and the pop-up, without a component in the way.
 *
 * Every case here is one of the promises the cabinet makes to a panel it does
 * not ship with: an OLD panel sends no `connectHelp` at all, a NEW one sends
 * `{ pending, banner } | null`, and anything else that ever arrives in that slot
 * must read as "nothing is owed" — a banner raised by a malformed value is a
 * banner nobody decided to show.
 */
import { describe, expect, it } from "vitest";

import {
  connectHelpDeepLink,
  newestPendingConnectHelp,
  pickConnectHelpSubscription,
  readConnectHelp,
  readConnectHelpDeepLink,
  shouldShowConnectHelpBanner,
  withConnectHelpBannerHidden,
} from "../src/features/dashboard/connect-help";
import type { Subscription } from "../src/types/api";

function sub(input: Partial<Subscription> & { readonly id: string }): Subscription {
  return {
    userRemnaId: "rw",
    status: "ACTIVE",
    isTrial: false,
    trafficLimit: null,
    deviceLimit: 3,
    expiresAt: null,
    url: `https://sub.example.test/${input.id}`,
    plan: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...input,
  } as Subscription;
}

describe("reading the panel's answer", () => {
  it("reads a new panel's flags", () => {
    expect(readConnectHelp({ connectHelp: { pending: true, banner: true } })).toEqual({
      pending: true,
      banner: true,
    });
    expect(readConnectHelp({ connectHelp: { pending: true, banner: false } })).toEqual({
      pending: true,
      banner: false,
    });
  });

  it("reads an old panel's silence, and an explicit null, as nothing", () => {
    expect(readConnectHelp({})).toBeNull();
    expect(readConnectHelp({ connectHelp: null })).toBeNull();
    expect(readConnectHelp(null)).toBeNull();
    expect(readConnectHelp(undefined)).toBeNull();
  });

  it("takes nothing but a literal true for a yes", () => {
    for (const odd of ["true", 1, {}, [], null, undefined]) {
      expect(readConnectHelp({ connectHelp: { pending: odd, banner: odd } })).toEqual({
        pending: false,
        banner: false,
      });
    }
    expect(readConnectHelp({ connectHelp: "yes" })).toBeNull();
    expect(readConnectHelp({ connectHelp: [true, true] })).toBeNull();
  });
});

describe("whether the banner is on screen", () => {
  const none: ReadonlySet<string> = new Set();

  it("shows it only when the panel raised it", () => {
    expect(shouldShowConnectHelpBanner(sub({ id: "a", connectHelp: { pending: true, banner: true } }), none)).toBe(true);
    expect(shouldShowConnectHelpBanner(sub({ id: "a", connectHelp: { pending: true, banner: false } }), none)).toBe(false);
    expect(shouldShowConnectHelpBanner(sub({ id: "a", connectHelp: null }), none)).toBe(false);
    expect(shouldShowConnectHelpBanner(sub({ id: "a" }), none)).toBe(false);
    expect(shouldShowConnectHelpBanner(null, none)).toBe(false);
  });

  it("never under a subscription that can no longer connect", () => {
    for (const status of ["EXPIRED", "DISABLED", "DELETED"] as const) {
      expect(
        shouldShowConnectHelpBanner(sub({ id: "a", status, connectHelp: { pending: true, banner: true } }), none),
        status,
      ).toBe(false);
    }
    expect(
      shouldShowConnectHelpBanner(sub({ id: "a", status: "LIMITED", connectHelp: { pending: true, banner: true } }), none),
    ).toBe(true);
  });

  it("not once it was closed on this page", () => {
    const raised = sub({ id: "a", connectHelp: { pending: true, banner: true } });
    expect(shouldShowConnectHelpBanner(raised, new Set(["a"]))).toBe(false);
    expect(shouldShowConnectHelpBanner(raised, new Set(["b"]))).toBe(true);
  });
});

describe("closing it in the cached list", () => {
  it("switches off exactly that subscription's banner", () => {
    const list = {
      subscriptions: [
        sub({ id: "a", connectHelp: { pending: true, banner: true } }),
        sub({ id: "b", connectHelp: { pending: true, banner: true } }),
      ],
    };
    const next = withConnectHelpBannerHidden(list, "a");
    expect(next.subscriptions[0]?.connectHelp).toEqual({ pending: true, banner: false });
    expect(next.subscriptions[1]?.connectHelp).toEqual({ pending: true, banner: true });
    // Not mutated in place: the query cache compares by identity.
    expect(list.subscriptions[0]?.connectHelp).toEqual({ pending: true, banner: true });
  });

  it("hands back the very same object when there is nothing to change", () => {
    const oldPanel = { subscriptions: [sub({ id: "a" })] };
    expect(withConnectHelpBannerHidden(oldPanel, "a")).toBe(oldPanel);
    expect(withConnectHelpBannerHidden(undefined, "a")).toBeUndefined();
    const odd = { nothing: true };
    expect(withConnectHelpBannerHidden(odd, "a")).toBe(odd);
  });
});

describe("the deep link", () => {
  it("builds the one address every channel uses", () => {
    expect(connectHelpDeepLink(null)).toBe("/dashboard?connect=help");
    expect(connectHelpDeepLink("cmsub001")).toBe("/dashboard?connect=help&subscriptionId=cmsub001");
    // An id that could reshape the address is left out rather than escaped
    // into it: the dashboard then picks the pending card itself.
    expect(connectHelpDeepLink("a/b?c")).toBe("/dashboard?connect=help");
  });

  it("reads it back, with and without a subscription", () => {
    expect(readConnectHelpDeepLink("/dashboard", "?connect=help")).toEqual({
      subscriptionId: null,
      cleanedPath: "/dashboard",
    });
    expect(readConnectHelpDeepLink("/dashboard", "?connect=help&subscriptionId=cmsub001")).toEqual({
      subscriptionId: "cmsub001",
      cleanedPath: "/dashboard",
    });
  });

  it("keeps every other parameter when it takes its own two out", () => {
    expect(
      readConnectHelpDeepLink("/dashboard", "?utm_source=bot&connect=help&subscriptionId=x1&ref=r"),
    ).toEqual({ subscriptionId: "x1", cleanedPath: "/dashboard?utm_source=bot&ref=r" });
  });

  it("is the dashboard's link and nobody else's", () => {
    expect(readConnectHelpDeepLink("/renew", "?connect=help")).toBeNull();
    expect(readConnectHelpDeepLink("/dashboard", "")).toBeNull();
    expect(readConnectHelpDeepLink("/dashboard", "?connect=other")).toBeNull();
    // The router matches these to the dashboard, so the link works there too.
    expect(readConnectHelpDeepLink("/Dashboard/", "?connect=help")?.subscriptionId).toBeNull();
  });

  it("drops a malformed id and still offers help", () => {
    expect(readConnectHelpDeepLink("/dashboard", "?connect=help&subscriptionId=..%2F..%2Fx")).toEqual({
      subscriptionId: null,
      cleanedPath: "/dashboard",
    });
  });
});

describe("which card a deep link means", () => {
  const older = sub({ id: "older", createdAt: "2026-08-01T00:00:00.000Z", connectHelp: { pending: true, banner: false } });
  const newer = sub({ id: "newer", createdAt: "2026-09-10T00:00:00.000Z", connectHelp: { pending: true, banner: true } });
  const fine = sub({ id: "fine", createdAt: "2026-09-15T00:00:00.000Z", connectHelp: null });
  const list = [older, fine, newer];

  it("the one it named", () => {
    expect(pickConnectHelpSubscription(list, "older", "fine")?.id).toBe("older");
  });

  it("else the newest one still waiting for help", () => {
    expect(pickConnectHelpSubscription(list, null, "fine")?.id).toBe("newer");
    expect(pickConnectHelpSubscription(list, "gone-since", "fine")?.id).toBe("newer");
    expect(newestPendingConnectHelp(list)?.id).toBe("newer");
  });

  it("else the card already on screen — an old panel, or nothing pending", () => {
    const oldPanel = [sub({ id: "one" }), sub({ id: "two" })];
    expect(pickConnectHelpSubscription(oldPanel, null, "two")?.id).toBe("two");
    expect(pickConnectHelpSubscription(oldPanel, null, null)).toBeNull();
    expect(pickConnectHelpSubscription([], "x", null)).toBeNull();
  });
});

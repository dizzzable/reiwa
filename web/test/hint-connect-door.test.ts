// @vitest-environment jsdom

/**
 * The pop-up button `@connect` — «Подключить» from a hint.
 *
 * A pop-up cannot route to `/subscription/connect`: that would bypass the
 * operator's switch between the cabinet's connect screen and the external
 * subscription page, which is why the panel refuses the route. It sends a DOOR
 * instead, and the cabinet opens it the way the dashboard's own button would.
 *
 * The hint controller sits in the shell and holds no query of its own, so the
 * door reads what the dashboard already knows — the cache its door hook hands
 * over — at the moment of the tap, and when it knows nothing yet, hands the
 * decision to the dashboard's deep link, which waits for the answer. The states
 * of that knowledge are the cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

const openExternalUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/utils", () => ({ openExternalUrl }));

import { hasHintCta, runHintCta, HINT_DOORS } from "@/features/hints/hint-cta";
import { QueryClient } from "@tanstack/react-query";

import { CONNECT_PAGE_QUERY_KEY, rememberDashboardCache } from "@/features/dashboard/connect-door";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";

type Hint = Parameters<typeof runHintCta>[0];

function hint(input: Partial<Hint>): Hint {
  return {
    deliveryId: "d1",
    key: "tpl-connect-help",
    title: "Не получилось подключиться?",
    body: "…",
    mode: "MODAL",
    tone: "INFO",
    ctaKind: "ROUTE",
    ctaLabel: "Подключить",
    ctaTarget: "@connect",
    ...input,
  } as Hint;
}

const WAITING = {
  id: "cmwaiting",
  createdAt: "2026-09-18T10:00:00.000Z",
  url: "https://sub.example.test/waiting",
  connectHelp: { pending: true, banner: false },
};
const CONNECTED = {
  id: "cmconnected",
  createdAt: "2026-09-19T10:00:00.000Z",
  url: "https://sub.example.test/connected",
  connectHelp: null,
};

function knownDoor(enabled: boolean): void {
  queryClient.setQueryData(CONNECT_PAGE_QUERY_KEY, { connectScreenEnabled: enabled });
}

function knownList(rows: unknown[]): void {
  queryClient.setQueryData(subscriptionQueryKeys.all, { subscriptions: rows });
}

/** The dashboard's cache, as its door hook hands it over. */
let queryClient: QueryClient;
let navigate: ReturnType<typeof vi.fn>;
let windowOpen: MockInstance<typeof window.open>;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rememberDashboardCache(queryClient);
  navigate = vi.fn();
  openExternalUrl.mockClear();
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  rememberDashboardCache(null);
  queryClient.clear();
  windowOpen.mockRestore();
});

describe("the @connect door", () => {
  it("is a button this build draws", () => {
    expect(HINT_DOORS).toContain("@connect");
    expect(hasHintCta(hint({}))).toBe(true);
  });

  it("opens the cabinet's connect screen for the subscription waiting for help", () => {
    knownDoor(true);
    knownList([CONNECTED, WAITING]);

    runHintCta(hint({}), navigate as never);

    expect(navigate.mock.calls).toEqual([["/subscription/connect?subscriptionId=cmwaiting"]]);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens the external page inside the tap when the operator's switch is off", () => {
    knownDoor(false);
    knownList([CONNECTED, WAITING]);

    runHintCta(hint({}), navigate as never);

    // The customer's own tap is on the stack, so the new tab is allowed here —
    // and it is THAT subscription's page, not the newest card's.
    expect(openExternalUrl).toHaveBeenCalledWith("https://sub.example.test/waiting");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("hands over to the dashboard when the switch has not been read yet", () => {
    knownList([CONNECTED, WAITING]);

    runHintCta(hint({}), navigate as never);

    expect(navigate.mock.calls).toEqual([["/dashboard?connect=help&subscriptionId=cmwaiting"]]);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("hands over to the dashboard when the dashboard has not been open at all", () => {
    rememberDashboardCache(null);

    runHintCta(hint({}), navigate as never);

    expect(navigate.mock.calls).toEqual([["/dashboard?connect=help"]]);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("hands over to the dashboard when it does not know the subscriptions yet", () => {
    knownDoor(true);

    runHintCta(hint({}), navigate as never);

    expect(navigate.mock.calls).toEqual([["/dashboard?connect=help"]]);
  });

  it("hands over to the dashboard when nothing is waiting — it picks the card on screen", () => {
    knownDoor(true);
    knownList([CONNECTED]);

    runHintCta(hint({}), navigate as never);

    expect(navigate.mock.calls).toEqual([["/dashboard?connect=help"]]);
  });

  it("treats a failed read of the switch as its safe position, the external page", async () => {
    await queryClient
      .fetchQuery({
        queryKey: CONNECT_PAGE_QUERY_KEY,
        queryFn: () => Promise.reject(new Error("panel down")),
        retry: false,
      })
      .catch(() => undefined);
    knownList([WAITING]);

    runHintCta(hint({}), navigate as never);

    expect(openExternalUrl).toHaveBeenCalledWith("https://sub.example.test/waiting");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never navigates to the door's own name", () => {
    const destinations: string[] = [];
    for (const enabled of [true, false, null]) {
      queryClient.clear();
      if (enabled !== null) knownDoor(enabled);
      knownList([WAITING]);
      navigate.mockClear();

      runHintCta(hint({}), navigate as never);

      destinations.push(...navigate.mock.calls.map((call) => String(call[0])));
    }
    // Anti-vacuity: the internal door and the unread switch both navigate, so
    // the check below reads two real destinations, not an empty list.
    expect(destinations).toHaveLength(2);
    for (const destination of destinations) expect(destination).not.toContain("@");
    expect(windowOpen, "something opened a window behind the shared opener's back").not.toHaveBeenCalled();
  });
});

describe("a door this build does not know", () => {
  it("draws no button and does nothing", () => {
    // A newer panel's door, sent to this cabinet by mistake. Navigating to its
    // raw name would land on the catch-all page and report the pop-up acted.
    const unknown = hint({ ctaTarget: "@teleport" });
    expect(hasHintCta(unknown)).toBe(false);

    runHintCta(unknown, navigate as never);

    expect(navigate).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("leaves ordinary routes exactly as they were", () => {
    runHintCta(hint({ ctaTarget: "/renew" }), navigate as never);
    expect(navigate.mock.calls).toEqual([["/renew"]]);
    expect(hasHintCta(hint({ ctaTarget: "/renew" }))).toBe(true);
  });
});

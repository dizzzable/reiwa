// @vitest-environment jsdom

/**
 * Open pages pick up a settings change within a minute — the owner's rule of
 * 24.09.2026 (W8 report D3: an open cabinet tab never learned about a save).
 *
 * `lib/config-versions.ts` asks `/api/v1/config-versions` every minute while
 * the page is visible and refetches a group whose version moved. Pinned here:
 *
 *   - the first answer only records; a move from one version to another
 *     refetches that group, and only that group; the same version, and "nothing
 *     held" (`null`) in between, refetch nothing;
 *   - a hidden page runs no timer and asks nothing; a return asks at once, at
 *     most every ten seconds, on `visibilitychange` and on `pageshow`;
 *   - failures are quiet and back off; `stop` leaves nothing behind;
 *   - a body that names an older version than the cabinet holds (the browser
 *     cache answered) is refetched at once, and a newer one does not loop;
 *   - end to end through React Query: the refetch carries `?v=<version>`, and
 *     the page redraws with the new data.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG_VERSION_PARAM,
  ConfigVersionWatcher,
  servedConfigVersion,
  WATCHED_CONFIG_GROUPS,
  type WatchedConfigGroup,
} from "@/lib/config-versions";
import { CONFIG_VERSION_SEARCH_PARAM } from "@/sw-cache-policy";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function answers(...sequence: unknown[]) {
  let index = 0;
  return vi.fn(async () => {
    const next = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  });
}

const versions = (values: Partial<Record<WatchedConfigGroup, string | null>>) => ({ versions: values });

function watcherWith(fetchVersions: () => Promise<unknown>) {
  const refetched: WatchedConfigGroup[] = [];
  const refetchGroup = vi.fn(async (group: WatchedConfigGroup) => {
    refetched.push(group);
    return true;
  });
  const watcher = new ConfigVersionWatcher();
  watcher.start({ fetchVersions, refetchGroup });
  return { watcher, refetched, refetchGroup };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("what an answer does", () => {
  it("the first answer only records; a move to another version refetches that group", async () => {
    const fetchVersions = answers(
      versions({ publicConfig: A, landing: C }),
      versions({ publicConfig: B, landing: C }),
    );
    const { watcher, refetched } = watcherWith(fetchVersions);

    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    expect(refetched).toEqual([]);
    expect(watcher.versionOf("publicConfig")).toBe(A);

    await settle(60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(2);
    expect(refetched).toEqual(["publicConfig"]);
    expect(watcher.versionOf("publicConfig")).toBe(B);
    watcher.stop();
  });

  it("the same version again refetches nothing", async () => {
    const fetchVersions = answers(versions({ publicConfig: A }));
    const { watcher, refetched } = watcherWith(fetchVersions);
    await settle();
    await settle(60_000);
    await settle(60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(3);
    expect(refetched).toEqual([]);
    watcher.stop();
  });

  it("“nothing held” refetches nothing, and does not make the next version look new", async () => {
    const fetchVersions = answers(
      versions({ publicConfig: null }),
      versions({ publicConfig: A }),
      versions({ publicConfig: null }),
      versions({ publicConfig: A }),
      versions({ publicConfig: null }),
      versions({ publicConfig: B }),
    );
    const { watcher, refetched } = watcherWith(fetchVersions);
    await settle();
    for (let ask = 0; ask < 4; ask += 1) await settle(60_000);
    // null → A: A is the first version seen, recorded only; A → null → A: same.
    expect(refetched).toEqual([]);
    await settle(60_000);
    // A → null → B: a move.
    expect(refetched).toEqual(["publicConfig"]);
    watcher.stop();
  });

  it("refetches a group the page's copy is older than as soon as the body names itself", async () => {
    const fetchVersions = answers(versions({ publicConfig: B }));
    const { watcher, refetched } = watcherWith(fetchVersions);
    await settle();
    expect(refetched).toEqual([]);

    // The browser cache answered the bootstrap read with the copy from before
    // the save; its header says so.
    watcher.noteServed("publicConfig", A);
    await settle();
    expect(refetched).toEqual(["publicConfig"]);

    // The refetch brought a body newer still (the cabinet moved on meanwhile):
    // no second refetch for the same version — the next ask settles it.
    watcher.noteServed("publicConfig", C);
    await settle();
    expect(refetched).toEqual(["publicConfig"]);
    watcher.stop();
  });

  it("an older body noted before the first answer is refetched when the answer comes", async () => {
    const fetchVersions = answers(versions({ publicConfig: B }));
    const watcher = new ConfigVersionWatcher();
    const refetchGroup = vi.fn(async () => true);
    watcher.noteServed("publicConfig", A);
    watcher.start({ fetchVersions, refetchGroup });
    await settle();
    expect(refetchGroup).toHaveBeenCalledWith("publicConfig");
    watcher.stop();
  });

  it("a refetch that fails is tried again at the next ask", async () => {
    const fetchVersions = answers(versions({ landing: A }), versions({ landing: B }));
    const refetchGroup = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const watcher = new ConfigVersionWatcher();
    watcher.start({ fetchVersions, refetchGroup });
    await settle();
    await settle(60_000);
    expect(refetchGroup).toHaveBeenCalledTimes(1);
    await settle(60_000);
    expect(refetchGroup).toHaveBeenCalledTimes(2);
    await settle(60_000);
    expect(refetchGroup).toHaveBeenCalledTimes(2);
    watcher.stop();
  });
});

describe("when it asks", () => {
  it("never while the page is hidden — and at once when it is shown", async () => {
    visibility = "hidden";
    const fetchVersions = answers(versions({ publicConfig: A }));
    const { watcher } = watcherWith(fetchVersions);
    await settle(10 * 60_000);
    expect(fetchVersions).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("stops its timer when the page is hidden", async () => {
    const fetchVersions = answers(versions({ publicConfig: A }));
    const { watcher } = watcherWith(fetchVersions);
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    await settle(5 * 60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it("asks on `pageshow`, and not twice within ten seconds", async () => {
    const fetchVersions = answers(versions({ publicConfig: A }));
    const { watcher } = watcherWith(fetchVersions);
    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(9_000);
    expect(fetchVersions).toHaveBeenCalledTimes(1);

    await settle(1_000);
    window.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("backs off quietly while asking fails", async () => {
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const fetchVersions = answers(new Error("503"), new Error("503"), versions({ publicConfig: A }));
    const { watcher } = watcherWith(fetchVersions);
    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    await settle(60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    await settle(60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(2);
    await settle(4 * 60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("leaves no timer and no listener behind once stopped", async () => {
    const added: Array<[EventTarget, string, unknown]> = [];
    const removed: Array<[EventTarget, string, unknown]> = [];
    for (const target of [document, window] as EventTarget[]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
        added.push([target, type, listener]);
        add(type, listener, options);
      });
      vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
        removed.push([target, type, listener]);
        remove(type, listener, options);
      });
    }
    const fetchVersions = answers(versions({ publicConfig: A }));
    const { watcher } = watcherWith(fetchVersions);
    await settle();
    watcher.stop();

    expect(vi.getTimerCount()).toBe(0);
    // Every listener it added — `visibilitychange` and `pageshow` — is removed.
    expect(added.map(([, type]) => type).sort()).toEqual(["pageshow", "visibilitychange"]);
    for (const entry of added) expect(removed).toContainEqual(entry);
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(10 * 60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(1);
  });

  it("an ask that ends after the page was hidden leaves no timer behind", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const fetchVersions = vi.fn(() => new Promise<unknown>((resolve) => (answer = resolve)));
    const { watcher } = watcherWith(fetchVersions);
    await settle();
    expect(fetchVersions).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    answer(versions({ publicConfig: A }));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await settle(10 * 60_000);
    expect(fetchVersions).toHaveBeenCalledTimes(1);
    watcher.stop();
  });
});

describe("the pieces the reads use", () => {
  it("reads the version a response names", () => {
    expect(servedConfigVersion({ "x-config-version": A })).toBe(A);
    expect(servedConfigVersion({ get: (name: string) => (name === "x-config-version" ? B : undefined) })).toBe(B);
    expect(servedConfigVersion({})).toBeUndefined();
    expect(servedConfigVersion(undefined)).toBeUndefined();
  });

  it("puts the version in the same parameter the service worker keys on", () => {
    expect(CONFIG_VERSION_PARAM).toBe(CONFIG_VERSION_SEARCH_PARAM);
  });

  it("knows every query key that reads a watched group", () => {
    expect(WATCHED_CONFIG_GROUPS).toEqual({
      publicConfig: [["public-config"]],
      landing: [["landing"]],
      connectPage: [["connect-page"]],
      customEmojiPacks: [["custom-emoji-packs"]],
      platformPolicy: [["platform-policy"]],
      guestSupport: [["guest-support-config"]],
    });
  });
});

describe("end to end through React Query", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  /** The page's modules afresh — the watcher is one per page, and each case is a page. */
  async function freshPage(bodyOf: (url: string, version: string | undefined) => unknown) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.resetModules();
    const { apiClient } = await import("@/lib/api-client/transport");
    const { getReiwaPublicConfig } = await import("@/lib/api-client/branding");
    const { getLanding } = await import("@/lib/api-client/landing");
    const { ConfigVersionWatcherMount } = await import("@/lib/config-version-watcher-mount");
    const get = vi
      .spyOn(apiClient, "get")
      .mockImplementation(async (url: string, config?: { params?: Record<string, string> }) =>
        bodyOf(url, config?.params?.["v"]),
      );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Page() {
      const { data } = useQuery({ queryKey: ["public-config"], queryFn: getReiwaPublicConfig, staleTime: 5 * 60_000 });
      return <p data-testid="brand">{(data as { brandName?: string } | undefined)?.brandName ?? "…"}</p>;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <ConfigVersionWatcherMount queryClient={client} />
          <Page />
        </QueryClientProvider>,
      );
    });
    return { get, getLanding };
  }

  /**
   * Move the clock and let the results reach the page. The refetch is a few
   * promise hops behind the ask, and React Query hands its result to React on
   * a zero-delay timer — which the fake clock files one millisecond out when
   * it is set during a tick. So: settle in passes of 1 ms.
   */
  async function elapse(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    for (let pass = 0; pass < 4; pass += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    }
  }

  const bodies: Record<string, { brandName: string }> = { [A]: { brandName: "Before" }, [B]: { brandName: "After" } };

  it("a moved version refetches with `?v=`, and the page redraws with the new data", async () => {
    let cabinetHolds = A;
    const { get, getLanding } = await freshPage((url, version) => {
      if (url === "/config-versions") return { data: { versions: { publicConfig: cabinetHolds, landing: C } } };
      if (url === "/public-config") {
        // Without a version the browser cache answers; with one, the server.
        const served = version ?? A;
        return { data: bodies[served], headers: { "x-config-version": served } };
      }
      if (url === "/landing") return { data: { enabled: false } };
      throw new Error(`unexpected ${url}`);
    });
    await elapse(0);
    expect(container?.textContent).toBe("Before");

    // The operator saves; within a minute the open page shows it.
    cabinetHolds = B;
    await elapse(60_000);
    expect(container?.textContent).toBe("After");
    expect(get).toHaveBeenCalledWith("/public-config", { params: { [CONFIG_VERSION_PARAM]: B } });
    // A group no page read was not fetched just because it is watched.
    expect(get.mock.calls.some(([url]) => url === "/landing")).toBe(false);
    // Reads after that carry the version too — a plain read can no longer
    // bring the pre-save copy back out of the browser cache.
    await getLanding();
    expect(get).toHaveBeenLastCalledWith("/landing", { params: { [CONFIG_VERSION_PARAM]: C } });
  });

  it("a first load the browser cache answered with the pre-save copy is refetched at once", async () => {
    // Reloaded within a minute of the save: the plain read of `/public-config`
    // comes out of the browser cache — the old body, naming its old version —
    // while the cabinet already holds the new one.
    const { get } = await freshPage((url, version) => {
      if (url === "/config-versions") return { data: { versions: { publicConfig: B } } };
      if (url === "/public-config") {
        const served = version ?? A;
        return { data: bodies[served], headers: { "x-config-version": served } };
      }
      throw new Error(`unexpected ${url}`);
    });
    await elapse(0);

    // Not a minute later — as soon as both answers are in.
    expect(container?.textContent).toBe("After");
    expect(get).toHaveBeenCalledWith("/public-config", { params: { [CONFIG_VERSION_PARAM]: B } });
  });

  /** A page that reads one watched group through its real fetcher. */
  async function freshGroupPage(
    queryKey: readonly string[],
    fetcherOf: (modules: {
      getLanding: () => Promise<unknown>;
      getConnectPage: () => Promise<unknown>;
    }) => () => Promise<unknown>,
    bodyOf: (url: string, version: string | undefined) => unknown,
  ) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.resetModules();
    const { apiClient } = await import("@/lib/api-client/transport");
    const { getLanding } = await import("@/lib/api-client/landing");
    const { getConnectPage } = await import("@/lib/api-client/connect-page");
    const { ConfigVersionWatcherMount } = await import("@/lib/config-version-watcher-mount");
    const get = vi
      .spyOn(apiClient, "get")
      .mockImplementation(async (url: string, config?: { params?: Record<string, string> }) =>
        bodyOf(url, config?.params?.["v"]),
      );
    const queryFn = fetcherOf({ getLanding, getConnectPage });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Page() {
      const { data } = useQuery({ queryKey, queryFn, staleTime: 5 * 60_000 });
      return <p>{(data as { title?: string } | undefined)?.title ?? "…"}</p>;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <ConfigVersionWatcherMount queryClient={client} />
          <Page />
        </QueryClientProvider>,
      );
    });
    return { get };
  }

  const published: Record<string, { title: string }> = { [A]: { title: "Before" }, [B]: { title: "After" } };

  it("a fresh load the service worker answered with the pre-publish landing is refetched at once (review R2a-05)", async () => {
    // A new visit after a publish: the plain first read of `/landing` goes out
    // before the watcher's first answer, and the service worker answers it from
    // its cache — the old landing, naming its old version.
    const { get } = await freshGroupPage(["landing"], (m) => m.getLanding, (url, version) => {
      if (url === "/config-versions") return { data: { versions: { landing: B } } };
      if (url === "/landing") {
        const served = version ?? A;
        return { data: published[served], headers: { "x-config-version": served } };
      }
      throw new Error(`unexpected ${url}`);
    });
    await elapse(0);

    expect(container?.textContent).toBe("After");
    expect(get).toHaveBeenCalledWith("/landing", { params: { [CONFIG_VERSION_PARAM]: B } });
  });

  it("a fresh load the browser cache answered with the pre-save connect catalog is refetched at once (review R2a-05)", async () => {
    const { get } = await freshGroupPage(["connect-page"], (m) => m.getConnectPage, (url, version) => {
      if (url === "/config-versions") return { data: { versions: { connectPage: B } } };
      if (url === "/connect-page") {
        const served = version ?? A;
        return { data: published[served], headers: { "x-config-version": served } };
      }
      throw new Error(`unexpected ${url}`);
    });
    await elapse(0);

    expect(container?.textContent).toBe("After");
    expect(get).toHaveBeenCalledWith("/connect-page", { params: { [CONFIG_VERSION_PARAM]: B } });
  });
});

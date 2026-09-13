import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createConnectPageRouter, resetConnectPageCache } from "../src/api/routes/connect-page.js";
import type { AdminClient } from "../src/infrastructure/admin-client/index.js";

/**
 * The edge in front of the connect-screen catalog.
 *
 * Everything here is about what a customer gets when something upstream is
 * wrong, because the catalog itself is validated in the panel and the screen is
 * tested separately. What this route owns is the failure behaviour: the tap on
 * "Подключить" has to produce a usable screen whether or not the panel is
 * answering, and it has to stop asking the panel once the panel has stopped
 * answering.
 */

function snapshotStore(initial: unknown = null) {
  let stored = initial;
  return {
    store: {
      load: () => Promise.resolve(stored),
      save: (payload: unknown) => {
        stored = payload;
        return Promise.resolve();
      },
    },
    read: () => stored,
  };
}

function serve(adminClient: AdminClient | null, snapshots = snapshotStore().store) {
  const app = express();
  app.use("/api/v1", createConnectPageRouter(adminClient, snapshots));
  const server = http.createServer(app);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/api/v1/connect-page`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const CATALOG = { version: 2, platforms: [], icons: {}, showConnectionKeys: false };

function client(getEffective: () => Promise<unknown>): AdminClient {
  return { connectPage: { getEffective } } as unknown as AdminClient;
}

beforeEach(() => {
  // The cache is module-scoped so the invalidate webhook can drop it for the
  // whole process; that also means it leaks between tests unless reset.
  resetConnectPageCache();
});

describe("serving the catalog", () => {
  it("returns what the panel gave it, with an ETag", async () => {
    const { url, close } = await serve(client(() => Promise.resolve(CATALOG)));

    const res = await fetch(url);
    const etag = res.headers.get("etag");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CATALOG);
    expect(etag).toMatch(/^W\//);
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate");

    const repeat = await fetch(url, { headers: { "if-none-match": etag ?? "" } });
    expect(repeat.status).toBe(304);

    await close();
  });

  it("asks the panel once for a burst of taps", async () => {
    // Single-flight, not just a TTL: without it the first ten customers after
    // an expiry each open their own upstream request.
    const getEffective = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(CATALOG), 20)),
    );
    const { url, close } = await serve(client(getEffective));

    await Promise.all([fetch(url), fetch(url), fetch(url), fetch(url)]);

    expect(getEffective).toHaveBeenCalledTimes(1);
    await close();
  });
});

describe("when the panel is not answering", () => {
  it("answers null instead of failing the screen", async () => {
    // The subscription link is already on the screen the customer tapped from,
    // so a missing catalog costs the app list and the instructions — not the
    // ability to connect. A 5xx here would cost the whole screen.
    const { url, close } = await serve(client(() => Promise.reject(new Error("panel down"))));

    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    await close();
  });

  it("remembers the failure so every tap does not pay another upstream timeout", async () => {
    // The bug this pins cost a full upstream timeout per visitor for as long as
    // the panel was down, because a failed fetch left nothing cached and so
    // every following request went upstream again.
    const getEffective = vi.fn(() => Promise.reject(new Error("panel down")));
    const { url, close } = await serve(client(getEffective));

    await fetch(url);
    await fetch(url);
    await fetch(url);

    expect(getEffective).toHaveBeenCalledTimes(1);
    await close();
  });

  it("answers null when the cabinet has no panel client at all", async () => {
    const { url, close } = await serve(null);

    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    await close();
  });
});

describe("the invalidate webhook", () => {
  it("makes the next tap fetch again instead of waiting out the TTL", async () => {
    const getEffective = vi.fn(() => Promise.resolve(CATALOG));
    const { url, close } = await serve(client(getEffective));

    await fetch(url);
    await fetch(url);
    expect(getEffective).toHaveBeenCalledTimes(1);

    resetConnectPageCache();
    await fetch(url);

    expect(getEffective).toHaveBeenCalledTimes(2);
    await close();
  });
});

describe("surviving a restart while the panel is down", () => {
  it("serves the last catalog the panel actually gave, not the off switch", async () => {
    // The in-process cache only lives as long as the process. Restart the
    // cabinet mid-outage and the catalog is gone — and a missing catalog reads
    // as "the connect screen is switched off", so the feature would turn itself
    // off for everybody with nothing written anywhere to say why.
    const snapshots = snapshotStore(CATALOG);
    const { url, close } = await serve(
      client(() => Promise.reject(new Error("panel down"))),
      snapshots.store,
    );

    const res = await fetch(url);

    expect(await res.json()).toEqual(CATALOG);
    await close();
  });

  it("records only what the panel served, never the fallback", async () => {
    // Saving the fallback would make one outage permanent: the snapshot would
    // answer null forever after.
    const snapshots = snapshotStore();
    const { url, close } = await serve(
      client(() => Promise.reject(new Error("panel down"))),
      snapshots.store,
    );

    await fetch(url);

    expect(snapshots.read()).toBeNull();
    await close();
  });

  it("still answers null for a cabinet that has never reached the panel", async () => {
    const snapshots = snapshotStore();
    const { url, close } = await serve(client(() => Promise.reject(new Error("cold"))), snapshots.store);

    expect(await (await fetch(url)).json()).toBeNull();
    await close();
  });

  it("writes the snapshot on a successful read", async () => {
    const snapshots = snapshotStore();
    const { url, close } = await serve(client(() => Promise.resolve(CATALOG)), snapshots.store);

    await fetch(url);

    expect(snapshots.read()).toEqual(CATALOG);
    await close();
  });
});

describe("an invalidate that lands while a read is in flight", () => {
  // The race `generation` in the route exists for. That read may reach the panel
  // BEFORE the operator's save commits; if it settles after the webhook and may
  // still write, the pre-save catalog is served for another whole TTL — and the
  // panel already counts the event as delivered, so nothing is left to re-fire.
  const SAVED = { ...CATALOG, showConnectionKeys: true };

  /** A panel read the test answers by hand. `started` settles once the route has asked for it. */
  function heldRead() {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveRead!: (value: unknown) => void;
    let rejectRead!: (reason: unknown) => void;
    const answer = new Promise<unknown>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
    return {
      started,
      read: (): Promise<unknown> => {
        markStarted();
        return answer;
      },
      resolve: (value: unknown) => resolveRead(value),
      reject: (reason: unknown) => rejectRead(reason),
    };
  }

  /**
   * `serve`, plus `arrived(n)`: settles once `n` requests have been handed to the
   * route — which by then has already asked the cache for its answer, because
   * the router dispatches synchronously. One extra turn is taken anyway.
   */
  async function serveCounting(adminClient: AdminClient) {
    let seen = 0;
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    const app = express();
    app.use((_req, _res, next) => {
      seen += 1;
      next();
      for (const waiter of waiters.filter((w) => w.count <= seen)) waiter.resolve();
    });
    app.use("/api/v1", createConnectPageRouter(adminClient, snapshotStore().store));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/api/v1/connect-page`,
      arrived: async (count: number): Promise<void> => {
        if (seen < count) await new Promise<void>((resolve) => waiters.push({ count, resolve }));
        await new Promise((resolve) => setImmediate(resolve));
      },
      close: () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    };
  }

  it("does not let a read begun before it overwrite the catalog read after it", async () => {
    const oldRead = heldRead();
    const getEffective = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(oldRead.read)
      .mockResolvedValue(SAVED);
    const { url, close } = await serveCounting(client(getEffective));
    try {
      const beforeSave = fetch(url);
      await oldRead.started;
      resetConnectPageCache();
      expect(await (await fetch(url)).json()).toEqual(SAVED);

      oldRead.resolve(CATALOG); // the old read lands last
      expect(await (await beforeSave).json()).toEqual(CATALOG);

      expect(await (await fetch(url)).json()).toEqual(SAVED);
      expect(getEffective).toHaveBeenCalledTimes(2);
    } finally {
      await close();
    }
  });

  it("does not let a read begun before it write the durable snapshot", async () => {
    const oldRead = heldRead();
    const getEffective = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(oldRead.read)
      .mockResolvedValue(SAVED);
    const snapshots = snapshotStore();
    const { url, close } = await serve(client(getEffective), snapshots.store);
    try {
      const beforeSave = fetch(url);
      await oldRead.started;
      resetConnectPageCache();
      expect(await (await fetch(url)).json()).toEqual(SAVED);

      oldRead.resolve(CATALOG); // the old read lands last
      expect(await (await beforeSave).json()).toEqual(CATALOG);

      // What a restart during a panel outage serves.
      expect(snapshots.read()).toEqual(SAVED);
    } finally {
      await close();
    }
  });

  it("does not keep a read begun before it that lands with nobody else asking", async () => {
    const oldRead = heldRead();
    const getEffective = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(oldRead.read)
      .mockResolvedValue(SAVED);
    const { url, close } = await serveCounting(client(getEffective));
    try {
      const beforeSave = fetch(url);
      await oldRead.started;
      resetConnectPageCache();
      oldRead.resolve(CATALOG);
      expect(await (await beforeSave).json()).toEqual(CATALOG);

      expect(await (await fetch(url)).json()).toEqual(SAVED);
      expect(getEffective).toHaveBeenCalledTimes(2);
    } finally {
      await close();
    }
  });

  it("does not let a failed read begun before it park the fallback", async () => {
    const oldRead = heldRead();
    const getEffective = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(oldRead.read)
      .mockResolvedValue(SAVED);
    const { url, close } = await serveCounting(client(getEffective));
    try {
      const beforeSave = fetch(url);
      await oldRead.started;
      resetConnectPageCache();
      oldRead.reject(new Error("panel blinked"));
      expect(await (await beforeSave).json()).toBeNull();

      expect(await (await fetch(url)).json()).toEqual(SAVED);
      expect(getEffective).toHaveBeenCalledTimes(2);
    } finally {
      await close();
    }
  });

  it("does not let a read begun before it free the slot of the read started after it", async () => {
    const oldRead = heldRead();
    const newRead = heldRead();
    const getEffective = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(oldRead.read)
      .mockImplementationOnce(newRead.read)
      .mockResolvedValue(SAVED);
    const { url, arrived, close } = await serveCounting(client(getEffective));
    try {
      const beforeSave = fetch(url);
      await oldRead.started;
      resetConnectPageCache();
      const afterSave = fetch(url);
      await newRead.started;
      oldRead.resolve(CATALOG);
      expect(await (await beforeSave).json()).toEqual(CATALOG);

      // Single-flight still holds: this tap joins the read already on its way.
      const joined = fetch(url);
      await arrived(3);
      expect(getEffective).toHaveBeenCalledTimes(2);

      newRead.resolve(SAVED);
      expect(await (await joined).json()).toEqual(SAVED);
      expect(await (await afterSave).json()).toEqual(SAVED);
    } finally {
      await close();
    }
  });

  it("does not let a failed read begun before it free the slot of the read started after it", async () => {
    const oldRead = heldRead();
    const newRead = heldRead();
    const getEffective = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(oldRead.read)
      .mockImplementationOnce(newRead.read)
      .mockResolvedValue(SAVED);
    const { url, arrived, close } = await serveCounting(client(getEffective));
    try {
      const beforeSave = fetch(url);
      await oldRead.started;
      resetConnectPageCache();
      const afterSave = fetch(url);
      await newRead.started;
      oldRead.reject(new Error("panel blinked"));
      expect(await (await beforeSave).json()).toBeNull();

      const joined = fetch(url);
      await arrived(3);
      expect(getEffective).toHaveBeenCalledTimes(2);

      newRead.resolve(SAVED);
      expect(await (await joined).json()).toEqual(SAVED);
      expect(await (await afterSave).json()).toEqual(SAVED);
    } finally {
      await close();
    }
  });
});

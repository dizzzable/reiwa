import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildWebManifest,
  isSafeBrandingFile,
  BrandingAssetCache,
} from "../../src/api/branding-pwa.js";

describe("buildWebManifest", () => {
  it("uses the operator PWA icon for all icon slots", () => {
    const m = buildWebManifest({
      brandName: "Acme VPN",
      bgPrimary: "#101010",
      pwaIconUrl: "/uploads/branding/abc.png",
      logoUrl: "/uploads/branding/header.svg",
    });
    expect(m.name).toBe("Acme VPN");
    expect(m.short_name).toBe("Acme VPN");
    expect(m.theme_color).toBe("#101010");
    const icons = m.icons as Array<Record<string, string>>;
    expect(icons).toHaveLength(3);
    expect(icons.every((i) => i.src === "/uploads/branding/abc.png")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(icons.find((i) => i.sizes === "192x192")?.type).toBe("image/png");
  });

  it("falls back to logoUrl when no dedicated PWA icon is set", () => {
    const m = buildWebManifest({ brandName: "Acme", logoUrl: "/uploads/branding/h.webp" });
    const icons = m.icons as Array<Record<string, string>>;
    expect(icons.every((i) => i.src === "/uploads/branding/h.webp")).toBe(true);
    expect(icons[0]!.type).toBe("image/webp");
  });

  it("declares sizes:any for an SVG / data icon", () => {
    const m = buildWebManifest({ brandName: "Acme", pwaIconUrl: "/uploads/branding/x.svg" });
    const icons = m.icons as Array<Record<string, string>>;
    expect(icons.every((i) => i.sizes === "any")).toBe(true);
    expect(icons[0]!.type).toBe("image/svg+xml");
  });

  it("serves the default Reiwa icons + name when branding is null", () => {
    const m = buildWebManifest(null);
    expect(m.name).toBe("Reiwa");
    const icons = m.icons as Array<Record<string, string>>;
    expect(icons[0]!.src).toBe("/icons/icon-192x192.png");
    expect(icons.some((i) => i.src === "/icons/icon-512x512.png")).toBe(true);
  });
});

describe("isSafeBrandingFile", () => {
  it("accepts a bare filename and rejects traversal", () => {
    expect(isSafeBrandingFile("abc123.png")).toBe(true);
    expect(isSafeBrandingFile("../etc/passwd")).toBe(false);
    expect(isSafeBrandingFile("a/b.png")).toBe(false);
    expect(isSafeBrandingFile("..")).toBe(false);
  });
});

describe("BrandingAssetCache", () => {
  let dir: string;
  let cache: BrandingAssetCache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), "branding-cache-"));
    cache = new BrandingAssetCache(dir);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null for an unsafe filename", async () => {
    const out = await cache.resolve({ file: "../x", adminBaseUrl: "http://admin" });
    expect(out).toBeNull();
  });

  it("fetches once from admin then serves from disk cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {},
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await cache.resolve({ file: "logo.png", adminBaseUrl: "http://admin" });
    expect(first?.buffer.length).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call is served from disk — no further upstream fetch.
    const second = await cache.resolve({ file: "logo.png", adminBaseUrl: "http://admin" });
    expect(second?.buffer.length).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves the cached copy when the admin host is unreachable", async () => {
    // Prime the cache.
    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {},
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    });
    vi.stubGlobal("fetch", okFetch);
    await cache.resolve({ file: "logo.png", adminBaseUrl: "http://admin" });

    // Admin down — cached read still succeeds (fetch not even reached).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const out = await cache.resolve({ file: "logo.png", adminBaseUrl: "http://admin" });
    expect(out?.buffer.length).toBe(1);
  });

  it("returns null when admin is down and nothing is cached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const out = await cache.resolve({ file: "missing.png", adminBaseUrl: "http://admin" });
    expect(out).toBeNull();
  });
});

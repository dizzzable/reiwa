/**
 * PWA white-label helpers for the reiwa edge.
 *
 * Two concerns:
 *  1. `buildWebManifest(branding)` — a pure function that turns the operator
 *     branding payload into a Web App Manifest (name + theme + icons), used by
 *     the dynamic `GET /manifest.webmanifest` route so installs show the
 *     operator's brand instead of "Reiwa".
 *  2. `BrandingAssetCache` — a disk mirror for `/uploads/branding/*` so the
 *     logo/icon survives an admin-panel outage: fetch-once from the admin host,
 *     cache on disk, serve from cache thereafter. On admin-down with no cache
 *     the route falls back to the default Reiwa icon (never a broken image).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

// ── Default (Reiwa) PWA icons, served as static files from web/dist ──────────
const DEFAULT_ICONS = [
  { src: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png" },
  { src: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png" },
  {
    src: "/icons/icon-512x512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
] as const;

const DEFAULT_THEME = "#020202";

interface BrandingLike {
  readonly brandName?: string | null;
  readonly logoUrl?: string | null;
  readonly pwaIconUrl?: string | null;
  readonly bgPrimary?: string | null;
}

/** MIME type for a manifest icon `src` from its extension / data URI. */
function iconType(src: string): string {
  const lower = src.toLowerCase();
  if (lower.startsWith("data:")) {
    const m = /^data:([a-z0-9+.-]+\/[a-z0-9+.-]+)/i.exec(src);
    return m ? m[1] : "image/png";
  }
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

/**
 * Build the Web App Manifest object from operator branding. Falls back to the
 * default Reiwa icons when no operator icon is configured so installability
 * never breaks. SVG / data icons declare `sizes: "any"` (vectors scale).
 */
export function buildWebManifest(branding: BrandingLike | null | undefined): Record<string, unknown> {
  const name = (branding?.brandName ?? "").trim() || "Reiwa";
  const theme = (branding?.bgPrimary ?? "").trim() || DEFAULT_THEME;
  const icon = ((branding?.pwaIconUrl ?? "").trim() || (branding?.logoUrl ?? "").trim()) || null;

  let icons: ReadonlyArray<Record<string, string>>;
  if (icon) {
    const type = iconType(icon);
    if (type === "image/svg+xml" || icon.toLowerCase().startsWith("data:")) {
      icons = [
        { src: icon, sizes: "any", type, purpose: "any" },
        { src: icon, sizes: "any", type, purpose: "maskable" },
      ];
    } else {
      icons = [
        { src: icon, sizes: "192x192", type },
        { src: icon, sizes: "512x512", type },
        { src: icon, sizes: "512x512", type, purpose: "maskable" },
      ];
    }
  } else {
    icons = DEFAULT_ICONS as ReadonlyArray<Record<string, string>>;
  }

  return {
    name,
    short_name: name,
    description: `${name}`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: theme,
    background_color: theme,
    icons,
  };
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Bare-filename guard shared by the proxy + cache (no traversal). */
export function isSafeBrandingFile(file: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(file) && !file.includes("..");
}

/**
 * Disk-backed mirror of admin-hosted `/uploads/branding/*` assets. Survives an
 * admin outage once an asset has been fetched at least once.
 */
export class BrandingAssetCache {
  private readonly dir: string;
  private ensured = false;

  constructor(dir?: string) {
    this.dir =
      dir ??
      process.env["BRANDING_CACHE_DIR"] ??
      path.join(process.cwd(), ".cache", "branding");
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await fs.mkdir(this.dir, { recursive: true });
    this.ensured = true;
  }

  /** Remove every cached asset (called on the branding-invalidate webhook). */
  public async evict(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true }).catch((): void => undefined);
    this.ensured = false;
  }

  /**
   * Resolve a branding asset: cache → fetch-once from admin → cache. Returns
   * `null` when the file is invalid, or unavailable both in cache and upstream
   * (the caller then serves the default icon).
   */
  public async resolve(input: {
    readonly file: string;
    readonly adminBaseUrl: string | null;
    readonly logger?: Logger;
  }): Promise<{ buffer: Buffer; contentType: string } | null> {
    const { file, adminBaseUrl, logger } = input;
    if (!isSafeBrandingFile(file)) return null;

    const ext = path.extname(file).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
    const cachePath = path.join(this.dir, file);

    // 1. Serve from disk cache when present.
    try {
      const buffer = await fs.readFile(cachePath);
      return { buffer, contentType };
    } catch {
      /* not cached yet — fall through to fetch */
    }

    // 2. Fetch once from the admin host, then cache.
    if (!adminBaseUrl) return null;
    try {
      const upstream = await fetch(`${adminBaseUrl}/uploads/branding/${file}`);
      if (!upstream.ok || !upstream.body) return null;
      const buffer = Buffer.from(await upstream.arrayBuffer());
      await this.ensureDir();
      await fs.writeFile(cachePath, buffer, { mode: 0o644 }).catch((): void => undefined);
      const upstreamType = upstream.headers.get("content-type");
      return { buffer, contentType: upstreamType ?? contentType };
    } catch (err) {
      logger?.debug?.({ err, file }, "branding asset fetch failed");
      return null;
    }
  }
}

// ── Process-wide singleton (shared by the proxy route + webhook eviction) ────
let singleton: BrandingAssetCache | null = null;

export function getBrandingAssetCache(): BrandingAssetCache {
  if (singleton === null) singleton = new BrandingAssetCache();
  return singleton;
}

/** Drop the on-disk branding mirror (called on the branding-invalidate webhook). */
export async function evictBrandingAssetCache(): Promise<void> {
  await getBrandingAssetCache().evict();
}

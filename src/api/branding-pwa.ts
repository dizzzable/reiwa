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
  readonly tagline?: string | null;
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
 * Can iOS "Add to Home Screen" decode this as an `apple-touch-icon`?
 *
 * Vectors cannot: Apple documents PNG for that slot and Safari does not render
 * an SVG there. Everything else is left alone deliberately — WebP and the rest
 * are raster formats Safari decodes elsewhere, and guessing them wrong would
 * push a worse image at the operator to fix a problem they do not have.
 */
function isRasterIcon(src: string): boolean {
  return iconType(src) !== "image/svg+xml";
}

/**
 * Build the Web App Manifest object from operator branding. Falls back to the
 * default Reiwa icons when no operator icon is configured so installability
 * never breaks. SVG / data icons declare `sizes: "any"` (vectors scale).
 */
export function buildWebManifest(branding: BrandingLike | null | undefined): Record<string, unknown> {
  const name = (branding?.brandName ?? "").trim() || "Reiwa";
  const theme = (branding?.bgPrimary ?? "").trim() || DEFAULT_THEME;
  const description = (branding?.tagline ?? "").trim() || name;
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
    description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: theme,
    background_color: theme,
    icons,
  };
}

/**
 * Longest operator icon URL inlined into the SPA document head.
 *
 * `pwaIconUrl` may legitimately be a base64 `data:` URI of up to 512 KB. The
 * manifest can carry one of those — it is fetched once, by the install
 * machinery. The document cannot: it would be paid twice on EVERY page load,
 * on mobile, to decorate a tab and a home-screen icon. Above this cap the
 * stock link is left alone and `branding-provider.tsx` still swaps it from
 * React after boot, which is the pre-existing behaviour for every icon.
 */
const MAX_INLINE_HEAD_ICON_LENGTH = 2_048;

const APPLE_TOUCH_ICON_TAG = /<link\b[^>]*\brel=(["'])apple-touch-icon\1[^>]*>/i;
const FAVICON_TAG = /<link\b[^>]*\brel=(["'])icon\1[^>]*>/i;
const APPLE_WEB_APP_TITLE_TAG =
  /<meta\b[^>]*\bname=(["'])apple-mobile-web-app-title\1[^>]*>/i;

/** Escape a value for an HTML double-quoted attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Rewrite `tag` when the template still carries it; otherwise append to head. */
function replaceOrAppendInHead(html: string, tag: RegExp, replacement: string): string {
  // `() => replacement`, never the bare string: a STRING replacement expands
  // `$&`, "$`" and `$'`, and `replacement` is built from operator branding.
  // `escapeHtmlAttribute` cannot neutralise them — it CREATES them, since every
  // entity it writes starts with `&`, so a `$` anywhere before an escaped
  // character becomes `$&` and splices the matched tag into its own attribute
  // value. A replacer function is passed through verbatim.
  if (tag.test(html)) return html.replace(tag, () => replacement);
  const headEnd = html.indexOf("</head>");
  if (headEnd === -1) return html;
  return `${html.slice(0, headEnd)}${replacement}${html.slice(headEnd)}`;
}

/**
 * Point the icon tags baked into `web/index.html` at the operator's brand.
 *
 * WHY THE SERVER HAS TO DO THIS AT ALL. `branding-provider.tsx` already swaps
 * `apple-touch-icon`, `rel="icon"` and `apple-mobile-web-app-title` — but it
 * does so from a React effect, i.e. after the bundle has downloaded, parsed
 * and run, and after the public-config query has resolved. Every consumer that
 * reads the head from the DELIVERED BYTES rather than the live DOM therefore
 * sees "Reiwa" and `/icons/icon-192x192.png`: crawlers, social unfurlers, and
 * — the reason this exists — iOS "Add to Home Screen", which is documented
 * against `apple-touch-icon` and gives no way to observe whether it read the
 * head before or after the SPA booted. Doing it here removes the race instead
 * of betting on it.
 *
 * The dynamic manifest covers Android/Chrome installs; this covers Safari and
 * the browser tab. Both read the same `pwaIconUrl → logoUrl` fallback, so an
 * operator never gets one surface branded and the other stock.
 *
 * Pure and total: unknown branding, a missing tag or a missing `</head>` all
 * return usable HTML rather than throwing inside a document response.
 */
export function applyBrandingHead(
  html: string,
  branding: BrandingLike | null | undefined,
): string {
  // The operator brand chain, in the order every other surface reads it.
  // Oversized entries are dropped here rather than at the end, so a candidate
  // too large to inline cannot hide a usable one behind it.
  const candidates = [(branding?.pwaIconUrl ?? "").trim(), (branding?.logoUrl ?? "").trim()]
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => candidate.length <= MAX_INLINE_HEAD_ICON_LENGTH);
  // The first candidate that FITS, not the first in the raw chain. Reading it
  // from the raw chain re-created exactly what the filter above exists to
  // prevent: an oversized `pwaIconUrl` (a 512 KB data URI is a legal
  // configuration — the manifest still carries it) left `icon` null and skipped
  // this whole block, so a white-label operator whose `logoUrl` was perfectly
  // usable got served `/icons/icon-192x192.png` — Reiwa's own icon, and the
  // exact complaint this surface exists to answer.
  const icon = candidates[0] ?? null;
  // `apple-touch-icon` is not just "the icon, again for Safari": it is the ONLY
  // input iOS "Add to Home Screen" has for the home-screen icon — it does not
  // read the manifest for this, and when the link is unusable it falls back to
  // a screenshot of the page rather than to anything branded. Apple's
  // configuration guide specifies PNG there, and Safari does not decode an SVG
  // in that slot. The panel's branding upload accepts png/webp/SVG alike, so
  // "operator picked a vector" is an ordinary configuration, not an edge case,
  // and it produced a manifest and a favicon that were perfectly branded above
  // an iPhone home screen with no logo on it.
  //
  // So this slot — and only this slot — skips to the next link in the same
  // `pwaIconUrl → logoUrl` chain when the preferred one is a vector. If NOTHING
  // in the chain is raster the vector still wins: a white-label operator must
  // never be handed `/icons/icon-192x192.png`, which is Reiwa's own icon and
  // the complaint this whole surface exists to answer.
  const appleTouchIcon =
    icon === null ? null : (candidates.find(isRasterIcon) ?? icon);
  const name = (branding?.brandName ?? "").trim() || null;

  let out = html;
  if (icon !== null && appleTouchIcon !== null) {
    out = replaceOrAppendInHead(
      out,
      APPLE_TOUCH_ICON_TAG,
      `<link rel="apple-touch-icon" href="${escapeHtmlAttribute(appleTouchIcon)}" />`,
    );
    // The tab favicon keeps the operator's FIRST choice even when the line
    // above had to step past it: an SVG favicon is supported everywhere a tab
    // exists and stays crisp at every size, so the two slots legitimately
    // disagree. The stock tag carries `type="image/svg+xml"`; it is dropped
    // rather than carried over, because the operator icon is usually a PNG and
    // a lying `type` is worse than none.
    out = replaceOrAppendInHead(
      out,
      FAVICON_TAG,
      `<link rel="icon" href="${escapeHtmlAttribute(icon)}" />`,
    );
  }
  if (name !== null) {
    out = replaceOrAppendInHead(
      out,
      APPLE_WEB_APP_TITLE_TAG,
      `<meta name="apple-mobile-web-app-title" content="${escapeHtmlAttribute(name)}" />`,
    );
  }
  return out;
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
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file) &&
    !file.includes("..")
  );
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

/**
 * Banner URL → Telegram-sendable photo source.
 *
 * The admin-managed banner can come from several places, with
 * different consequences for how reiwa-bot should send it:
 *
 *   • Absolute HTTPS URL (e.g. CDN, public S3) → pass to
 *     `replyWithPhoto` directly. Telegram pulls it, our process
 *     never touches the bytes.
 *
 *   • Telegram `file_id` (operator pasted one from another bot) →
 *     same as above. Telegram resolves it from its own storage.
 *
 *   • Relative `/uploads/bot-banners/<id>.jpg` URL → admin host
 *     served the file behind a path that's only reachable from the
 *     docker network. We HAVE to fetch the bytes ourselves and ship
 *     them as `InputFile` so Telegram pulls from us instead.
 *
 *   • Empty / missing → fall through to the BannerStore filesystem
 *     lookup chain (caller's responsibility, not ours).
 *
 * This helper handles only the first three legs and returns either
 * a string (URL or file_id) or an `InputFile` ready for grammy's
 * `replyWithPhoto`.
 */
import { InputFile } from 'grammy';

/**
 * What `start.ts` passes to `ctx.replyWithPhoto`. grammy accepts a
 * URL string, a Telegram `file_id`, or an `InputFile` (which it
 * uploads as multipart/form-data). All three roundtrip through one
 * `replyWithPhoto` call without further branching at the call site.
 */
export type BannerPhotoSource = string | InputFile;

export interface BannerResolverDeps {
  /** Admin host base URL (`http://rezeis:8000` or `https://admin.example.com`). */
  readonly rezeisAdminUrl: string | null;
  /** Optional logger for the rare upstream-fetch failure. */
  readonly logger?: { warn: (obj: unknown, msg: string) => void };
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Maximum size of a Telegram photo (10MB officially; we cap at 9MB
 * to leave headroom for our buffer overhead). Anything bigger
 * gets rejected and falls through to the filesystem default.
 */
const MAX_PHOTO_BYTES = 9 * 1024 * 1024;

const RELATIVE_UPLOADS_RE = /^\/uploads\//;

/**
 * Map a configured banner reference to the value `replyWithPhoto`
 * should receive. Returns `null` when the URL points at an admin
 * upload but reiwa-bot can't reach the admin host (no
 * `REZEIS_HOST` env), so the caller can fall through to the
 * filesystem default instead of erroring out the welcome flow.
 */
export async function resolveBannerSource(
  rawUrl: string,
  deps: BannerResolverDeps,
): Promise<BannerPhotoSource | null> {
  const url = rawUrl.trim();
  if (url.length === 0) return null;

  // Telegram file_id: opaque alphanumeric blob, never starts with `/`
  // or `http`. Pass through verbatim — Telegram resolves it.
  if (!url.startsWith('/') && !url.startsWith('http')) {
    return url;
  }

  // Absolute URL — Telegram fetches it itself.
  if (/^https?:\/\//i.test(url)) return url;

  // Relative `/uploads/...` — fetch from admin and wrap as InputFile.
  if (RELATIVE_UPLOADS_RE.test(url)) {
    if (deps.rezeisAdminUrl === null) {
      deps.logger?.warn(
        { url },
        'banner-resolver: admin host unconfigured, cannot resolve relative upload URL',
      );
      return null;
    }
    const fullUrl = `${deps.rezeisAdminUrl.replace(/\/+$/, '')}${url}`;
    const fetcher = deps.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(fullUrl);
    } catch (err: unknown) {
      deps.logger?.warn({ err, fullUrl }, 'banner-resolver: fetch threw');
      return null;
    }
    if (!response.ok) {
      deps.logger?.warn(
        { status: response.status, fullUrl },
        'banner-resolver: admin returned non-2xx',
      );
      return null;
    }
    const lenHeader = response.headers.get('content-length');
    if (lenHeader !== null) {
      const contentLength = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_BYTES) {
        deps.logger?.warn(
          { contentLength, fullUrl },
          'banner-resolver: admin file exceeds Telegram photo size limit',
        );
        return null;
      }
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_PHOTO_BYTES) {
      deps.logger?.warn(
        { bytes: buffer.length, fullUrl },
        'banner-resolver: downloaded body exceeds size limit',
      );
      return null;
    }
    // Strip the path prefix; grammy uses the InputFile name only as a
    // hint in multipart and Telegram ignores it for photo uploads.
    const name = url.split('/').pop() ?? 'banner.jpg';
    return new InputFile(buffer, name);
  }

  // Some other absolute path we don't know how to resolve. Punt.
  deps.logger?.warn({ url }, 'banner-resolver: unsupported URL scheme');
  return null;
}

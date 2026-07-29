export type FaqMediaKind = "image" | "video" | "unsupported";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "ogv", "webm"]);
const SAME_ORIGIN_BASE = "https://faq-media.invalid";

/**
 * Returns a stable, clean list for rendering. The API contract is string[],
 * but the runtime guard keeps a malformed operator entry from crashing FAQ.
 */
export function normalizeFaqMediaUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .filter((url) => url.length > 0 && isSafeFaqMediaUrl(url)),
  )];
}

/**
 * Detects the media element from the file extension while ignoring a CDN
 * query string or fragment. Unknown formats are deliberately not guessed.
 */
export function getFaqMediaKind(url: string): FaqMediaKind {
  const pathname = getPathname(url);
  const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();

  if (!extension) return "unsupported";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "unsupported";
}

function getPathname(url: string): string {
  try {
    return new URL(url, SAME_ORIGIN_BASE).pathname;
  } catch {
    return url.split(/[?#]/, 1)[0] ?? "";
  }
}

function isSafeFaqMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url, SAME_ORIGIN_BASE);

    if (parsed.origin === SAME_ORIGIN_BASE) return url.startsWith("/");
    if (parsed.protocol !== "https:") return false;

    return /^https:\/\//i.test(url);
  } catch {
    return false;
  }
}

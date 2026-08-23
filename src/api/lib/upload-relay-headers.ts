/**
 * Response headers for every reiwa route that re-serves bytes out of the rezeis
 * `/uploads/*` tree onto the subscriber-facing origin.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * rezeis serves operator-uploaded files with `express.static`, deliberately
 * outside its `setGlobalPrefix('api')` and therefore outside every guard and
 * interceptor, so `setHeaders` is the only place a response header can attach
 * there. It attaches three, and they are the SECOND layer under the upload
 * validators: `assertSafeSvg` decides what may be written, these decide what a
 * browser may do with what was written. A gap in that reject-list then costs an
 * upload rather than an execution.
 *
 * reiwa does not proxy those directories transparently — it RELAYS them through
 * its own Express handlers, and each handler used to copy exactly two headers
 * from upstream: `Content-Type` and `Cache-Control`. None of the three
 * protective headers survived the hop, so on the subscriber-facing origin an
 * uploaded `.svg` was served as a plain, cacheable, script-capable,
 * SAME-ORIGIN document. The panel accepts `image/svg+xml` for branding and icon
 * uploads, `isSafeBrandingFile` here validates only the FILENAME, and the
 * content-side reject-list upstream is known to be incomplete (non-ASCII
 * namespace prefixes, including an invisible U+200C, execute in Chrome 148).
 * The second layer had to exist on this origin too.
 *
 * What each header defends against — verbatim from the rezeis rationale:
 *   - `Content-Security-Policy: default-src 'none'; sandbox` — an SVG opened as
 *     a top-level document gets no script, no network, and an opaque origin, so
 *     it cannot reach the subscriber session even if it carries active content.
 *     Set on EVERY relayed upload, not only markup: it costs nothing on a PNG.
 *     It also REPLACES the app-wide helmet policy on these responses, which is
 *     the SPA policy (`default-src 'self'`, same-origin `script-src`) and was
 *     never written to contain a hostile document.
 *   - `X-Content-Type-Options: nosniff` — stops a mislabelled file from being
 *     re-typed into something executable.
 *   - `Content-Disposition: attachment` for markup extensions — navigating to
 *     the file downloads it instead of rendering it in the serving origin.
 *     Subresource loads are unaffected, so `<img src="/uploads/branding/x.svg">`
 *     and the PWA manifest icon still render.
 *
 * ── MIRROR, NOT A SHARED MODULE ─────────────────────────────────────────────
 * This is a hand-copy of `applyUploadResponseHeaders` and its neighbouring
 * `MARKUP_UPLOAD_EXTENSIONS` in
 *   rezeis/rezeis-admin/src/main.ts
 * The two repositories build, version and deploy independently and share no
 * package, so the values below are duplicated ON PURPOSE and NOTHING enforces
 * that the copies stay equal — no test in either repository can observe the
 * other. If that rezeis function changes, this one has to be changed by hand,
 * and the pinning test in `test/api/upload-relay-headers.test.ts` will keep
 * passing while the two origins disagree.
 */

/** Mirrors the CSP string in rezeis `applyUploadResponseHeaders`. */
export const UPLOAD_RELAY_CSP = "default-src 'none'; sandbox";

/** Mirrors the `X-Content-Type-Options` value in rezeis. */
export const UPLOAD_RELAY_NOSNIFF = "nosniff";

/** Mirrors the `Content-Disposition` value rezeis sets on markup uploads. */
export const UPLOAD_RELAY_MARKUP_DISPOSITION = "attachment";

/**
 * Extensions that a browser will render as an active document when navigated
 * to. Mirrors `MARKUP_UPLOAD_EXTENSIONS` in rezeis `src/main.ts`.
 */
export const MARKUP_UPLOAD_EXTENSIONS: readonly string[] = [
  ".svg",
  ".svgz",
  ".xml",
  ".xhtml",
  ".html",
  ".htm",
  ".xht",
];

/**
 * Apply the rezeis `/uploads` header policy to a relayed response.
 *
 * `fileName` is the upload's own name (or path) — the caller has already
 * validated it; this only reads its extension. Call it on every byte-serving
 * branch, including the ones answered from reiwa's own disk mirror: a cached
 * copy survives an admin outage and is exactly the branch a partial fix leaves
 * bare.
 */
export function applyUploadRelayHeaders(
  res: { setHeader(name: string, value: string): void },
  fileName: string,
): void {
  res.setHeader("X-Content-Type-Options", UPLOAD_RELAY_NOSNIFF);
  res.setHeader("Content-Security-Policy", UPLOAD_RELAY_CSP);
  const lower = fileName.toLowerCase();
  if (MARKUP_UPLOAD_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    res.setHeader("Content-Disposition", UPLOAD_RELAY_MARKUP_DISPOSITION);
  }
}

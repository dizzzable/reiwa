import { Router } from "express";
import type { AdminClient } from "../../lib/admin-client.js";
import type { SessionStore } from "../../lib/session-store.js";
import type { ReiwaConfig } from "../../config.js";
import { createFlexibleSessionMiddleware, type AuthRequest } from "../middleware/session.js";
import { requireMode } from "../middleware/access-mode.js";
import { resolveUserIdentity } from "../middleware/user-identity.js";
import { buildPaymentReturnUrl, resolvePurchaseContext } from "../../lib/payment-return-url.js";
import { sendSafeError } from "../lib/error-response.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

const FAQ_UPLOAD_PREFIX = "/uploads/faq/";
const FAQ_MEDIA_PROXY_PREFIX = "/api/v1/faq/media/";
const FAQ_MEDIA_FILE_NAME =
  /^[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|ogv)$/i;
const FAQ_MEDIA_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/ogg",
]);

/**
 * Content router — operator-managed read-only content the SPA renders:
 *   - FAQ articles (settings → FAQ)
 *   - Plan add-ons (purchase flow extras) + add-on checkout
 *
 * FAQ + add-on listing are public (non-sensitive, needed pre-auth). A missing
 * admin client degrades to empty payloads, while configured upstream failures
 * surface as safe 502 responses. The add-on purchase endpoint requires an
 * authenticated session (WebSession reiwa_id or legacy Telegram).
 */
export function createContentRouter(deps: {
  adminClient: AdminClient | null;
  sessionStore: SessionStore | null;
  config: ReiwaConfig;
}) {
  const { adminClient, sessionStore, config } = deps;
  const requireSession = createFlexibleSessionMiddleware(sessionStore);
  const router = Router();

  // GET /api/v1/faq?locale=ru — operator-managed FAQ items.
  // Returns `{ items: [...] }` so the SPA's existing fetch shape works.
  router.get("/faq", async (req, res) => {
    // FAQ changes are operator-driven and must be visible immediately. Keep
    // browser/proxy heuristics from caching a success or a transient 502.
    res.setHeader("Cache-Control", "no-store");
    try {
      const locale =
        typeof req.query["locale"] === "string"
          ? (req.query["locale"] as string)
          : undefined;
      const items = await adminClient?.faq.getPublicFaq(locale);
      res.json({
        items: (items ?? []).map((item) => ({
          ...item,
          mediaUrls: normalizeFaqMediaUrls(item.mediaUrls),
        })),
      });
    } catch (e: unknown) {
      sendSafeError(req, res, e, 502, "FAQ unavailable", "faq/list");
    }
  });

  // GET /api/v1/legal-documents?locale=ru — the agreement / offer the operator
  // enabled, as plain text.
  //
  // Public on purpose: the sign-up form has to render these before any account
  // exists, so this is one of the few routes reachable without a session.
  //
  // Rides the FAQ channel — `no-store`, and NOT `/branding` or `/public-config`
  // — for a reason that matters here more than it does for help articles.
  // `/branding` lands in the service worker for up to 24 hours and
  // `/public-config` sits behind four cache layers including a localStorage
  // snapshot; either could show a visitor a document the operator has already
  // rewritten, or keep offering one they switched off. A legal text is the last
  // thing that should be served from a stale copy.
  //
  // An upstream outage returns 502 rather than an empty list. Empty would read
  // as "the operator requires nothing", the form would drop its checkboxes, and
  // the sign-up would then be refused by the panel with a mismatch nobody can
  // see. Failing loudly keeps the two ends telling the same story.
  router.get("/legal-documents", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const locale =
        typeof req.query["locale"] === "string"
          ? (req.query["locale"] as string)
          : undefined;
      const documents = await adminClient?.legalDocuments.list(locale);
      res.json({ documents: documents ?? [] });
    } catch (e: unknown) {
      sendSafeError(
        req,
        res,
        e,
        502,
        "Legal documents unavailable",
        "legal-documents/list",
      );
    }
  });

  // GET /api/v1/faq/media/:fileName - same-origin streaming proxy for FAQ
  // uploads stored by rezeis-admin. Browser video controls issue Range
  // requests while seeking, so the byte range and 206 metadata are preserved.
  router.get("/faq/media/:fileName", async (req, res) => {
    const rawFileName = req.params["fileName"];
    const fileName = Array.isArray(rawFileName)
      ? (rawFileName[0] ?? "")
      : (rawFileName ?? "");
    if (!isSafeFaqMediaFileName(fileName)) {
      res.status(400).json({ message: "Invalid FAQ media path" });
      return;
    }

    const range = req.get("range");
    if (range !== undefined && !isSafeSingleRange(range)) {
      res.setHeader("Accept-Ranges", "bytes");
      res.status(416).end();
      return;
    }

    try {
      const file = await adminClient?.faq.downloadMedia(fileName, range);
      if (!file) {
        res.status(404).json({ message: "FAQ media not found" });
        return;
      }

      if (file.status === 404) {
        discardStream(file.body);
        res.status(404).json({ message: "FAQ media not found" });
        return;
      }
      if (file.status === 416) {
        discardStream(file.body);
        if (file.contentRange) res.setHeader("Content-Range", file.contentRange);
        res.setHeader("Accept-Ranges", file.acceptRanges ?? "bytes");
        res.status(416).end();
        return;
      }
      if (file.status !== 200 && file.status !== 206) {
        discardStream(file.body);
        sendSafeError(
          req,
          res,
          new Error(`FAQ media upstream returned ${file.status}`),
          502,
          "FAQ media unavailable",
          "faq/media",
        );
        return;
      }
      if (!isAllowedFaqMediaContentType(file.contentType)) {
        discardStream(file.body);
        sendSafeError(
          req,
          res,
          new Error("FAQ media upstream returned an unsupported content type"),
          502,
          "FAQ media unavailable",
          "faq/media",
        );
        return;
      }
      if (file.status === 206 && file.contentRange === null) {
        discardStream(file.body);
        sendSafeError(
          req,
          res,
          new Error("FAQ media upstream omitted Content-Range for a 206 response"),
          502,
          "FAQ media unavailable",
          "faq/media",
        );
        return;
      }
      if (res.destroyed || res.writableEnded) {
        destroyStream(file.body);
        return;
      }

      res.status(file.status);
      res.setHeader("Content-Type", file.contentType!);
      if (file.contentLength !== null) {
        res.setHeader("Content-Length", String(file.contentLength));
      }
      if (file.contentRange) res.setHeader("Content-Range", file.contentRange);
      res.setHeader("Accept-Ranges", file.acceptRanges ?? "bytes");
      if (file.etag) res.setHeader("ETag", file.etag);
      if (file.lastModified) res.setHeader("Last-Modified", file.lastModified);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");

      file.body.on("error", (streamError: unknown) => {
        getRequestLogger(req).warn(
          { err: streamError, fileName },
          "GET /faq/media/:fileName stream failed",
        );
        if (!res.headersSent) res.status(502).json({ message: "FAQ media unavailable" });
        else res.destroy();
      });
      // Stop pulling from rezeis when a browser closes the accordion/page or
      // cancels video seeking before the current range has finished.
      res.once("close", () => {
        if (!res.writableEnded) destroyStream(file.body);
      });
      file.body.pipe(res);
    } catch (e: unknown) {
      sendSafeError(req, res, e, 502, "FAQ media unavailable", "faq/media");
    }
  });

  // GET /api/v1/add-ons/plan/:planId — active add-ons for a plan.
  // An upstream OUTAGE surfaces as 502 (not a masked empty catalog) so the SPA
  // can tell "no add-ons for this plan" from "backend unavailable" and show a
  // retry affordance. A NULL adminClient (not yet configured) still degrades to
  // an empty list rather than erroring.
  router.get("/add-ons/plan/:planId", async (req, res) => {
    try {
      const planId = String(req.params["planId"]);
      const addOns = await adminClient?.addOns.listForPlan(planId);
      res.json({ addOns: addOns ?? [] });
    } catch (e: unknown) {
      sendSafeError(req, res, e, 502, "Add-on catalog unavailable", "add-ons/catalog");
    }
  });

  // GET /api/v1/add-ons/subscriptions/:subscriptionId — v2 subscription-scoped
  // eligibility. Unlike the legacy plan list, an upstream OUTAGE is NOT
  // collapsed into an empty catalog: the error propagates so the client can
  // distinguish "no eligible add-ons" (availability: EMPTY) from "backend
  // unavailable". The backend remains the sole authority on eligibility/price.
  router.get(
    "/add-ons/subscriptions/:subscriptionId",
    requireSession,
    async (req: AuthRequest, res) => {
      try {
        const subscriptionId = String(req.params["subscriptionId"]);
        const result = await adminClient?.addOns.listForSubscription(
          subscriptionId,
          resolveUserIdentity(req),
        );
        res.json(result ?? { contractVersion: 2, availability: "EMPTY", target: null, addOns: [] });
      } catch (e: unknown) {
        sendSafeError(req, res, e, 502, "Add-on eligibility unavailable", "add-ons/eligibility");
      }
    },
  );

  // POST /api/v1/add-ons/purchase — checkout an add-on top-up for an
  // existing subscription. Context-aware return URLs mirror the payments
  // route (TMA deep link vs web origin).
  router.post(
    "/add-ons/purchase",
    requireSession,
    requireMode('purchase.addon'),
    async (req: AuthRequest, res) => {
      try {
        const { addOnId, subscriptionId, gatewayType, source } = (req.body ?? {}) as Record<
          string,
          unknown
        >;
        if (!addOnId || !subscriptionId || !gatewayType) {
          res.status(400).json({
            message: "addOnId, subscriptionId and gatewayType are required",
          });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const context = resolvePurchaseContext(req.context, source);
        const successUrl = buildPaymentReturnUrl({
          context,
          config,
          override: null,
        });
        const result = await adminClient?.addOns.purchase({
          identity: resolveUserIdentity(req),
          addOnId: String(addOnId),
          subscriptionId: String(subscriptionId),
          gatewayType: String(gatewayType),
          channel: context === "tma" ? "TELEGRAM" : "WEB",
          successUrl,
          failUrl: successUrl,
          expectedAddOnRevision:
            typeof body["expectedAddOnRevision"] === "number"
              ? body["expectedAddOnRevision"]
              : undefined,
          idempotencyKey:
            typeof body["idempotencyKey"] === "string" ? body["idempotencyKey"] : undefined,
          contractVersion:
            typeof body["contractVersion"] === "number" ? body["contractVersion"] : undefined,
        });
        res.json(result ?? {});
      } catch (e: unknown) {
        sendSafeError(req, res, e, 400, "Add-on purchase failed", "add-ons/purchase");
      }
    },
  );

  return router;
}

/** Rewrites admin-host-relative FAQ uploads to the public Reiwa origin. */
export function normalizeFaqMediaUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const url = entry.trim();
    if (url.startsWith(FAQ_UPLOAD_PREFIX)) {
      const fileName = url.slice(FAQ_UPLOAD_PREFIX.length);
      if (isSafeFaqMediaFileName(fileName)) {
        normalized.push(`${FAQ_MEDIA_PROXY_PREFIX}${encodeURIComponent(fileName)}`);
      }
      continue;
    }
    if (url.startsWith(FAQ_MEDIA_PROXY_PREFIX)) {
      const encodedFileName = url.slice(FAQ_MEDIA_PROXY_PREFIX.length);
      try {
        const fileName = decodeURIComponent(encodedFileName);
        if (isSafeFaqMediaFileName(fileName)) {
          normalized.push(`${FAQ_MEDIA_PROXY_PREFIX}${encodeURIComponent(fileName)}`);
        }
      } catch {
        // Malformed percent-encoding is an invalid media reference.
      }
      continue;
    }
    if (isExternalHttpsUrl(url)) normalized.push(url);
  }
  return normalized;
}

function isSafeFaqMediaFileName(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    fileName.length <= 180 &&
    !fileName.includes("..") &&
    !fileName.includes("/") &&
    !fileName.includes("\\") &&
    FAQ_MEDIA_FILE_NAME.test(fileName)
  );
}

function isSafeSingleRange(value: string): boolean {
  if (value.length > 128) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  return match !== null && (match[1]!.length > 0 || match[2]!.length > 0);
}

function isAllowedFaqMediaContentType(value: string | null): boolean {
  if (value === null) return false;
  return FAQ_MEDIA_CONTENT_TYPES.has(value.split(";", 1)[0]!.trim().toLowerCase());
}

function isExternalHttpsUrl(value: string): boolean {
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function discardStream(body: NodeJS.ReadableStream): void {
  const readable = body as NodeJS.ReadableStream & { resume?: () => unknown };
  readable.resume?.();
}

function destroyStream(body: NodeJS.ReadableStream): void {
  const readable = body as NodeJS.ReadableStream & { destroy?: () => unknown };
  readable.destroy?.();
}

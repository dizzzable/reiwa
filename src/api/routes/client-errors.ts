import { Router, Request, Response } from "express";

import type { AdminClient } from "../../lib/admin-client.js";
import { createErrorReporter } from "../../infrastructure/error-reporter/index.js";
import { getRequestLogger } from "../middleware/logger-accessor.js";

/**
 * Client-error ingest — the web/TMA cabinet (browser SPA) posts its runtime
 * errors here so they land in the SAME firehose as bot/api/worker failures:
 * rezeis audit log → Events page → dev DM. Without this, a React render crash
 * or an unhandled rejection in the Mini App is invisible to the operator and
 * every "it broke on my phone" report has to be debugged blind.
 *
 *   POST /api/v1/client-errors
 *   body { message, stack?, componentStack?, kind?, surface?, url?, userAgent? }
 *
 * Public + best-effort by design: no auth (the cabinet may have crashed before
 * a session exists), always answers 204, and never blocks the SPA. Abuse is
 * bounded three ways: the global `/api` rate limiter, the SPA-side
 * throttle/dedup, and the reporter's own per-minute cap (its own `web`-source
 * instance, so a noisy browser can't starve server-side reports).
 */
export function createClientErrorsRouter(deps: { adminClient: AdminClient | null }) {
  const router = Router();
  const errorReporter = createErrorReporter({ adminClient: deps.adminClient, source: "web" });

  router.post("/client-errors", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const message = typeof body["message"] === "string" ? body["message"].trim() : "";
    if (message.length === 0) {
      res.status(400).json({ message: "missing message" });
      return;
    }

    const str = (key: string): string | undefined =>
      typeof body[key] === "string" && (body[key] as string).length > 0
        ? (body[key] as string)
        : undefined;

    const surface = body["surface"] === "tma" ? "tma" : "web";
    const kind = str("kind") ?? "client.error";
    const stack = str("stack");
    const componentStack = str("componentStack");

    const context: Record<string, unknown> = {
      scope: `web.${kind}`,
      surface,
    };
    const url = str("url");
    if (url !== undefined) context["url"] = url.slice(0, 512);
    const userAgent = str("userAgent") ?? (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
    if (userAgent !== undefined) context["userAgent"] = userAgent.slice(0, 512);
    if (componentStack !== undefined) context["componentStack"] = componentStack.slice(0, 4000);

    getRequestLogger(req).warn(
      { kind, surface, url, msg: message.slice(0, 200) },
      "Client (cabinet) error reported",
    );

    errorReporter.report({
      message: message.slice(0, 2000),
      ...(stack !== undefined ? { stack } : {}),
      context,
    });

    // Best-effort firehose — the SPA never needs to retry or care.
    res.status(204).end();
  });

  return router;
}

import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

import { createCsrfProtection } from "../src/api/middleware/csrf-protection.js";

function run(headers: Record<string, string>, authenticated: boolean) {
  const req = {
    method: "POST",
    headers,
    protocol: "https",
    webSession: authenticated ? { userId: "user-1" } : null,
  } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next: NextFunction = vi.fn();
  createCsrfProtection({ allowedOrigin: "https://app.example.com" })(
    req,
    { status } as unknown as Response,
    next,
  );
  return { next, status, json };
}

describe("createCsrfProtection", () => {
  it("requires origin evidence for cookie-authenticated mutations", () => {
    const result = run({}, true);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith({ message: "Forbidden: origin required" });
  });

  it("accepts the configured origin and rejects cross-site Origin (real CSRF)", () => {
    expect(run({ origin: "https://app.example.com" }, true).next).toHaveBeenCalledOnce();

    // Classic CSRF: browser hits the real Host with attacker's Origin.
    const rejected = run(
      { origin: "https://evil.example", host: "app.example.com" },
      true,
    );
    expect(rejected.status).toHaveBeenCalledWith(403);
    expect(rejected.json).toHaveBeenCalledWith({ message: "Forbidden: origin not allowed" });
  });

  it("accepts same-origin Host even when REIWA_DOMAIN differs (Mini App footgun)", () => {
    // Operator set REIWA_DOMAIN=app.example.com but opened the Mini App via
    // cabinet.example.com (same Host the reverse proxy forwards). Same-origin
    // SPA+API must pass CSRF — Origin equals Host, even if env is wrong.
    const req = {
      method: "POST",
      headers: {
        origin: "https://cabinet.example.com",
        host: "cabinet.example.com",
        "x-forwarded-proto": "https",
      },
      protocol: "https",
      webSession: null,
    } as unknown as Request;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next: NextFunction = vi.fn();
    createCsrfProtection({ allowedOrigin: "https://app.example.com" })(
      req,
      { status } as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("lets headerless server-to-server requests reach route authentication", () => {
    const result = run({}, false);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });
});

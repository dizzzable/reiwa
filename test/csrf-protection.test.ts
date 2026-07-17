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

  it("accepts the configured origin but not a matching attacker-controlled Host", () => {
    expect(run({ origin: "https://app.example.com" }, true).next).toHaveBeenCalledOnce();

    const rejected = run(
      { origin: "https://evil.example", host: "evil.example" },
      true,
    );
    expect(rejected.status).toHaveBeenCalledWith(403);
  });

  it("lets headerless server-to-server requests reach route authentication", () => {
    const result = run({}, false);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });
});

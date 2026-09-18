// @vitest-environment jsdom

/**
 * A report of a browser error names the page it happened on — and a bot
 * sign-in link keeps a live token in that address until the home page has
 * exchanged it. The report is logged by the cabinet's backend and ends up in
 * the panel's audit log and the developer's Telegram, so only the parameter
 * NAMES may ride along, never their values.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { addressForReport, reportClientError } from "../src/lib/client-error-reporter";

const TOKEN = "5f".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the address a client error report carries", () => {
  it("keeps the path and each parameter name once, and no value", () => {
    expect(addressForReport("/renew", `?utm_source=tg&signin=${TOKEN}`)).toBe("/renew?utm_source&signin");
    expect(addressForReport("/plans", "?a=1&a=2")).toBe("/plans?a");
    expect(addressForReport("/", "")).toBe("/");
  });

  it("sends no sign-in token when an error happens while a bot sign-in link is open", () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return Promise.resolve({ ok: true } as Response);
    });
    window.history.replaceState(null, "", `/?signin=${TOKEN}&next=%2Frenew`);

    reportClientError({ message: "TypeError: failed while signing in", kind: "window.onerror" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(TOKEN);
    expect((JSON.parse(sent[0] ?? "{}") as { url?: string }).url).toBe("/?signin&next");
  });
});

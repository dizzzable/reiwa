/**
 * Where a bot sign-in link on a path other than `/` is handed to.
 *
 * The bot stamps `?signin=<token>` onto whatever cabinet address a button
 * opens — `/dashboard` for the trial button without a Mini App, `/plans` or
 * `/renew` for an operator's own button — and only the home page spends it.
 * `magicLinkHandoffTarget` is the rule that brings such a link to `/` with the
 * page it was going to; the end-to-end proof is `magic-link-any-path.test.tsx`.
 */
import { describe, expect, it } from "vitest";

import { isSigninTokenShape, magicLinkHandoffTarget } from "../src/lib/magic-link";

const TOKEN = "0123456789abcdef".repeat(4);

function target(pathAndQuery: string): string | null {
  const url = new URL(pathAndQuery, "https://cabinet.example");
  return magicLinkHandoffTarget(url.pathname, url.search);
}

function parts(handoff: string | null): { path: string; params: Record<string, string> } | null {
  if (handoff === null) return null;
  const url = new URL(handoff, "https://cabinet.example");
  return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
}

describe("magicLinkHandoffTarget", () => {
  it("leaves the home page alone — it is where the token is spent", () => {
    expect(target(`/?signin=${TOKEN}`)).toBeNull();
  });

  it("hands the trial button's /dashboard link to the home page, with no detour back", () => {
    expect(parts(target(`/dashboard?signin=${TOKEN}`))).toEqual({
      path: "/",
      params: { signin: TOKEN },
    });
  });

  it("hands another cabinet page over with that page, its own query included, in next", () => {
    expect(parts(target(`/plans?utm_source=tg&signin=${TOKEN}`))).toEqual({
      path: "/",
      params: { utm_source: "tg", signin: TOKEN, next: "/plans?utm_source=tg" },
    });
  });

  it("keeps the real destination of an entry route that carries one", () => {
    expect(parts(target(`/bootstrap?next=%2Frenew&signin=${TOKEN}`))).toEqual({
      path: "/",
      params: { signin: TOKEN, next: "/renew" },
    });
  });

  it("gives an entry route no destination of its own, whatever its case or trailing slash", () => {
    for (const path of ["/sign-in", "/Sign-In/", "/welcome", "/tma", "/claim"]) {
      expect(parts(target(`${path}?signin=${TOKEN}`)), path).toEqual({
        path: "/",
        params: { signin: TOKEN },
      });
    }
  });

  it("drops a destination that would leave the cabinet", () => {
    expect(parts(target(`/bootstrap?next=%2F%2Fevil.example&signin=${TOKEN}`))).toEqual({
      path: "/",
      params: { signin: TOKEN },
    });
  });

  it("hands nothing over for a token no sign-in could ever accept", () => {
    expect(target("/plans?signin=abc")).toBeNull();
    expect(target(`/plans?signin=${"z".repeat(64)}`)).toBeNull();
    expect(target("/plans")).toBeNull();
  });
});

describe("isSigninTokenShape", () => {
  it("accepts exactly 64 hex characters, as the BFF does", () => {
    expect(isSigninTokenShape(TOKEN)).toBe(true);
    expect(isSigninTokenShape(TOKEN.toUpperCase())).toBe(true);
    expect(isSigninTokenShape(TOKEN.slice(1))).toBe(false);
    expect(isSigninTokenShape(`${TOKEN}0`)).toBe(false);
    expect(isSigninTokenShape(null)).toBe(false);
  });
});

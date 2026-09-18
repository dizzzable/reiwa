/**
 * `?next=` is followed only when it stays on this origin — as the browser will
 * parse it, not as it reads.
 *
 * A URL parser discards tabs and newlines and reads `\` as `/`, so
 * `/<TAB>/evil.example` passes "starts with exactly one slash" and is then
 * `//evil.example`. Every consumer navigates with `replace`, which throws on
 * such a value and freezes the page on its splash; a `push` would follow it.
 */
import { describe, expect, it } from "vitest";

import { nextDestinationQuery, sanitizeNextDestination } from "../src/lib/next-destination";

describe("sanitizeNextDestination", () => {
  it("keeps a same-origin path, its query included", () => {
    expect(sanitizeNextDestination("/renew")).toBe("/renew");
    expect(sanitizeNextDestination("/plans?utm_source=tg&utm_campaign=summer%20sale")).toBe(
      "/plans?utm_source=tg&utm_campaign=summer%20sale",
    );
  });

  it("refuses what is another origin once a URL parser has read it", () => {
    for (const raw of [
      "//evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\\evil.example",
      "/\\/evil.example",
    ]) {
      expect(sanitizeNextDestination(raw), JSON.stringify(raw)).toBeNull();
      expect(nextDestinationQuery(raw), JSON.stringify(raw)).toBe("");
    }
  });

  it("refuses a raw space or control character, which a path the router built never carries", () => {
    for (const raw of ["/ /evil.example", "/\x00/renew", "/\x1f/renew", "/renew\x7f"]) {
      expect(sanitizeNextDestination(raw), JSON.stringify(raw)).toBeNull();
      expect(nextDestinationQuery(raw), JSON.stringify(raw)).toBe("");
    }
  });

  it("refuses anything that is not a path", () => {
    expect(sanitizeNextDestination("evil.example")).toBeNull();
    expect(sanitizeNextDestination("https://evil.example/")).toBeNull();
    expect(sanitizeNextDestination(null)).toBeNull();
    expect(sanitizeNextDestination(undefined)).toBeNull();
  });
});

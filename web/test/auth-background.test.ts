/**
 * `branding.authBackground` — what the entry screens are willing to paint.
 *
 * The value crosses three caches (panel → cabinet → browser) and a panel older
 * than the setting sends no key at all, so the resolver has to be total: any
 * input it cannot prove safe must answer `none`, which is the previous
 * rendering. These cases are the contract the panel's DTO mirrors — a URL this
 * reader refuses is a wallpaper the operator sees in the panel and never on the
 * site, so the two lists are meant to be read together.
 */
import { describe, expect, it } from "vitest";

import { resolveAuthBackground } from "@/lib/auth-background";

const NONE = { kind: "none", url: null };

describe("resolveAuthBackground", () => {
  it("answers none for a payload without the key (a panel older than the setting)", () => {
    expect(resolveAuthBackground(undefined)).toEqual(NONE);
    expect(resolveAuthBackground(null)).toEqual(NONE);
    expect(resolveAuthBackground({})).toEqual(NONE);
  });

  it("answers none for a value that is not an object", () => {
    expect(resolveAuthBackground("https://cdn.example.com/a.jpg")).toEqual(NONE);
    expect(resolveAuthBackground([])).toEqual(NONE);
    expect(resolveAuthBackground(42)).toEqual(NONE);
  });

  it("accepts an https image, and a relayed branding upload", () => {
    expect(resolveAuthBackground({ kind: "image", url: "https://cdn.example.com/bg.jpg" })).toEqual({
      kind: "image",
      url: "https://cdn.example.com/bg.jpg",
    });
    expect(resolveAuthBackground({ kind: "image", url: "/uploads/branding/abc123.webp" })).toEqual({
      kind: "image",
      url: "/uploads/branding/abc123.webp",
    });
  });

  it("accepts an https video, and a relayed video upload", () => {
    expect(resolveAuthBackground({ kind: "video", url: "https://cdn.example.com/bg.mp4" })).toEqual({
      kind: "video",
      url: "https://cdn.example.com/bg.mp4",
    });
    // The operator's own clip: streamed by the cabinet's relay with Range
    // support (`app.ts`), so a relative path is a real address now.
    expect(resolveAuthBackground({ kind: "video", url: "/uploads/branding/abc123.mp4" })).toEqual({
      kind: "video",
      url: "/uploads/branding/abc123.mp4",
    });
    expect(resolveAuthBackground({ kind: "video", url: "/uploads/branding/abc123.webm" })).toEqual({
      kind: "video",
      url: "/uploads/branding/abc123.webm",
    });
  });

  it("refuses a video slot pointed at a still or a non-video upload", () => {
    // The relay types only mp4/webm as video; a `.png` here would be a
    // `<video>` element that never decodes.
    for (const url of [
      "/uploads/branding/abc123.png",
      "/uploads/branding/abc123.mp4.txt",
      "/uploads/branding/abc123",
    ]) {
      expect(resolveAuthBackground({ kind: "video", url }), url).toEqual(NONE);
    }
  });

  it("refuses every address it cannot prove safe", () => {
    for (const url of [
      "",
      "   ",
      "http://cdn.example.com/bg.jpg",
      "//cdn.example.com/bg.jpg",
      "/uploads/branding/../secret.png",
      "/uploads/icons/abc.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://user:pass@cdn.example.com/bg.jpg",
      `https://cdn.example.com/${"a".repeat(2100)}.jpg`,
    ]) {
      expect(resolveAuthBackground({ kind: "image", url }), url).toEqual(NONE);
    }
  });

  it("refuses a kind this build does not draw", () => {
    for (const kind of ["none", "iframe", "IMAGE", 1, null]) {
      expect(resolveAuthBackground({ kind, url: "https://cdn.example.com/bg.jpg" })).toEqual(NONE);
    }
  });

  it("trims surrounding whitespace instead of refusing the value", () => {
    expect(resolveAuthBackground({ kind: "image", url: "  https://cdn.example.com/bg.jpg  " })).toEqual({
      kind: "image",
      url: "https://cdn.example.com/bg.jpg",
    });
  });
});

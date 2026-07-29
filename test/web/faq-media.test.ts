import { describe, expect, it } from "vitest";

import {
  getFaqMediaKind,
  normalizeFaqMediaUrls,
} from "../../web/src/features/settings/faq-media.js";

describe("FAQ media policy", () => {
  it.each([
    ["/uploads/faq/guide.png", "image"],
    ["https://cdn.example.test/guide.WEBP?revision=4", "image"],
    ["/api/v1/faq/media/poster.avif#preview", "image"],
    ["/uploads/faq/guide.mp4", "video"],
    ["https://cdn.example.test/guide.WEBM?token=signed", "video"],
    ["/uploads/faq/guide.mov#step-1", "video"],
  ])("classifies %s as %s", (url, expected) => {
    expect(getFaqMediaKind(url)).toBe(expected);
  });

  it.each([
    "/uploads/faq/archive.zip",
    "/uploads/faq/no-extension",
    "not a valid url",
  ])("keeps unsupported format %s out of native media elements", (url) => {
    expect(getFaqMediaKind(url)).toBe("unsupported");
  });

  it("trims, removes empty entries, and de-duplicates URLs without reordering", () => {
    expect(normalizeFaqMediaUrls([
      " /uploads/faq/guide.mp4 ",
      "",
      null,
      "/uploads/faq/poster.png",
      "/uploads/faq/guide.mp4",
      42,
    ])).toEqual([
      "/uploads/faq/guide.mp4",
      "/uploads/faq/poster.png",
    ]);
  });

  it("returns an empty list for a malformed mediaUrls value", () => {
    expect(normalizeFaqMediaUrls(null)).toEqual([]);
    expect(normalizeFaqMediaUrls("/uploads/faq/guide.mp4")).toEqual([]);
  });

  it("keeps same-origin relative and HTTPS URLs but rejects unsafe schemes", () => {
    expect(normalizeFaqMediaUrls([
      "/api/v1/faq/media/guide.mp4",
      "/uploads/faq/poster.png",
      "https://cdn.example.test/guide.webm",
      "http://cdn.example.test/insecure.mp4",
      "javascript:alert(1).mp4",
      "data:video/mp4;base64,AAAA",
      "//cdn.example.test/protocol-relative.mp4",
    ])).toEqual([
      "/api/v1/faq/media/guide.mp4",
      "/uploads/faq/poster.png",
      "https://cdn.example.test/guide.webm",
    ]);
  });
});

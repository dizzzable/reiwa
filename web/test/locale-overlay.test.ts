import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  loadLocaleOverlay,
  localeOverlayPath,
  MAX_OVERLAY_DEPTH,
  sanitiseOverlay,
} from "../src/i18n/locale-overlay";

/**
 * An operator's own wording, mounted into the container.
 *
 * WHAT THIS IS FOR. Operators asked for what RemnaShop gives them: edit the
 * cabinet's text without rebuilding an image. They could not, because the
 * strings are compiled into `assets/index-<hash>.js` — a minified bundle whose
 * filename changes on every build, so no stable `-v` can target it.
 *
 * The overlay is a file at a path with no hash in it, laid OVER the shipped
 * dictionary. Everything below is about the two properties that make it safe to
 * hand to somebody with a text editor and a shell:
 *
 *   1. it can only ADD wording, never take any away — an unnamed key still
 *      answers with the string we shipped, so a partial file stays correct
 *      through every future release;
 *   2. no state of that file can stop the cabinet rendering. Missing, empty,
 *      truncated, HTML from a proxy, a number where a string belongs — each
 *      answers `null` and the cabinet looks exactly as it shipped.
 */

describe("where the file is looked for", () => {
  it("uses a path with no build hash in it, which is the whole point", () => {
    expect(localeOverlayPath("ru")).toBe("/locales/ru.override.json");
    expect(localeOverlayPath("en")).toBe("/locales/en.override.json");
  });

  it("keeps out of /assets/, which the service worker caches for 30 days", () => {
    // A hashed asset never changes behind its URL, which is what licenses
    // cache-first there. This file is edited by hand and must not be pinned.
    expect(localeOverlayPath("ru")).not.toContain("/assets/");
  });

  it("respects a cabinet served from a sub-path", () => {
    expect(localeOverlayPath("ru", "/cabinet/")).toBe("/cabinet/locales/ru.override.json");
    expect(localeOverlayPath("ru", "/cabinet")).toBe("/cabinet/locales/ru.override.json");
  });
});

describe("what counts as a usable overlay", () => {
  it("keeps strings, at any depth the dictionary uses", () => {
    expect(
      sanitiseOverlay({ plans: { durationOptions_one: "{{count}} вариант" } }),
    ).toEqual({ plans: { durationOptions_one: "{{count}} вариант" } });
  });

  it("drops anything that is not a translation", () => {
    // A number, a boolean, an array or a null in a translation slot renders as
    // `[object Object]` or breaks the interpolation. Dropping the entry leaves
    // the shipped string in place, which always works.
    expect(
      sanitiseOverlay({
        good: "kept",
        number: 42,
        bool: true,
        list: ["a"],
        nothing: null,
      }),
    ).toEqual({ good: "kept" });
  });

  it("drops a key i18next could not address anyway", () => {
    // An unaddressable key is a string the operator believes they changed and
    // did not — worse than a dropped one, because nothing says so.
    const cleaned = sanitiseOverlay({
      ok: "kept",
      "with space": "dropped",
      "": "dropped",
      "<script>": "dropped",
      [`${"x".repeat(65)}`]: "dropped",
    });
    expect(cleaned).toEqual({ ok: "kept" });
  });

  it("refuses a tree deeper than any dictionary", () => {
    let deep: Record<string, unknown> = { leaf: "too deep" };
    for (let level = 0; level < MAX_OVERLAY_DEPTH + 2; level += 1) {
      deep = { level: deep };
    }
    // The nesting past the cap is discarded; nothing throws, and an overlay
    // that is nothing BUT that nesting answers null.
    expect(sanitiseOverlay(deep)).toBeNull();
  });

  it("answers null rather than an empty object", () => {
    // The caller treats null as "nothing to apply". An empty bundle handed to
    // i18next is a pointless mutation and a pointless re-render.
    for (const value of [null, undefined, 42, "text", [], {}, { bad: 1 }]) {
      expect(sanitiseOverlay(value), JSON.stringify(value) ?? "undefined").toBeNull();
    }
  });
});

describe("an overlay cannot delete what it was meant to reword", () => {
  /**
   * The merge is i18next's `deepExtend(..., overwrite: true)`, and it does
   * exactly what it says: a STRING in the overlay replaces whatever sits at that
   * key — including a whole section. An operator writing `{"plans": "Тарифы"}`,
   * which is a reasonable guess at how this works, does not rename anything.
   * They wipe every string under `plans`, and the cabinet renders
   * `plans.durationOptions_one` as literal text to every customer until somebody
   * finds the file and removes it.
   *
   * The shape rules alone cannot see this: a string is a valid leaf. Only the
   * shipped dictionary knows that this particular key is a branch.
   */
  const SHIPPED = {
    plans: { title: "Тарифы", durationOptions_one: "{{count}} вариант срока" },
    common: { back: "Назад" },
  };

  it("drops a string written where a section is shipped", () => {
    const cleaned = sanitiseOverlay({ plans: "Тарифы", common: { back: "Обратно" } }, 0, SHIPPED);
    expect(cleaned).toEqual({ common: { back: "Обратно" } });
  });

  it("drops a section written where a string is shipped", () => {
    // The mirror mistake. Harmless to its neighbours, but it puts an object
    // where a string belongs and renders as `[object Object]`.
    const cleaned = sanitiseOverlay({ common: { back: { ru: "Назад" } } }, 0, SHIPPED);
    expect(cleaned).toBeNull();
  });

  it("still accepts the ordinary case — one string inside a section", () => {
    expect(
      sanitiseOverlay({ plans: { durationOptions_one: "{{count}} вариант" } }, 0, SHIPPED),
    ).toEqual({ plans: { durationOptions_one: "{{count}} вариант" } });
  });

  it("keeps a key the shipped dictionary does not have", () => {
    // Not a mistake worth refusing: an operator may be ahead of the build, or
    // carrying a key from a release that renamed one. It reaches i18next and
    // simply never gets read.
    expect(sanitiseOverlay({ plans: { unknown_key: "x" } }, 0, SHIPPED)).toEqual({
      plans: { unknown_key: "x" },
    });
  });

  it("applies only the shape rules when no dictionary is handed over", () => {
    // `undefined` means "nothing to compare against" and must not behave like
    // an empty dictionary, which would drop every key.
    expect(sanitiseOverlay({ plans: "Тарифы" })).toEqual({ plans: "Тарифы" });
  });
});

describe("reading the file", () => {
  const ok = (body: string) =>
    vi.fn(async () => ({ ok: true, text: async () => body }) as unknown as Response);

  it("reads an overlay the operator mounted", async () => {
    const fetchImpl = ok('{"plans":{"durationOptions_one":"{{count}} вариант"}}');
    await expect(loadLocaleOverlay("ru", { fetchImpl })).resolves.toEqual({
      plans: { durationOptions_one: "{{count}} вариант" },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/locales/ru.override.json");
    // Edited on the server, expected to take effect on the next load. A cached
    // copy makes an operator think their edit did nothing.
    expect(init.cache).toBe("no-cache");
  });

  it("answers null when there is no file, which is the ordinary case", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, text: async () => "" }) as unknown as Response);
    await expect(loadLocaleOverlay("ru", { fetchImpl })).resolves.toBeNull();
  });

  it("answers null for anything that is not the file we wanted", async () => {
    // A proxy's HTML error page, a truncated write, a config half-saved. Every
    // one of them must leave the cabinet exactly as it shipped.
    for (const body of ["<html>502</html>", "{", "", "null", "[]", "12"]) {
      await expect(loadLocaleOverlay("ru", { fetchImpl: ok(body) }), body).resolves.toBeNull();
    }
  });

  it("answers null for a file too large to be a set of edits", async () => {
    const huge = `{"a":"${"x".repeat(2000)}"}`;
    await expect(
      loadLocaleOverlay("ru", { fetchImpl: ok(huge), maxBytes: 100 }),
    ).resolves.toBeNull();
  });

  it("survives a network that is not there", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(loadLocaleOverlay("ru", { fetchImpl })).resolves.toBeNull();
  });

  it("refuses to fetch a language that is not one", async () => {
    // The language reaches this from `localStorage` and from Telegram, so it is
    // not ours to trust with a path.
    const fetchImpl = ok("{}");
    for (const lang of ["../../etc/passwd", "ru/../..", "", "a".repeat(65)]) {
      await expect(loadLocaleOverlay(lang, { fetchImpl }), lang).resolves.toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("what ships in the image", () => {
  const dir = new URL("../public/locales/", import.meta.url);

  it("carries an example the operator can copy, which is not itself an overlay", () => {
    // Named `.example.json` on purpose: `ru.override.json` sitting in the image
    // would be an overlay applied to every install that never asked for one.
    const example = JSON.parse(
      readFileSync(fileURLToPath(new URL("ru.override.example.json", dir)), "utf8"),
    ) as Record<string, unknown>;
    expect(localeOverlayPath("ru")).not.toContain("example");
    expect(sanitiseOverlay(example)).not.toBeNull();
  });

  it("shows all four plural forms in that example", () => {
    // The single thing an operator gets wrong first. Russian needs `_one`,
    // `_few`, `_many` and `_other`; naming only `_one` changes the string for
    // exactly the number 1 and leaves the rest as shipped.
    const raw = readFileSync(fileURLToPath(new URL("ru.override.example.json", dir)), "utf8");
    for (const form of ["_one", "_few", "_many", "_other"]) {
      expect(raw, `the example omits ${form}`).toContain(form);
    }
    // And keeps the interpolation, which is the second thing they get wrong.
    expect(raw).toContain("{{count}}");
  });

  it("explains itself where somebody with a shell would look", () => {
    const readme = readFileSync(fileURLToPath(new URL("README.md", dir)), "utf8");
    // Both mount points, because the two images put the SPA in different places
    // and an operator on the wrong one gets a silent no-op.
    expect(readme).toContain("/usr/share/nginx/html/locales/");
    expect(readme).toContain("/app/web/locales/");
  });
});

describe("both ways the file is served", () => {
  // TWO SERVERS, ONE PROMISE. The SPA image serves `web/dist` with nginx; the
  // combined image serves the same directory from Express. An operator edits
  // the file on the server and expects the next page load to show it, so
  // neither may hand back a cached copy — and a rule added to one and not the
  // other fails only on the deployment nobody tested.
  //
  // Asserted from the configuration rather than from a running container: this
  // suite has no Docker. The container check is worth doing by hand once, and
  // it is the reason these two are pinned here.
  it("tells nginx not to cache it", () => {
    const conf = readFileSync(
      fileURLToPath(new URL("../nginx.conf", import.meta.url)),
      "utf8",
    );
    const at = conf.indexOf("location /locales/");
    expect(at, "nginx has no rule for the overlay directory").toBeGreaterThan(-1);
    expect(conf.slice(at, conf.indexOf("}", at))).toContain("no-store");
  });

  it("tells the combined image's Express the same", () => {
    const app = readFileSync(
      fileURLToPath(new URL("../../src/api/app.ts", import.meta.url)),
      "utf8",
    );
    const at = app.indexOf("locales");
    expect(at, "the API serves the SPA but says nothing about the overlay").toBeGreaterThan(-1);
    expect(app.slice(at, at + 400)).toContain("no-store");
  });
});

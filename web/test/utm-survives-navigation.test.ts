// @vitest-environment jsdom

/**
 * The tags an advertisement puts in the URL have to reach the register form.
 *
 * They did not. React-router replaces the whole URL when a `Link` is given a
 * bare path, and every call-to-action between the landing page and the form
 * passed one — so `?utm_source=vk` survived the ad click, survived the server,
 * survived the landing render, and was thrown away by the button the visitor
 * pressed. `register-page.tsx` then read an empty query and posted `utm: null`,
 * `sanitizeUtm` returned null, and `registrationUtm` was never written for
 * anybody.
 *
 * What the operator saw was «UTM-метки для этого пользователя не сохранены» on
 * every profile they opened — a message that reads like a storage problem and
 * was a navigation one.
 *
 * Two guards here, because the fix has two halves:
 *
 *  1. `keepQuery` carries the right parameters and nothing else;
 *  2. NO navigation target on those pages is a bare path any more. The first
 *     guard cannot see a fifth button somebody adds next year.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { keepQuery, mergeCarriedQuery } from "../src/lib/keep-query";

function at(search: string): void {
  window.history.replaceState({}, "", `/welcome${search}`);
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("keepQuery", () => {
  it("carries every utm_ tag", () => {
    at("?utm_source=vk&utm_medium=cpc&utm_campaign=summer&utm_content=a&utm_term=vpn");
    const href = keepQuery("/register");
    for (const tag of ["utm_source=vk", "utm_medium=cpc", "utm_campaign=summer"]) {
      expect(href).toContain(tag);
    }
  });

  it("carries the referral token and the interrupted destination", () => {
    at("?ref=friend&next=%2Fdashboard");
    const href = keepQuery("/register");
    expect(href).toContain("ref=friend");
    expect(href).toContain("next=");
  });

  it("carries the advertising markers", () => {
    // `?campaign=ad_<code>` is what binds a registration to a placement. It
    // is stripped server-side on the redirect, but a visitor can arrive with
    // it on any page and it must not die at the first button.
    at("?campaign=ad_abc123&startapp=ad_abc123");
    const href = keepQuery("/register");
    expect(href).toContain("campaign=ad_abc123");
    expect(href).toContain("startapp=ad_abc123");
  });

  it("leaves everything else behind", () => {
    // A page's own state is not acquisition data; carrying it would make
    // shared links reproduce somebody else's open tab.
    at("?utm_source=vk&tab=faq&debug=1");
    const href = keepQuery("/register");
    expect(href).toContain("utm_source=vk");
    expect(href).not.toContain("tab=faq");
    expect(href).not.toContain("debug=1");
  });

  it("returns the bare target when there is nothing to carry", () => {
    at("");
    expect(keepQuery("/register")).toBe("/register");
  });

  it("does not touch a target that brought its own query", () => {
    // It was built deliberately; merging into it would be guessing.
    at("?utm_source=vk");
    expect(keepQuery("/register?plan=pro")).toBe("/register?plan=pro");
  });
});

/**
 * The pages an advertisement actually leads through.
 *
 * A source scan rather than a render: the landing sections are driven by an
 * operator's own JSON and there is no single rendered tree that contains all
 * of them. What matters is that no file here hands react-router a bare
 * `/register` or `/sign-in`, and that is a property of the text.
 */
const LANDING_PAGE = "../src/features/landing/landing-page.tsx";
const KIT_CONTEXT = "../src/features/landing/landing-kit-context.tsx";

const ACQUISITION_PAGES = [
  "../src/features/landing/sections/hero.tsx",
  "../src/features/landing/sections/pricing.tsx",
  "../src/features/landing/sections/misc.tsx",
  "../src/features/auth/sign-in-page.tsx",
  "../src/features/auth/web-home-page.tsx",
  // The landing page itself. It was missing from this list while holding three
  // bare `<Navigate to="/sign-in">` on its fail-closed path — so the guard
  // written to stop exactly this was blind to the live instance of it, on the
  // file the whole list is named after.
  LANDING_PAGE,
];

/**
 * Read a source file by a path held in a VARIABLE.
 *
 * Not a literal inside `new URL(...)`: Vite rewrites that form at build time
 * into a resolved asset URL, and the result is an `http:` URL that
 * `fileURLToPath` refuses. The indirection is what keeps this a file read.
 */
function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("mergeCarriedQuery", () => {
  it("folds the marks into a target that already has a query", () => {
    at("?utm_source=vk&campaign=ad_abc123");
    const href = mergeCarriedQuery("/tma?next=%2Fdashboard");
    expect(href).toContain("next=");
    expect(href).toContain("utm_source=vk");
    expect(href).toContain("campaign=ad_abc123");
  });

  it("lets the target keep its own value for a key", () => {
    // `next` reaches this point sanitised. The raw one from the address bar
    // must not overwrite the checked one.
    at("?next=%2Fevil");
    expect(mergeCarriedQuery("/tma?next=%2Fdashboard")).toContain("next=%2Fdashboard");
    expect(mergeCarriedQuery("/tma?next=%2Fdashboard")).not.toContain("evil");
  });

  it("carries nothing that was not asked for", () => {
    at("?utm_source=vk&session=secret&token=abc");
    const href = mergeCarriedQuery("/tma?next=%2Fx");
    expect(href).toContain("utm_source=vk");
    expect(href).not.toContain("session");
    expect(href).not.toContain("token");
  });
});

describe("no acquisition page navigates with a bare path", () => {
  for (const relative of ACQUISITION_PAGES) {
    it(`keeps the query on the way out of ${relative.split("/").pop()}`, () => {
      const source = readSource(relative);

      // A bare literal used as a navigation target: `to="/register"`,
      // `href="/sign-in"`, or a ternary arm that is just the path.
      const bare = [
        ...source.matchAll(/(?:to|href)=["']\/(register|sign-in)["']/g),
        ...source.matchAll(/\?\s*['"]\/(register|sign-in)['"]/g),
        ...source.matchAll(/:\s*['"]\/(register|sign-in)['"]\s*[,;)\n]/g),
      ].map((m) => m[0]);

      expect(
        bare,
        "this target drops the query, and with it every utm tag the ad put there",
      ).toEqual([]);
    });
  }

  it("binds the rewrite on the real landing page", () => {
    // The landing sections cannot import `keepQuery`: the panel vendors a
    // byte-identical copy of that folder for its builder preview and has no
    // such module. They ask the kit instead — which means the REAL page is now
    // the single place the rewrite is switched on, and a landing page that
    // forgot to bind it would render bare paths again with nothing failing.
    const source = readSource(LANDING_PAGE);
    expect(source).toContain("resolveInternalHref: keepQuery");
  });

  it("leaves the preview host on the identity default", () => {
    // A builder preview has no visitor query to carry and must show the
    // operator the path they configured. The default in the kit is what makes
    // that true without the panel knowing anything about this.
    const source = readSource(KIT_CONTEXT);
    expect(source).toContain("resolveInternalHref: (target) => target");
  });

  it("unwraps a deep link without dropping the marks beside it", () => {
    // `/bootstrap` is the hop a deep link lands on, and it rebuilds where to
    // go from `?next=` ALONE. Everything else in the url died there — the
    // placement was recorded server-side, the tags were not, and the profile
    // read as though the visitor had arrived from nowhere.
    const source = readSource("../src/features/auth/context-router.tsx");
    expect(source).toContain("mergeCarriedQuery");
    expect(
      source.includes("navigate(`/tma${nextSuffix}`"),
      "the Telegram arm navigates with the bare suffix again",
    ).toBe(false);
  });

  it("still finds a bare target when one is there", () => {
    // NON-VACUITY: a scanner that matches nothing agrees with a clean tree
    // forever. This is the shape it must catch.
    const sample = 'const x = <Link to="/register" />';
    expect([...sample.matchAll(/(?:to|href)=["']\/(register|sign-in)["']/g)]).toHaveLength(1);
  });
});

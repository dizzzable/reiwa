// @vitest-environment jsdom

/**
 * Flags on a desktop, and what it costs to have them.
 *
 * THE REPORT. `🇨🇿` is two regional-indicator code points and Windows ships no
 * font that draws the pair, so every desktop browser there renders the letters
 * "CZ". The phone draws it. Half the audience saw a broken screen and the other
 * half saw nothing wrong, which is why it took a screenshot to find.
 *
 * The SVGs answer that, and they bring a cost with them: 271 files, about two
 * megabytes. The whole point is that a customer pays for the six flags their
 * operator uses, so the two rules below matter as much as the rendering —
 * `prebuild` must put the files there, and the service worker must NOT precache
 * them. Either one silently reverting turns a fix into a two-megabyte first
 * load that nobody would notice from a screenshot either.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CountryFlag, nameWithoutFlag } from "../src/components/ui/country-flag";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(code: string | null): HTMLElement {
  act(() => root.render(<CountryFlag code={code} />));
  const node = container.firstElementChild;
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

describe("a country flag on any platform", () => {
  it("draws a real image for a country code", () => {
    const node = render("CZ");
    expect(node.tagName).toBe("IMG");
    expect((node as HTMLImageElement).getAttribute("src")).toMatch(/flags\/cz\.svg$/);
  });

  it("takes the code in either case", () => {
    expect(render("cz").getAttribute("src")).toMatch(/flags\/cz\.svg$/);
    expect(render("Cz").getAttribute("src")).toMatch(/flags\/cz\.svg$/);
  });

  it("draws a badge, not a broken image, when there is no country", () => {
    const node = render(null);
    expect(node.tagName).toBe("SPAN");
    expect(node.textContent).toBe("··");
  });

  it("draws a badge for anything that is not two letters", () => {
    // An operator can put anything in a host name, and the panel decodes what
    // it finds. A three-letter code or a digit pair must not become a request
    // for a file that cannot exist.
    for (const code of ["", "D", "DEU", "1", "D1", "../etc/passwd"]) {
      expect(render(code).tagName, `\`${code}\` should not become an image`).toBe("SPAN");
    }
  });

  it("falls back to the badge when the file is missing", () => {
    // `EU` has a file; an operator's own invented pair does not. A missing file
    // is an ordinary case here, not an error, and it must not leave the
    // browser's broken-image glyph on a customer's screen.
    act(() => root.render(<CountryFlag code="ZZ" />));
    const image = container.firstElementChild as HTMLImageElement;
    expect(image.tagName).toBe("IMG");
    act(() => {
      image.dispatchEvent(new Event("error"));
    });
    const after = container.firstElementChild as HTMLElement;
    expect(after.tagName).toBe("SPAN");
    expect(after.textContent).toBe("ZZ");
  });

  it("says nothing to a screen reader", () => {
    // The server's name is right beside it, in words. "Flag of Czechia, Czech"
    // is the same fact twice.
    expect(render("CZ").getAttribute("alt")).toBe("");
    expect(render("CZ").getAttribute("aria-hidden")).toBe("true");
    expect(render(null).getAttribute("aria-hidden")).toBe("true");
  });

  it("loads the file lazily", () => {
    // Fourteen rows is fourteen requests otherwise, for the rows below the fold
    // that nobody scrolled to.
    expect(render("CZ").getAttribute("loading")).toBe("lazy");
  });
});

describe("the operator's name, with the flag drawn only once", () => {
  it("takes a leading flag off", () => {
    // What the screenshot showed on Windows: "cz Czech".
    expect(nameWithoutFlag("🇨🇿 Czech")).toBe("Czech");
    expect(nameWithoutFlag("🇩🇪Germany 05")).toBe("Germany 05");
  });

  it("takes a trailing flag off", () => {
    expect(nameWithoutFlag("Poland 06 🇵🇱")).toBe("Poland 06");
  });

  it("leaves a flag in the middle alone", () => {
    // Not ours to rewrite: the operator put it between words on purpose.
    expect(nameWithoutFlag("EU 🇪🇺 balancer")).toBe("EU 🇪🇺 balancer");
  });

  it("keeps a name that is nothing but a flag", () => {
    // An empty row is worse than a duplicated flag.
    expect(nameWithoutFlag("🇩🇪")).toBe("🇩🇪");
    expect(nameWithoutFlag("  🇩🇪  ")).toBe("🇩🇪");
  });

  it("leaves ordinary names exactly as typed", () => {
    for (const name of ["Smart-Автоматический", "Germany 05", "de-1 · premium", "★ VIP"]) {
      expect(nameWithoutFlag(name)).toBe(name);
    }
  });
});

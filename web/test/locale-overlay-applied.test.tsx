// @vitest-environment jsdom

/**
 * The overlay actually reaches a rendered string.
 *
 * `locale-overlay.test.ts` next door proves the file is read and sanitised
 * correctly, and every one of its cases would still pass if `i18n.ts` never
 * called it. That is the shape this repository keeps rediscovering: a decision
 * made correctly in a function nothing reaches.
 *
 * So this file boots the real i18n module with a stubbed `fetch`, and asks
 * `t()` — the same call every screen makes — what it answers. Nothing here
 * knows how the overlay is applied; it only knows what the subscriber ends up
 * reading.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OVERRIDE = '{"plans":{"durationOptions_one":"{{count}} вариант"}}';

/**
 * A fresh i18n, with the network answering however a case wants.
 *
 * `null` means "no file", and it answers a NOT-OK response carrying a body that
 * would be a perfectly good overlay if anything read it. That is deliberate: an
 * empty body makes the parse throw, so the catch answers null and the status
 * check is never the thing that saved the cabinet. A proxy's 404 page is
 * usually not empty, and neither is this.
 */
const NOT_THE_FILE = '{"plans":{"durationOptions_one":"{{count}} НЕ ПРИМЕНЯТЬ"}}';

async function bootWith(body: string | null): Promise<typeof import("../src/i18n/i18n")> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body === null
        ? ({ ok: false, text: async () => NOT_THE_FILE } as unknown as Response)
        : ({ ok: true, text: async () => body } as unknown as Response),
    ),
  );
  vi.resetModules();
  const module = await import("../src/i18n/i18n");
  // The overlay is deliberately not awaited by the boot — it lands a tick
  // later, and `changeLanguage` re-renders what it changed.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return module;
}

beforeEach(() => {
  window.localStorage.setItem("reiwa_locale", "ru");
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("an operator's wording on a real screen", () => {
  it("replaces the string the report was about", async () => {
    // Reported as "срок не очень звучит", on a card that already says the
    // price and the period two lines up.
    const { i18n } = await bootWith(OVERRIDE);
    expect(i18n.t("plans.durationOptions_one", { count: 1 })).toBe("1 вариант");
  });

  it("leaves every string it did not name exactly as shipped", async () => {
    // The property that makes a partial file safe across releases: an overlay
    // adds wording and can never take any away.
    const { i18n } = await bootWith(OVERRIDE);
    // Still the SHIPPED wording, because the overlay named only `_one` —
    // which is the mistake the README warns about first: in Russian a
    // plural is four keys, and naming one changes the string for exactly
    // the number 1.
    expect(i18n.t("plans.durationOptions_few", { count: 3 })).toBe("3 варианта срока");
    expect(i18n.t("errorBoundary.reload")).toBe("Перезагрузить");
  });

  it("changes nothing at all when no file is mounted", async () => {
    // The ordinary install, and the one that must be untouched by any of this.
    const { i18n } = await bootWith(null);
    expect(i18n.t("plans.durationOptions_one", { count: 1 })).toBe("1 вариант срока");
  });

  it("changes nothing when the file is broken", async () => {
    const { i18n } = await bootWith("{ this is not json");
    expect(i18n.t("plans.durationOptions_one", { count: 1 })).toBe("1 вариант срока");
  });

  it("asks for the language it is actually showing", async () => {
    window.localStorage.setItem("reiwa_locale", "en");
    await bootWith(null);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map((call) => call[0])).toContain("/locales/en.override.json");
  });

  it("asks once per language, however many times the language changes", async () => {
    // `addResourceBundle` is followed by `changeLanguage`, which emits the very
    // event that triggers this — an unguarded version does not terminate.
    //
    // The spy is cleared after the boot has settled rather than counted from
    // zero: `vi.resetModules()` gives each boot a fresh module, but the
    // previous boot's in-flight request lands on the stub installed here, and
    // the property under test is "at most one request per language", not "this
    // process made exactly N requests".
    const { i18n, setLocale } = await bootWith(OVERRIDE);
    const spy = globalThis.fetch as unknown as {
      mock: { calls: unknown[][] };
      mockClear: () => void;
    };
    spy.mockClear();

    setLocale("en");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      "/locales/en.override.json",
    ]);

    // Back to a language already asked for, and forward again: neither costs a
    // request, and neither loops.
    setLocale("ru");
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale("en");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy.mock.calls).toHaveLength(1);
    expect(i18n.language).toBe("en");
  });
});

describe("a screen that is already on the page", () => {
  // `t()` reads the store; a React tree does not re-read it on its own.
  // `addResourceBundle` mutates silently, so without the `changeLanguage` that
  // follows it, an overlay landing after first paint would sit in the store and
  // change nothing anybody can see — which is indistinguishable from not
  // working, and is what an operator would report.
  let container: HTMLDivElement;
  let root: Root;

  function Label(): React.JSX.Element {
    const { t } = useTranslation();
    return <span>{t("plans.durationOptions_one", { count: 1 })}</span>;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("re-renders when the overlay lands after the first paint", async () => {
    // Rendered BEFORE the overlay is applied, exactly as a customer's first
    // paint is: `main.tsx` renders at module scope and the file arrives a tick
    // later.
    let settle: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      settle = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await held;
        return {
          ok: true,
          text: async () => '{"plans":{"durationOptions_one":"{{count}} вариант"}}',
        } as unknown as Response;
      }),
    );
    vi.resetModules();
    await import("../src/i18n/i18n");

    act(() => root.render(<Label />));
    expect(container.textContent).toBe("1 вариант срока");

    await act(async () => {
      settle?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe("1 вариант");
  });
});

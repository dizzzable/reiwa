// @vitest-environment jsdom

/**
 * The stripe above a hint modal's title must always have a colour.
 *
 * It IS the tone — nothing else in the dialog carries it — and the tone tells
 * the customer whether "your subscription" is news or a problem. A stripe with
 * no colour class is not a smaller signal, it is no signal, and it looks
 * exactly like a hint that was authored without one.
 *
 * The modal used to hold its own copy of the tone table, with the fallback
 * spelled at the use site as `?? TONE_RULE.INFO`. That catches an unrecognised
 * tone but not one that names something on `Object.prototype` — `[
 * "constructor"]` yields a FUNCTION off the prototype chain, `??` does not
 * fire, and `clsx` silently drops it. The toast, reading the same shape through
 * its own table, threw instead. The two are now one lookup, and this file
 * checks the modal end of it through the rendered DOM rather than through the
 * table it is supposed to be using.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({ useNavigate: () => () => undefined }));

import { HintModal } from "@/features/hints/hint-modal";
import { HINT_TONE_RAIL } from "@/features/hints/hint-tone";

const RAILS = Object.values(HINT_TONE_RAIL);

function hint(tone: string) {
  return {
    deliveryId: "d1",
    key: "k1",
    mode: "MODAL",
    tone,
    title: "Заголовок",
    body: "Текст",
    ctaKind: "NONE",
    ctaLabel: null,
    ctaTarget: null,
  } as never;
}

let container: HTMLDivElement;
let root: Root;

function draw(tone: string): string {
  act(() => {
    root.render(<HintModal hint={hint(tone)} onAct={() => undefined} onDismiss={() => undefined} />);
  });
  const rail = document.querySelector("div.h-1.w-10");
  expect(rail, "the modal drew no stripe at all").not.toBeNull();
  return (rail as HTMLElement).className;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the tone stripe a hint modal renders", () => {
  it.each([
    ["INFO", HINT_TONE_RAIL.INFO],
    ["DANGER", HINT_TONE_RAIL.DANGER],
  ])("paints %s in its own colour", (tone, rail) => {
    expect(draw(tone)).toContain(rail);
  });

  it("paints a tone a newer panel invents in the fallback colour", () => {
    expect(draw("CRITICAL")).toContain(HINT_TONE_RAIL.INFO);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "still paints something when the tone is %s",
    (tone) => {
      const className = draw(tone);

      expect(
        RAILS.some((rail) => className.includes(rail)),
        `the stripe rendered with no colour class at all (className: "${className}") — the tone reached the customer as nothing`,
      ).toBe(true);
      expect(className).toContain(HINT_TONE_RAIL.INFO);
    },
  );
});

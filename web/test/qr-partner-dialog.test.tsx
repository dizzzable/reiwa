// @vitest-environment jsdom

/**
 * A partner's advertising code, opened large — through the app's REAL dialog
 * primitive, for what no mock can show: that the thumbnail is a named button,
 * that focus moves into the dialog, that Escape and the close button dismiss it,
 * and that focus comes back to the thumbnail that opened it. That last one is
 * the reason the dialog is opened through `DialogTrigger`: a controlled Radix
 * dialog without a trigger sends focus to the page body on close (it focuses
 * `context.triggerRef`, which only a trigger sets).
 *
 * What the code in it looks like — the same link, the operator's style, the
 * logo, 256 px — is proven in `qr-style-call-sites.test.tsx`.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const motion = vi.hoisted(() => ({ reduce: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  useReducedMotion: () => motion.reduce,
}));

import { ENLARGED_PARTNER_QR_PIXELS, PartnerQrDialog } from "@/features/partner/components/partner-qr-dialog";
import { QR_STYLE_PLAIN } from "@/lib/qr-style";

const LINK = "https://t.me/reiwa_bot?start=ad_abc123";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  motion.reduce = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

/** Lets effects, Radix's focus timers and the code's promise settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

const thumbnail = (): HTMLButtonElement | null =>
  container?.querySelector<HTMLButtonElement>('button[aria-label="partnerAds.qrEnlargeBot"]') ?? null;
const dialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="dialog"]');

async function open(): Promise<HTMLElement> {
  mount(
    <PartnerQrDialog kind="bot" url={LINK} style={QR_STYLE_PLAIN}>
      <span>thumbnail</span>
    </PartnerQrDialog>,
  );
  const button = thumbnail();
  expect(button, "the thumbnail is not a button named for what it opens").not.toBeNull();
  act(() => {
    button?.focus();
  });
  await act(async () => {
    button?.click();
  });
  await settle();
  const opened = dialog();
  expect(opened, "the dialog did not open").not.toBeNull();
  return opened as HTMLElement;
}

describe("the enlarged partner code, through the real dialog", () => {
  it("is opened by a button that says it opens a dialog, wrapping the thumbnail as it was", () => {
    mount(
      <PartnerQrDialog kind="web" url={LINK} style={QR_STYLE_PLAIN}>
        <span data-testid="thumb">thumbnail</span>
      </PartnerQrDialog>,
    );
    const button = container?.querySelector<HTMLButtonElement>('button[aria-label="partnerAds.qrEnlargeWeb"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.querySelector('[data-testid="thumb"]')).not.toBeNull();
    expect(dialog()).toBeNull();
  });

  it("moves focus into the dialog, names it, and draws the code at its size", async () => {
    const opened = await open();
    expect(opened.contains(document.activeElement), "focus stayed behind the dialog").toBe(true);
    expect(thumbnail()?.getAttribute("aria-expanded")).toBe("true");
    const title = document.getElementById(opened.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("partnerAds.qrDialogBot");
    const img = opened.querySelector('img[alt="partnerAds.qrDialogBot"]');
    expect(img?.getAttribute("width")).toBe(String(ENLARGED_PARTNER_QR_PIXELS));
    expect(ENLARGED_PARTNER_QR_PIXELS).toBe(256);
    // The link is the dialog's description.
    expect(document.getElementById(opened.getAttribute("aria-describedby") ?? "")?.textContent).toBe(LINK);
  });

  it("closes on Escape, and gives focus back to the thumbnail that opened it", async () => {
    const opened = await open();
    await act(async () => {
      (document.activeElement ?? opened).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(dialog(), "Escape did not close the dialog").toBeNull();
    expect(document.activeElement, "focus was not returned to the thumbnail").toBe(thumbnail());
  });

  it("closes from its close button, and gives focus back the same way", async () => {
    const opened = await open();
    // The primitive's own close control (its label comes from the i18n singleton, not from this mock).
    const close = opened.querySelector<HTMLButtonElement>('button[data-slot="dialog-close"]');
    expect(close, "the dialog has no close button").not.toBeNull();
    await act(async () => {
      close?.click();
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumbnail());
  });

  it("switches the zoom-in off under prefers-reduced-motion, and only then", async () => {
    const animated = await open();
    expect(animated.style.animation, "animation suppressed with motion allowed").toBe("");
    act(() => root?.unmount());
    container?.remove();
    await settle();

    motion.reduce = true;
    const still = await open();
    expect(still.style.animation).toBe("none");
  });
});

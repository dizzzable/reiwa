// @vitest-environment jsdom

/**
 * Operator decoration on the dashboard header icons.
 *
 * Two properties matter more than the pretty part:
 *
 *  1. an icon nobody decorated must render EXACTLY what it rendered before
 *     this feature existed — the overwhelming majority of installs will never
 *     open that block, and a default that drifts is a redesign nobody asked
 *     for;
 *  2. a value this build has never heard of must degrade, not blank. The
 *     panel ships ahead of the cabinet, so "an effect from next month's
 *     panel" is the normal state of an install mid-upgrade, not corruption.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getQuests: vi.fn(),
  claimQuest: vi.fn(),
  questIconUrl: vi.fn(() => "/icon.svg"),
  startPartnerVisit: vi.fn(),
  confirmPartnerVisit: vi.fn(),
  submitPartnerCode: vi.fn(),
}));
const brandingState = vi.hoisted(() => ({
  iconDecor: undefined as Record<string, Record<string, string>> | undefined,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("motion/react", () => ({ useReducedMotion: () => true }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client/quests", () => api);
vi.mock("@/hooks/use-install-prompt", () => ({
  useInstallPrompt: () => ({
    canInstall: false,
    isStandalone: false,
    isIos: true,
    isTelegramWebview: false,
    promptInstall: vi.fn(),
  }),
  isStandalonePwa: () => false,
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    botUsername: null,
    branding: { botUsername: null, iconDecor: brandingState.iconDecor },
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
}));

import { QuestsIcon } from "../src/features/dashboard/components/quests-icon";

const QUEST = {
  id: "q-1",
  type: "LINK_TELEGRAM",
  title: { ru: "т", en: "t" },
  description: { ru: "", en: "" },
  iconKind: "PRESET",
  iconRef: "telegram",
  rewardType: "POINTS",
  rewardAmount: 3,
  status: "IN_PROGRESS",
  progress: 0,
  claimable: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  brandingState.iconDecor = undefined;
  api.getQuests.mockResolvedValue({ pointsBalance: 0, quests: [QUEST] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QuestsIcon />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.querySelector("button")) break;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The wrapper that carries the effect class and the accent variable. */
function shell(): HTMLElement | null {
  return container.querySelector("span.relative.inline-flex");
}

describe("an undecorated dashboard icon", () => {
  it("carries no effect class and no inline accent", async () => {
    await render();
    const wrapper = shell();
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).not.toContain("icon-effect");
    expect(wrapper?.getAttribute("style")).toBeNull();
  });

  it("is unaffected by decoration aimed at a different icon", async () => {
    brandingState.iconDecor = { bell: { effect: "pulse", color: "#ff0000" } };
    await render();
    expect(shell()?.className).not.toContain("icon-effect");
  });
});

describe("a decorated dashboard icon", () => {
  it("wears the operator's effect", async () => {
    brandingState.iconDecor = { quests: { effect: "pulse" } };
    await render();
    expect(shell()?.className).toContain("icon-effect-pulse");
  });

  it("carries the accent as a variable the glow can read", async () => {
    // The halo is a static box-shadow on a pseudo-element reading this
    // variable; nothing else can hand a colour to a `::after`.
    brandingState.iconDecor = { quests: { effect: "glow", color: "#ff0055" } };
    await render();
    const style = shell()?.getAttribute("style") ?? "";
    expect(style).toContain("--icon-effect-color");
    expect(style).toContain("#ff0055");
  });

  it("paints the glyph on the glyph itself, not on the wrapper", async () => {
    // A class on the button sets `color`, and a class on a child beats an
    // inline style on an ancestor — tinting the wrapper would look like it
    // worked in the panel preview and do nothing in the cabinet.
    brandingState.iconDecor = { quests: { color: "#ff0055" } };
    await render();
    const svg = container.querySelector<SVGElement>("button svg");
    // jsdom normalises an inline colour to `rgb()`, so compare on that.
    expect(svg?.style.color).toBe("rgb(255, 0, 85)");
  });

  it("swaps the glyph for the one the operator picked", async () => {
    brandingState.iconDecor = { quests: { glyph: "gift" } };
    await render();
    const svg = container.querySelector("button svg");
    expect(svg?.classList.contains("lucide-gift")).toBe(true);
  });
});

describe("a value from a newer panel", () => {
  it("keeps the shipped glyph when the name is unknown here", async () => {
    brandingState.iconDecor = { quests: { glyph: "unicorn" } };
    await render();
    const svg = container.querySelector("button svg");
    expect(svg).not.toBeNull();
    expect(svg?.classList.contains("lucide-sparkles")).toBe(true);
  });

  it("applies no effect when the effect name is unknown here", async () => {
    brandingState.iconDecor = { quests: { effect: "supernova" } };
    await render();
    expect(shell()?.className).not.toContain("icon-effect");
  });

  it("still renders the icon at all", async () => {
    // The failure mode this whole file guards: a cabinet mid-upgrade showing
    // a hole where the quests button was.
    brandingState.iconDecor = { quests: { glyph: "unicorn", effect: "supernova" } };
    await render();
    expect(container.querySelector("button")).not.toBeNull();
  });
});

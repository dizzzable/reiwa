// @vitest-environment jsdom

/**
 * The install quest's button.
 *
 * The ask was "one click starts the browser's install prompt". That is only
 * possible from the click itself: a deferred `beforeinstallprompt` has to be
 * spent inside a user gesture, so routing somewhere first and pressing a
 * second button there would be a worse flow AND a gesture the browser may
 * refuse. The navigation branch exists only for platforms with no prompt to
 * spend — iOS is effectively all of them, and there the settings sheet
 * carries the Share → Add-to-Home-Screen steps.
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
const installState = vi.hoisted(() => ({
  current: {
    canInstall: false,
    isStandalone: false,
    isIos: true,
    isTelegramWebview: false,
    promptInstall: vi.fn(async () => undefined),
  },
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("motion/react", () => ({ useReducedMotion: () => true }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api-client/quests", () => api);
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ botUsername: null, branding: { botUsername: null } }),
}));
vi.mock("@/hooks/use-install-prompt", () => ({
  useInstallPrompt: () => installState.current,
  isStandalonePwa: () => installState.current.isStandalone,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
}));

import { QuestsIcon } from "../src/features/dashboard/components/quests-icon";

const INSTALL_QUEST = {
  id: "q-1",
  type: "INSTALL_PWA",
  title: { ru: "Установите приложение", en: "Install the app" },
  description: { ru: "", en: "" },
  iconKind: "PRESET",
  iconRef: "install",
  rewardType: "POINTS",
  rewardAmount: 5,
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
  api.getQuests.mockResolvedValue({ pointsBalance: 0, quests: [INSTALL_QUEST] });
  installState.current = {
    canInstall: false,
    isStandalone: false,
    isIos: true,
    isTelegramWebview: false,
    promptInstall: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  navigate.mockClear();
});

async function openList(): Promise<void> {
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
  const entry = container.querySelector("button");
  await act(async () => {
    entry?.click();
  });
}

function installButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("quests.actions.install"),
  );
}

describe("the install quest button", () => {
  it("appears on the row", async () => {
    await openList();
    expect(installButton()).toBeDefined();
  });

  it("spends the deferred prompt on the click itself", async () => {
    // THE case. Not "opens a page where a prompt could be spent" — the gesture
    // is here and nowhere else.
    installState.current = { ...installState.current, canInstall: true, isIos: false };
    await openList();
    await act(async () => {
      installButton()?.click();
    });
    expect(installState.current.promptInstall).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes to the settings sheet when there is no prompt to spend", async () => {
    // iOS: Safari has no `beforeinstallprompt` at all, so the only honest
    // thing left is the Share → Add-to-Home-Screen instructions.
    await openList();
    await act(async () => {
      installButton()?.click();
    });
    expect(installState.current.promptInstall).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/settings?install=1");
  });

  it("shows a claim button instead once the server has completed it", async () => {
    // Completion is server-side, from the first open OUT of the installed app.
    // The row must not keep offering the install once the reward is waiting.
    api.getQuests.mockResolvedValue({
      pointsBalance: 0,
      quests: [{ ...INSTALL_QUEST, status: "COMPLETED", claimable: true }],
    });
    await openList();
    expect(installButton()).toBeUndefined();
    expect(container.textContent).toContain("quests.claim");
  });
});

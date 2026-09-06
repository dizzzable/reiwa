// @vitest-environment jsdom

/**
 * `/settings?install=1` — where the "Install the app" quest sends people.
 *
 * The settings hub carries twelve rows and "Install the app" is one of them,
 * so a quest CTA that merely lands here repeats a stall support already paid
 * for once with the linking quests. The parameter opens the sheet.
 *
 * The sheet, and not the native prompt. A deferred `beforeinstallprompt` has
 * to be spent from inside a user gesture, and arriving on a page is not one —
 * the same reason a payment redirect cannot open a tab on the way back. The
 * button inside the sheet is the gesture, which is why the last case here
 * asserts the prompt is NOT fired on arrival.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installState = vi.hoisted(() => ({
  current: {
    canInstall: false,
    isStandalone: false,
    isIos: true,
    isTelegramWebview: false,
    promptInstall: vi.fn(async () => undefined),
  },
}));
const routerState = vi.hoisted(() => ({
  params: new URLSearchParams(),
  setSearchParams: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [routerState.params, routerState.setSearchParams] as const,
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: ComponentProps<"button">) => (
      <button {...props}>{children}</button>
    ),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-install-prompt", () => ({
  useInstallPrompt: () => installState.current,
  isStandalonePwa: () => installState.current.isStandalone,
}));
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({ session: { user: { id: "u-1" } } }),
}));
vi.mock("@/hooks/use-is-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("@/lib/api-client", () => ({
  updateLanguage: vi.fn(),
  getNotifications: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("@/i18n/i18n", () => ({ setLocale: vi.fn() }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({
    branding: { brandName: "Reiwa", iconColorMode: "default", iconColors: {} },
    themeMode: "dark",
    canChooseThemeMode: false,
    setThemeMode: vi.fn(),
  }),
}));
vi.mock("@/features/onboarding/onboarding-tour-controller", () => ({
  useOnboardingContext: () => ({ replayTour: vi.fn() }),
}));
vi.mock("@/features/auth/use-sign-out", () => ({
  useSignOut: () => ({ signOut: vi.fn(), isPending: false }),
}));
vi.mock("@/components/layout/sign-out-confirm-dialog", () => ({
  SignOutConfirmDialog: () => null,
}));
vi.mock("@/components/ui/flag-icon", () => ({ FlagIcon: () => null }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
}));

import SettingsPage from "../src/features/settings/settings-page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  routerState.params = new URLSearchParams();
  routerState.setSearchParams = vi.fn();
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
});

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function dialog(): HTMLElement | null {
  return container.querySelector("[data-testid='dialog']");
}

describe("the install deep link", () => {
  it("opens nothing when the parameter is absent", async () => {
    await render();
    expect(dialog()).toBeNull();
  });

  it("opens the install sheet on ?install=1", async () => {
    routerState.params = new URLSearchParams("install=1");
    await render();
    expect(dialog()).not.toBeNull();
    expect(container.textContent).toContain("settings.installIosTitle");
  });

  it("strips the parameter so a refresh does not re-open the sheet", async () => {
    routerState.params = new URLSearchParams("install=1");
    await render();
    expect(routerState.setSearchParams).toHaveBeenCalled();
    const [next, opts] = routerState.setSearchParams.mock.calls[0] as [URLSearchParams, unknown];
    expect(next.get("install")).toBeNull();
    expect(opts).toEqual({ replace: true });
  });

  it("keeps other parameters that were on the URL", async () => {
    routerState.params = new URLSearchParams("install=1&ref=quest");
    await render();
    const [next] = routerState.setSearchParams.mock.calls[0] as [URLSearchParams];
    expect(next.get("ref")).toBe("quest");
  });

  it("offers a real button instead of firing the prompt on arrival", async () => {
    // THE case. Spending the deferred event from a load effect is both a
    // gesture violation and a modal nobody asked for; the button is the
    // gesture.
    installState.current = { ...installState.current, canInstall: true, isIos: false };
    routerState.params = new URLSearchParams("install=1");
    await render();

    expect(installState.current.promptInstall).not.toHaveBeenCalled();
    expect(container.textContent).toContain("settings.installPromptAction");

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("settings.installPromptAction"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(installState.current.promptInstall).toHaveBeenCalledTimes(1);
  });

  it("says something true in a browser that cannot install at all", async () => {
    // Firefox, or a desktop browser that never offered the event. Before the
    // deep link existed this state was unreachable — the row is hidden — so
    // an empty sheet was the alternative.
    installState.current = { ...installState.current, isIos: false };
    routerState.params = new URLSearchParams("install=1");
    await render();
    expect(container.textContent).toContain("settings.installUnavailableTitle");
  });

  it("tells somebody already inside the installed app that it is done", async () => {
    installState.current = { ...installState.current, isIos: false, isStandalone: true };
    routerState.params = new URLSearchParams("install=1");
    await render();
    expect(container.textContent).toContain("settings.installAlreadyTitle");
  });
});

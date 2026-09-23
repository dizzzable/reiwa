// @vitest-environment jsdom

/**
 * The cabinet welcomes a customer to the OPERATOR'S service.
 *
 * The intro screen (`/onboarding`) opened with «Добро пожаловать в Rezeis VPN»:
 * "Rezeis" is the panel the operator runs, not the brand their customers
 * bought, and it stood in the one place a customer is told whose product this
 * is. The cabinet knows the operator's brand at that point — it is the name
 * the header, the sign-in screen and the install prompt already carry — so the
 * welcome says that name.
 *
 * The dictionaries are checked as a class too: no cabinet string names the
 * panel, in either language, so the next one fails here instead of on a
 * customer's screen.
 */

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-session", () => ({ useSession: () => ({ session: null }) }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: ComponentProps<"div"> & Record<string, unknown>) => <div {...props}>{children}</div>,
  },
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Acme VPN" } }),
}));

// The real bundles: the point is what the customer reads, not which key the
// page asked for.
import { i18n } from "@/i18n/i18n";
import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";
import OnboardingPage from "@/features/onboarding/onboarding-page";

const PANEL_NAME = /rezeis/i;

/** Every string in `value` that names the panel, by its key path. */
function pathsNamingThePanel(value: unknown, path = ""): string[] {
  if (typeof value === "string") return PANEL_NAME.test(value) ? [path] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    pathsNamingThePanel(inner, path === "" ? key : `${path}.${key}`),
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderIn(language: "ru" | "en"): Promise<void> {
  await i18n.changeLanguage(language);
  await act(async () => {
    root.render(<OnboardingPage />);
  });
}

describe("the cabinet's welcome", () => {
  it("names the operator's brand, in Russian", async () => {
    await renderIn("ru");

    expect(container.querySelector("h1")?.textContent).toBe("Добро пожаловать в Acme VPN");
    expect(container.textContent).not.toMatch(PANEL_NAME);
  });

  it("names the operator's brand, in English", async () => {
    await renderIn("en");

    expect(container.querySelector("h1")?.textContent).toBe("Welcome to Acme VPN");
    expect(container.textContent).not.toMatch(PANEL_NAME);
  });
});

describe("the cabinet's dictionaries", () => {
  it("name the panel in no string", () => {
    expect(pathsNamingThePanel({ ru, en })).toEqual([]);
  });
});

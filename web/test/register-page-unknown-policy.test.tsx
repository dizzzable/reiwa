// @vitest-environment jsdom

/**
 * Registration by invite does not open while the policy cannot be read.
 *
 * With `/platform-policy` answering 503 (the cabinet's API never knew a policy
 * and the panel is down) the register page used to read the access mode as
 * `PUBLIC` and show the open form — on an install that registers by invite
 * only. It now waits on its spinner while the policy query keeps asking, and
 * shows what the operator chose the moment an answer lands: here, the invite
 * gate. Driven through the real `useAccessMode` and the real query options.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPlatformPolicy: vi.fn(),
  getLegalDocuments: vi.fn(),
  getGuestSupportConfig: vi.fn(),
  registerUser: vi.fn(),
  checkUsername: vi.fn(),
  login: vi.fn(),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        ({ children }: { readonly children?: ReactNode }) => {
          const Tag = tag as "div";
          return <Tag>{children}</Tag>;
        },
    },
  ),
}));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/features/auth/external-auth-buttons", () => ({ ExternalAuthButtons: () => null }));

import RegisterPage from "../src/features/auth/register-page";

const UNAVAILABLE = Object.assign(new Error("Request failed with status code 503"), {
  response: { status: 503, data: { message: "Platform policy unavailable" } },
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/register");
  api.getLegalDocuments.mockResolvedValue([]);
  api.getGuestSupportConfig.mockResolvedValue({ enabled: false, turnstileSiteKey: null });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <RegisterPage />
      </QueryClientProvider>,
    );
  });
}

const form = () => container?.querySelector("#register-username") ?? null;
const inviteGate = () => container?.querySelector("#invite-code") ?? null;

describe("the register page with the platform policy unreadable", () => {
  it("shows neither the open form nor any gate while no policy is known", async () => {
    api.getPlatformPolicy.mockRejectedValue(UNAVAILABLE);
    mount();
    await elapse(0);
    await elapse(60_000);

    expect(form(), "the open form showed on an unknown policy — read as PUBLIC").toBeNull();
    expect(inviteGate()).toBeNull();
    expect(container?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("says after about ten seconds that the panel is unavailable and it keeps trying — still no form (CD2a §9.2)", async () => {
    api.getPlatformPolicy.mockRejectedValue(UNAVAILABLE);
    mount();
    await elapse(0);
    await elapse(9_000);
    const note = () => container?.querySelector('[data-testid="access-mode-pending-note"]') ?? null;
    // A first read is well under a second: no word for an ordinary load.
    expect(note()).toBeNull();

    await elapse(1_000);
    expect(note()?.textContent).toBe("accessMode.pendingNote");
    // Only the words change: still waiting, and still asking.
    expect(container?.querySelector(".animate-spin")).not.toBeNull();
    expect(form()).toBeNull();
    expect(inviteGate()).toBeNull();
    const asked = api.getPlatformPolicy.mock.calls.length;
    await elapse(30_000);
    expect(api.getPlatformPolicy.mock.calls.length).toBeGreaterThan(asked);
  });

  it("shows the invite gate once the policy is read", async () => {
    api.getPlatformPolicy.mockRejectedValueOnce(UNAVAILABLE).mockResolvedValue({ accessMode: "INVITED" });
    mount();
    await elapse(0);
    expect(form()).toBeNull();

    await elapse(3_000);
    expect(inviteGate()).not.toBeNull();
    expect(form()).toBeNull();
  });

  it("shows the open form once the policy says registration is open", async () => {
    api.getPlatformPolicy.mockResolvedValue({ accessMode: "PUBLIC" });
    mount();
    await elapse(0);
    expect(form()).not.toBeNull();
  });
});

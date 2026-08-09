// @vitest-environment jsdom

/**
 * `/claim` must offer "I already have an account" on a network that cannot
 * reach telegram.org.
 *
 * A subscriber who registered on the web, then opened the Mini App from the
 * bot, arrives here whenever the bootstrap resolved to a Telegram shell with no
 * `WebAccount`. The create-credentials form in front of them would make a
 * SECOND account — their subscription is on the first one. The only way out is
 * the "Войти" control, which switches this page into link mode and calls
 * `POST /auth/telegram/link-existing` with the launch payload.
 *
 * That control used to be gated on `window.Telegram?.WebApp?.initData` — the
 * bridge, which exists only after ~100 KB has been fetched from telegram.org.
 * This product sells VPN, so the customer who most needs the link is precisely
 * the one whose network blocks that host: the escape hatch was invisible to
 * exactly the people it exists for. `c087865` removed that pattern from every
 * other entry file and missed this one.
 *
 * So the case below defines `window.Telegram` NOWHERE and holds the clock at
 * zero. Anything that passes had to be decided from the URL alone.
 */

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  claimAccount: vi.fn(),
  linkExistingAccount: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));
const sessionState = vi.hoisted(() => ({
  session: { userId: "u1", telegramId: "42", webAccount: null } as unknown,
  isLoading: false,
  isAuthenticated: true,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => queryClient }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => sessionState,
}));
vi.mock("@/lib/crypto", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
}));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/components/ui/brand-logo", () => ({ BrandLogo: () => null }));
vi.mock("lucide-react", () => ({
  ShieldCheck: () => null,
  Eye: () => null,
  EyeOff: () => null,
  Loader2: () => null,
}));
// `motion.div` / `motion.form` render as their plain tags; the animation props
// are not what this file is about, and they are not valid DOM attributes.
vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        ({ children, onSubmit, className, noValidate }: {
          readonly children?: ReactNode;
          readonly onSubmit?: (event: React.FormEvent) => void;
          readonly className?: string;
          readonly noValidate?: boolean;
        }) => {
          const Tag = tag as "div";
          return (
            <Tag className={className} {...(tag === "form" ? { onSubmit, noValidate } : {})}>
              {children}
            </Tag>
          );
        },
    },
  ),
}));

import ClaimPage from "@/features/auth/claim-page";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

/**
 * A signed Telegram launch payload, i.e. a non-empty `initData`, with
 * `auth_date` stamped NOW rather than 1970.
 *
 * The cabinet refuses to replay a CARRIED payload past the server's own 24h
 * window (`telegram-launch-params.ts`, `isSpentLaunchPayload`) — the server
 * would answer it 401 and the error screen's Retry would reload into the same
 * 401 forever. A fixture stamped 1970 is exactly that dead payload, so every
 * mirror/memory case below would be asserting on a launch the product is right
 * to drop. This says what the fixture always claimed to be: a live launch.
 */
const LAUNCH_AUTH_DATE = Math.floor(Date.now() / 1000);
const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${LAUNCH_AUTH_DATE}&hash=deadbeef`;
/** The SDK's own session key; the cabinet mirrors the launch into it. */
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(page: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(page);
  });
}

/** Every rendered element whose own text is exactly `text`. */
function findByText(text: string): HTMLElement[] {
  return [...(container?.querySelectorAll("button, a, span") ?? [])].filter(
    (element): element is HTMLElement => element.textContent?.trim() === text,
  );
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Sets a controlled input's value the way a real keystroke would. */
function type(selector: string, value: string): void {
  const input = container?.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input matching ${selector}`);
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const form = container?.querySelector("form");
  if (!form) throw new Error("no form rendered");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/claim");
  window.location.hash = "";
  window.sessionStorage.clear();
  // The module's in-memory launch capture survives client-side navigation by
  // design; clear it so each case starts from a cold document.
  __resetTelegramLaunchCaptureForTests();
  // The whole point: the bridge never arrives. telegram.org is unreachable.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  api.linkExistingAccount.mockResolvedValue({ ok: true, status: "linked" });
  api.claimAccount.mockResolvedValue({ userId: "u1", webAccountId: "w1" });
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

describe("ClaimPage — the link-existing escape hatch, with no Telegram SDK", () => {
  it("offers the control when the launch payload is in the URL fragment", () => {
    window.location.hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6`;

    mount(<ClaimPage />);

    expect(
      findByText("claim.linkExisting.action"),
      'the "I already have an account" control is missing — a subscriber who registered on the web is being offered only the create-credentials form, which makes a SECOND account',
    ).toHaveLength(1);
    expect(window.Telegram).toBeUndefined();
  });

  it("offers the control from the session mirror once the hash is gone", () => {
    // `/claim` is reached by `<Navigate to="/claim" replace />` from
    // StealthLayout, and react-router drops the fragment. The mirror the launch
    // document wrote is all that is left of the payload — and it is enough.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" }),
    );
    expect(window.location.hash).toBe("");

    mount(<ClaimPage />);

    expect(findByText("claim.linkExisting.action")).toHaveLength(1);
  });

  it("links the existing account with the initData read off the URL", async () => {
    window.location.hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}`;

    mount(<ClaimPage />);
    click(findByText("claim.linkExisting.action")[0]);

    type("#claim-username", "existing-user");
    type("#claim-password", "existing-password");
    await submit();

    expect(
      api.linkExistingAccount,
      "the link request did not carry the launch payload — the BFF rejects an empty `Authorization: tma` with 400",
    ).toHaveBeenCalledWith(INIT_DATA, "existing-user", "hashed-password");
    expect(api.claimAccount).not.toHaveBeenCalled();

    // Linking is automatic and terminal: the BFF re-mints the WebSession as the
    // existing account, so the only thing left to do is refetch the session and
    // land in the cabinet. No confirmation step, no second form, and above all
    // no user-facing "merge" affordance — merging accounts is operator-only.
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session"] });
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(
      container?.querySelector('[role="alert"]'),
      "a successful link left an error/prompt on screen — the user must go straight to their cabinet",
    ).toBeNull();
  });

  it("withholds the control from a plain browser visitor", () => {
    // No fragment, no mirror, no bridge: nothing proves a Telegram id, so the
    // link flow would fail server-side. Only the create-credentials form is
    // honest here.
    mount(<ClaimPage />);

    expect(findByText("claim.linkExisting.action")).toHaveLength(0);
  });
});

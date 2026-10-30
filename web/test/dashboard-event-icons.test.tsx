// @vitest-environment jsdom
/**
 * The wheel and the contests are two mechanics with two icons (the owner,
 * 30.10.2026). Between 29 and 30.10 one icon led to both, showed while either
 * was on, and lit its dot for either.
 *
 * Each icon is held to its own mechanic here: when it shows, where it goes,
 * and what lights its dot.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getWheel: vi.fn(), getContests: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/icon-decor", () => ({ useIconDecor: () => ({ Glyph: null, effectClass: "", wrapperStyle: {}, glyphStyle: {} }) }));

import { ContestsIcon } from "../src/features/dashboard/components/contests-icon";
import { WheelIcon } from "../src/features/dashboard/components/wheel-icon";
import type { ContestView } from "../src/lib/api-client/contests";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function show(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

const button = (): HTMLButtonElement | null => container?.querySelector("button") ?? null;
const dot = (): Element | null => container?.querySelector("span[aria-hidden]") ?? null;

function contest(overrides: Partial<ContestView>): ContestView {
  return {
    id: "c1",
    title: { ru: "Конкурс" },
    description: {},
    status: "ACTIVE",
    startAt: new Date(Date.now() - 1000).toISOString(),
    endAt: new Date(Date.now() + 86_400_000).toISOString(),
    entries: 0,
    prizes: [],
    entered: false,
    closed: null,
    myResult: null,
    ...overrides,
  };
}

describe("the wheel icon", () => {
  it("goes to the wheel itself, and its dot is a spin only", async () => {
    api.getWheel.mockResolvedValue({ enabled: true, canSpin: false });
    api.getContests.mockResolvedValue([contest({})]);
    await show(<WheelIcon />);

    expect(button()).not.toBeNull();
    expect(dot(), "a contest someone may enter is not the wheel's to announce").toBeNull();
    act(() => button()?.click());
    expect(navigate).toHaveBeenCalledWith("/wheel");
  });

  it("is gone while the wheel is off — a running contest does not bring it back", async () => {
    api.getWheel.mockResolvedValue({ enabled: false, canSpin: false });
    api.getContests.mockResolvedValue([contest({})]);
    await show(<WheelIcon />);

    expect(button()).toBeNull();
  });

  it("lights its dot for a spin", async () => {
    api.getWheel.mockResolvedValue({ enabled: true, canSpin: true });
    await show(<WheelIcon />);

    expect(dot()).not.toBeNull();
  });
});

describe("the contests icon", () => {
  it("is gone when no contest runs — finished ones and the wheel do not count", async () => {
    api.getWheel.mockResolvedValue({ enabled: true, canSpin: true });
    api.getContests.mockResolvedValue([contest({ status: "DRAWN" }), contest({ id: "c2", status: "CANCELLED" })]);
    await show(<ContestsIcon />);

    expect(button()).toBeNull();
  });

  it("goes to the contests, with a dot for a draw the person can still enter", async () => {
    api.getContests.mockResolvedValue([contest({})]);
    await show(<ContestsIcon />);

    expect(dot()).not.toBeNull();
    act(() => button()?.click());
    expect(navigate).toHaveBeenCalledWith("/events");
  });

  it("shows a running leaderboard without a dot — there is nothing to tap «Участвовать» on", async () => {
    api.getContests.mockResolvedValue([contest({ kind: "LEADERBOARD", closed: "AUTOMATIC" })]);
    await show(<ContestsIcon />);

    expect(button()).not.toBeNull();
    expect(dot()).toBeNull();
  });

  it("has no dot for a contest already entered", async () => {
    api.getContests.mockResolvedValue([contest({ entered: true })]);
    await show(<ContestsIcon />);

    expect(dot()).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * «События» — the contest cards (29.10.2026).
 *
 * Rendered through the real page with the real dictionaries: the conditions
 * a contest asks for (a channel, tickets), a contest that has not started
 * yet, the winners of a finished one with their names masked, a cancelled one
 * the person had entered, the draw key folded away — and an entry Telegram
 * refused, which leaves the link to the channel on the card.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next, { type TFunction } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getContests: vi.fn(),
  getWheel: vi.fn(),
  enterContest: vi.fn(),
}));
const translate = vi.hoisted(() => ({
  t: ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string,
}));
const opened = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  Link: ({ children, to }: { readonly children?: ReactNode; readonly to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) =>
      translate.t(key, typeof options === "string" ? { defaultValue: options } : (options as Record<string, unknown>)),
    i18n: { language: "ru" },
  }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/utils")>();
  return { ...actual, openExternalUrl: (url: string) => opened.urls.push(url) };
});

import EventsPage from "../src/features/events/events-page";
import { ru } from "../src/i18n/ru";
import type { ContestView } from "../src/lib/api-client/contests";

const HOUR = 60 * 60 * 1000;
const HASH = "a".repeat(64);
const SEED = "b".repeat(64);

function contest(overrides: Partial<ContestView>): ContestView {
  return {
    id: "c-running",
    title: { ru: "Осенний розыгрыш" },
    description: { ru: "Правила:\nподпишитесь и ждите" },
    status: "ACTIVE",
    startAt: new Date(Date.now() - HOUR).toISOString(),
    endAt: new Date(Date.now() + 50 * HOUR).toISOString(),
    entries: 12,
    prizes: [{ place: 1, kind: "DAYS", title: { ru: "30 дней" }, amount: 30 }],
    entered: false,
    closed: null,
    myResult: null,
    channel: null,
    tickets: null,
    seedHash: HASH,
    seed: null,
    winners: null,
    drawnEntries: null,
    drawnTickets: null,
    ...overrides,
  };
}

let ruT: TFunction;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({ lng: "ru", resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } });
  ruT = instance.t.bind(instance);
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  translate.t = (key, options) => ruT(key, options);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.getWheel.mockResolvedValue({ enabled: false, canSpin: false });
  opened.urls = [];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function show(contests: ContestView[]): Promise<void> {
  api.getContests.mockResolvedValue(contests);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <EventsPage />
      </QueryClientProvider>,
    );
  });
  await settle();
  await settle();
}

function text(): string {
  return container?.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((el) => el.textContent?.includes(label));
  expect(found, `a button «${label}»`).toBeDefined();
  return found as HTMLButtonElement;
}

describe("a running contest", () => {
  it("keeps the rules' line breaks and says when the draw is", async () => {
    await show([contest({ endAt: new Date(Date.now() + 100 * HOUR).toISOString() })]);

    const description = container?.querySelector("p.whitespace-pre-line");
    expect(description?.textContent).toBe("Правила:\nподпишитесь и ждите");
    expect(text()).toMatch(/Розыгрыш через 4 дня/);
  });

  it("says when a contest that has not started yet will start", async () => {
    await show([contest({ startAt: new Date(Date.now() + 3 * HOUR).toISOString(), closed: "NOT_STARTED" })]);

    expect(text()).toMatch(/Начнётся /);
    expect(text()).toContain(ru.events.refusal.NOT_STARTED);
  });

  it("lists what earns tickets and how many the person holds", async () => {
    await show([contest({ tickets: { perPurchase: 2, perReferral: 5, max: 10, mine: 3 } })]);

    expect(text()).toContain("У вас 3 билета");
    expect(text()).toContain("+2 за каждую оплату");
    expect(text()).toContain("+5 за каждого друга, который оплатит подписку");
    expect(text()).toContain("не больше 10");
  });

  it("links to the channel a contest asks for", async () => {
    await show([contest({ channel: { joinUrl: "https://t.me/contest_news" } })]);

    expect(text()).toContain(ru.events.channel.needed);
    act(() => button(ru.events.channel.open).click());
    expect(opened.urls).toEqual(["https://t.me/contest_news"]);
  });

  it("leaves the link on the card when Telegram refuses the entry", async () => {
    api.enterContest.mockResolvedValue({ entered: false, reason: "CHANNEL_REQUIRED", joinUrl: "https://t.me/+invite" });
    await show([contest({})]);

    act(() => button(ru.events.enter).click());
    await settle();

    expect(api.enterContest).toHaveBeenCalledWith("c-running");
    act(() => button(ru.events.channel.open).click());
    expect(opened.urls).toEqual(["https://t.me/+invite"]);
  });

  it("shows the draw key's fingerprint, not the key", async () => {
    await show([contest({})]);

    expect(text()).toContain(`SHA-256: ${HASH}`);
    expect(text()).not.toContain(SEED);
  });
});

describe("a finished contest", () => {
  const drawn = contest({
    id: "c-drawn",
    status: "DRAWN",
    entered: false,
    seed: SEED,
    drawnEntries: 40,
    winners: [
      { place: 1, name: "Ив***в", prizeTitle: { ru: "30 дней" } },
      { place: 2, name: null, prizeTitle: { ru: "100 баллов" } },
    ],
  });

  it("shows everybody who won, with masked names", async () => {
    await show([drawn]);

    const winners = container?.querySelector('[data-testid="contest-winners"]')?.textContent ?? "";
    expect(winners).toContain("Ив***в");
    expect(winners).toContain(ru.events.winnerAnon);
    expect(winners).toContain("100 баллов");
  });

  it("does not tell somebody who never entered that they were unlucky", async () => {
    await show([drawn]);

    expect(text()).not.toContain(ru.events.result.notThisTime);
    expect(text()).toContain("40 участников");
  });

  it("tells an entrant how they did", async () => {
    await show([{ ...drawn, entered: true }]);

    expect(text()).toContain(ru.events.result.notThisTime);
  });

  it("reveals the draw key after the draw", async () => {
    await show([drawn]);

    expect(text()).toContain(SEED);
    expect(text()).toContain(`SHA-256: ${HASH}`);
  });

  it("marks a cancelled contest the person had entered, rather than dropping it", async () => {
    await show([contest({ id: "c-cancelled", status: "CANCELLED", entered: true })]);

    expect(text()).toContain(ru.events.cancelled);
    expect(text()).not.toContain(ru.events.fairness.title);
  });
});

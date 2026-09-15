// @vitest-environment jsdom

/**
 * «КАНАЛ ОБЯЗАТЕЛЕН» IN THE TELEGRAM MINI APP.
 *
 * The gate is mounted here the way `App.tsx` mounts it — around a router, under
 * the real `useSession`, the real `useTelegramWebApp` and a real React Query
 * client — and only the edges are stubbed: the network (`/session`,
 * `GET /channel-gate`, `POST /channel-gate/check`) and, where a case is about
 * it, the Telegram bridge. The join button goes through the real
 * `openExternalUrl`. The surface is decided by the real
 * `isTelegramMiniAppSurface()`, fed the way Telegram feeds it: launch parameters
 * in the URL fragment, in the SDK's session mirror, or nowhere. The words are
 * the shipped Russian dictionary, so every text asserted below is the text a
 * subscriber reads. The sessions are the shapes `/session` really sends.
 *
 * Every "is not on the page" below has a case in this file where the SAME
 * helper finds the thing it looks for: `cabinet()` in the let-in cases,
 * `wallHeading()` in the walled ones, `joinButton()` where a link exists. An
 * absence that could not be seen as a presence proves nothing.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError } from "axios";
import i18next from "i18next";
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  getChannelGate: vi.fn(),
  checkChannelGate: vi.fn(),
}));

// The network only. `readChannelGateFailure` and everything else stay real.
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  ...api,
}));
// Branding context and the operator's logo geometry; nothing this file is about.
vi.mock("@/components/ui/entry-brand-tile", () => ({ EntryBrandTile: () => <div data-probe="brand-tile" /> }));

import { ChannelGate } from "@/features/channel-gate/channel-gate";
import { CHANNEL_GATE_RESULT_ROOM } from "@/features/channel-gate/channel-gate-screen";
import { useSession } from "@/hooks/use-session";
import { __resetTelegramWebAppBridgeForTests } from "@/hooks/use-telegram-webapp";
import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";
import type { ReiwaSession } from "@/types/api";
import type { TelegramWebApp } from "@/types/telegram";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: "ru",
  fallbackLng: "ru",
  resources: { ru: { translation: ru } },
  interpolation: { escapeValue: false },
});

/**
 * A session exactly as `/session` passes the panel's payload through — every
 * field `mapInternalUserSession` (rezeis-admin, `internal-user.mappers.ts`)
 * writes, and nothing it does not. There is no `userId` on it.
 */
const PANEL_SESSION_WIRE = {
  id: "cmfa1b2c3d0000reiwa0subscriber",
  telegramId: "777000111",
  username: "subscriber",
  name: "Subscriber",
  email: null,
  role: "USER",
  language: "RU",
  personalDiscount: 0,
  purchaseDiscount: 0,
  points: 120,
  maxSubscriptions: 3,
  isBlocked: false,
  isBotBlocked: false,
  isRulesAccepted: true,
  onboardingCompleted: true,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-09-14T18:00:00.000Z",
  lastSeenAt: "2026-09-14T18:00:00.000Z",
  webAccount: null,
};
const SESSION: ReiwaSession = PANEL_SESSION_WIRE;
const OTHER_ACCOUNT: ReiwaSession = {
  ...PANEL_SESSION_WIRE,
  id: "cmfa1b2c3d0001reiwa00someone",
  telegramId: "777000222",
  username: "someone",
  name: "Someone else",
};
/** The legacy Telegram session `/session` falls back to when the panel does not answer: no `id`. */
const LEGACY_SESSION: ReiwaSession = {
  telegramId: "777000333",
  userId: 9001,
  name: "Legacy",
  role: "USER",
};
const LEGACY_OTHER_ACCOUNT: ReiwaSession = { ...LEGACY_SESSION, telegramId: "777000444", userId: 9002 };
const JOIN_URL = "https://t.me/reiwa_news";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
let visibility: DocumentVisibilityState = "visible";

// ── The surface ──────────────────────────────────────────────────────────────

/** A plain browser tab: no launch parameters anywhere, no bridge, no loader flag. */
function openInBrowser(): void {
  window.history.replaceState(null, "", "/dashboard");
}

function launchParameters(): Record<string, string> {
  return {
    tgWebAppData: `query_id=AAE&user=%7B%22id%22%3A777000111%7D&auth_date=${Math.floor(Date.now() / 1000)}&hash=00`,
    tgWebAppVersion: "8.0",
    tgWebAppPlatform: "ios",
  };
}

/** Telegram opened this document: the launch parameters sit in the fragment. */
function openInMiniApp(): void {
  window.history.replaceState(null, "", `/dashboard#${new URLSearchParams(launchParameters()).toString()}`);
}

/**
 * The same Mini App after a reload: the fragment is gone, and only the SDK's
 * session mirror — the store Telegram's own script writes — says Telegram.
 */
function reloadInMiniApp(): void {
  window.history.replaceState(null, "", "/dashboard");
  window.sessionStorage.setItem("__telegram__initParams", JSON.stringify(launchParameters()));
}

interface BridgeStub {
  readonly webApp: TelegramWebApp;
  readonly openTelegramLink: ReturnType<typeof vi.fn>;
  readonly onEvent: ReturnType<typeof vi.fn>;
  readonly offEvent: ReturnType<typeof vi.fn>;
  /** Fires a client event at whatever is subscribed to it right now. */
  emit(eventType: string): void;
}

/** The SDK arrived: `window.Telegram.WebApp`, with a real event registry. */
function installBridge(): BridgeStub {
  const handlers = new Map<string, Set<() => void>>();
  const onEvent = vi.fn((eventType: string, callback: () => void) => {
    const set = handlers.get(eventType) ?? new Set<() => void>();
    set.add(callback);
    handlers.set(eventType, set);
  });
  const offEvent = vi.fn((eventType: string, callback: () => void) => {
    handlers.get(eventType)?.delete(callback);
  });
  const openTelegramLink = vi.fn();
  const webApp = {
    initData: "query_id=AAE&hash=00",
    initDataUnsafe: {},
    version: "8.0",
    platform: "ios",
    isExpanded: true,
    viewportHeight: 800,
    viewportStableHeight: 800,
    close: vi.fn(),
    openLink: vi.fn(),
    openTelegramLink,
    onEvent,
    offEvent,
  } as unknown as TelegramWebApp;
  window.Telegram = { WebApp: webApp };
  return {
    webApp,
    openTelegramLink,
    onEvent,
    offEvent,
    emit: (eventType) => {
      for (const callback of [...(handlers.get(eventType) ?? [])]) callback();
    },
  };
}

// ── The network ──────────────────────────────────────────────────────────────

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function answer(status: string, joinUrl: string | null = JOIN_URL) {
  return { status, joinUrl };
}

/** An axios failure as the transport rejects with it. */
function httpFailure(status: number, data: unknown = {}, headers: Record<string, string> = {}): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST), {
    response: { status, data, headers, statusText: "", config: {} },
  });
}

/** A check that never answers, and fails the way axios does when its signal is aborted. */
function checkThatWaitsForItsSignal({ signal }: { signal?: AbortSignal } = {}): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new AxiosError("canceled", AxiosError.ERR_CANCELED)));
  });
}

// ── Mounting ─────────────────────────────────────────────────────────────────

/** Every account the cabinet has run its effects for, in order. */
const cabinetRanFor: string[] = [];

/**
 * The cabinet as far as this file cares — including the part that matters when
 * the account changes: its effects run, as the real pages' requests would, for
 * whoever the session says is signed in.
 */
function CabinetProbe() {
  const { session } = useSession();
  const account = session?.id ?? session?.telegramId ?? null;
  useEffect(() => {
    if (account !== null) cabinetRanFor.push(account);
  }, [account]);
  return <p data-probe="cabinet">cabinet</p>;
}

/** `/tma` as far as this file cares: exempt, and able to hand over to the cabinet. */
function TmaProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" data-probe="tma" onClick={() => navigate("/dashboard")}>
      signed in, go on
    </button>
  );
}

interface MountOptions {
  readonly path?: string;
  /** Seeded into the session query; `"unread"` leaves `/session` to answer. */
  readonly session?: ReiwaSession | null | "unread";
  /** `main.tsx` renders the app inside `<StrictMode>`. */
  readonly strict?: boolean;
  /**
   * `false` renders a cabinet that reads nothing, for the case that counts
   * `/session` requests — `CabinetProbe` reads the session itself.
   */
  readonly cabinetReadsSession?: boolean;
}

async function mount({
  path = "/dashboard",
  session = SESSION,
  strict = false,
  cabinetReadsSession = true,
}: MountOptions = {}): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient = client;
  if (session !== "unread") client.setQueryData(["session"], session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const tree = (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <ChannelGate fallback={<p data-probe="loader">loading</p>}>
            <Routes>
              <Route
                path="/dashboard"
                element={cabinetReadsSession ? <CabinetProbe /> : <p data-probe="cabinet">cabinet</p>}
              />
              <Route path="/payment-return" element={<p data-probe="payment-return">payment</p>} />
              <Route path="/tma" element={<TmaProbe />} />
            </Routes>
          </ChannelGate>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
  act(() => {
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  await settle();
}

/** Let promises, React Query's notifications and React's commits land. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function signIn(session: ReiwaSession | null): void {
  act(() => {
    queryClient?.setQueryData(["session"], session);
  });
}

// ── Reading the screen ───────────────────────────────────────────────────────

const probe = (name: string): Element | null => container?.querySelector(`[data-probe="${name}"]`) ?? null;
const cabinet = (): Element | null => probe("cabinet");
const loader = (): Element | null => probe("loader");

/** The wall's heading, or null — found by what it says, not by where it is. */
function wallHeading(): HTMLHeadingElement | null {
  const heading = container?.querySelector("h1") ?? null;
  return heading?.textContent === ru.channelGate.title ? heading : null;
}

function buttonLabelled(label: string): HTMLButtonElement | null {
  return (
    [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

const joinButton = (): HTMLButtonElement | null => buttonLabelled(ru.channelGate.join);

function checkButton(): HTMLButtonElement {
  const button = buttonLabelled(ru.channelGate.check);
  if (button === null) throw new Error(`no «${ru.channelGate.check}» button; the page shows: ${container?.textContent}`);
  return button;
}

function statusRegion(): HTMLElement {
  const region = container?.querySelector<HTMLElement>('[role="status"]') ?? null;
  if (region === null) throw new Error("the wall has no live region");
  return region;
}

/** The notice in the live region, or null. */
const notice = (): HTMLElement | null => statusRegion().querySelector<HTMLElement>("[data-notice]");
/** The rate-limit sentence the live region announces, or null. */
const announced = (): HTMLElement | null => statusRegion().querySelector<HTMLElement>("[data-announced]");
/** The ticking rate-limit countdown, wherever it is drawn, or null. */
const countdown = (): HTMLElement | null => container?.querySelector<HTMLElement>("[data-countdown]") ?? null;
const rateLimitedText = (seconds: number): string => ru.channelGate.rateLimited.replace("{{seconds}}", String(seconds));

async function press(button: HTMLButtonElement): Promise<void> {
  act(() => {
    button.click();
  });
  await settle();
}

/** The user comes back to the Mini App, as the Page Visibility API reports it. */
async function returnToDocument(): Promise<void> {
  visibility = "visible";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
}

async function refocusWindow(): Promise<void> {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await settle();
}

async function wallUp(joinUrl: string | null = JOIN_URL): Promise<void> {
  openInMiniApp();
  api.getChannelGate.mockResolvedValue(answer("not-subscribed", joinUrl));
  await mount();
  expect(wallHeading(), "precondition: the wall is on screen").not.toBeNull();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  notifyManager.setScheduler(queueMicrotask);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  api.getSession.mockResolvedValue(SESSION);
  cabinetRanFor.length = 0;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  queryClient?.clear();
  queryClient = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  api.getSession.mockReset();
  api.getChannelGate.mockReset();
  api.checkChannelGate.mockReset();
  delete window.Telegram;
  __resetTelegramWebAppBridgeForTests();
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  window.history.replaceState(null, "", "/");
});

describe("in a plain browser", () => {
  it("renders the cabinet and asks nothing — neither the session nor the gate", async () => {
    openInBrowser();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    // The session is left UNREAD, and the cabinet here reads nothing: a gate that
    // so much as subscribed to the session would put a `/session` request on
    // the wire, and the Mini App case below shows this very mount doing exactly
    // that.
    await mount({ session: "unread", cabinetReadsSession: false });
    await elapse(10_000);

    expect(cabinet(), "the browser cabinet did not render").not.toBeNull();
    expect(loader()).toBeNull();
    expect(wallHeading()).toBeNull();
    expect(api.getSession, "the gate read the session in a plain browser").not.toHaveBeenCalled();
    expect(api.getChannelGate).not.toHaveBeenCalled();
    expect(api.checkChannelGate).not.toHaveBeenCalled();
  });
});

describe("in a Telegram Mini App, the first answer", () => {
  it("replaces the cabinet with the subscribe screen when Telegram says not-subscribed", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount();

    expect(api.getChannelGate).toHaveBeenCalledTimes(1);
    expect(wallHeading(), "the subscribe screen is not on the page").not.toBeNull();
    expect(container?.textContent).toContain(ru.channelGate.body);
    expect(cabinet(), "the cabinet is still in the DOM behind the wall").toBeNull();
    expect(loader()).toBeNull();

    // The answer came in time; the budget running out afterwards changes nothing.
    await elapse(10_000);
    expect(wallHeading(), "the wall came down by itself once the budget had passed").not.toBeNull();
    expect(cabinet()).toBeNull();
  });

  it("runs on a reload that has lost the launch fragment, from the SDK's session mirror", async () => {
    reloadInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount();

    expect(api.getChannelGate, "a reloaded Mini App was taken for a plain browser").toHaveBeenCalledTimes(1);
    expect(wallHeading()).not.toBeNull();
    expect(cabinet()).toBeNull();
  });

  it("asks once under StrictMode, which is how main.tsx mounts the app", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount({ strict: true });

    expect(api.getChannelGate, "StrictMode's rehearsal remount sent the first check twice").toHaveBeenCalledTimes(1);
    expect(wallHeading()).not.toBeNull();
  });

  it.each(["subscribed", "off", "unverified"])("lets the user in on %s", async (status) => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer(status));

    await mount();

    expect(api.getChannelGate).toHaveBeenCalledTimes(1);
    expect(cabinet(), `the cabinet did not render on ${status}`).not.toBeNull();
    expect(wallHeading()).toBeNull();
    expect(loader()).toBeNull();
  });

  it("holds the loader — not the cabinet, not the wall — while the answer is on its way", async () => {
    openInMiniApp();
    const pending = deferred<ReturnType<typeof answer>>();
    api.getChannelGate.mockReturnValue(pending.promise);

    await mount();

    expect(loader(), "no loading state while the gate is undecided").not.toBeNull();
    expect(cabinet(), "the cabinet flashed before the gate had an answer").toBeNull();
    expect(wallHeading()).toBeNull();

    pending.resolve(answer("subscribed"));
    await settle();

    expect(cabinet()).not.toBeNull();
    expect(loader()).toBeNull();
  });

  it("holds the loader while the session itself is still being read, and asks once it is there", async () => {
    openInMiniApp();
    const session = deferred<ReiwaSession | null>();
    api.getSession.mockReturnValue(session.promise);
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount({ session: "unread" });

    expect(api.getSession, "precondition: the session is being read").toHaveBeenCalled();
    expect(loader(), "a gated route rendered before the session was known").not.toBeNull();
    expect(cabinet()).toBeNull();
    expect(api.getChannelGate).not.toHaveBeenCalled();

    session.resolve(SESSION);
    await settle();

    expect(api.getChannelGate).toHaveBeenCalledTimes(1);
    expect(wallHeading()).not.toBeNull();
    expect(cabinet()).toBeNull();
  });

  it("counts its six seconds from the moment the session appears, not from the mount", async () => {
    openInMiniApp();
    const session = deferred<ReiwaSession | null>();
    api.getSession.mockReturnValue(session.promise);
    const pending = deferred<ReturnType<typeof answer>>();
    api.getChannelGate.mockReturnValue(pending.promise);

    await mount({ session: "unread" });
    // A Telegram sign-in that takes longer than the whole budget.
    await elapse(7_000);
    session.resolve(SESSION);
    await settle();
    expect(api.getChannelGate).toHaveBeenCalledTimes(1);

    await elapse(5_999);
    expect(loader(), "a slow sign-in used up the budget before the check was even sent").not.toBeNull();
    expect(cabinet()).toBeNull();

    pending.resolve(answer("not-subscribed"));
    await settle();
    expect(wallHeading(), "the check that came in time was dropped").not.toBeNull();
  });

  it("asks nothing and renders the route when there is no session", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount({ session: null });
    await elapse(10_000);

    expect(api.getChannelGate, "the gate asked about a session that does not exist").not.toHaveBeenCalled();
    expect(cabinet()).not.toBeNull();
    expect(wallHeading()).toBeNull();
  });

  it("opens the cabinet when the answer fails, and leaves the session alone", async () => {
    openInMiniApp();
    api.getChannelGate.mockRejectedValue(httpFailure(502));

    await mount();

    expect(cabinet(), "a failed check kept the user out").not.toBeNull();
    expect(wallHeading()).toBeNull();
    expect(loader()).toBeNull();
    expect(api.getSession, "a 502 is not a lost session").not.toHaveBeenCalled();
  });

  it("opens the cabinet on a 401 too, and refreshes the session so a dead one goes back through sign-in", async () => {
    openInMiniApp();
    api.getChannelGate.mockRejectedValue(httpFailure(401, { message: "Unauthorized" }));

    await mount();

    expect(cabinet()).not.toBeNull();
    expect(api.getSession, "the session was not re-read after the gate's 401").toHaveBeenCalledTimes(1);
  });

  it("asks the same account again when it signs back in after a 401 on the first answer", async () => {
    openInMiniApp();
    api.getChannelGate.mockRejectedValueOnce(httpFailure(401, { message: "Session expired" }));
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));
    // The re-read after the 401 finds the session gone.
    api.getSession.mockResolvedValue(null);

    await mount();
    expect(api.getSession).toHaveBeenCalledTimes(1);

    // `StealthLayout` → `/bootstrap` → a fresh Telegram sign-in, same account.
    signIn(SESSION);
    await settle();

    expect(api.getChannelGate, "the account that signed back in was waved through on the 401").toHaveBeenCalledTimes(2);
    expect(wallHeading()).not.toBeNull();
    expect(cabinet()).toBeNull();
  });

  it("opens the cabinet when no answer comes within six seconds, and keeps it open when a late not-subscribed lands", async () => {
    openInMiniApp();
    const late = deferred<ReturnType<typeof answer>>();
    api.getChannelGate.mockReturnValue(late.promise);

    await mount();
    const signal = (api.getChannelGate.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal, "the first check was sent without a way to abandon it").toBeInstanceOf(AbortSignal);

    await elapse(5_999);
    expect(loader(), "the gate gave up before six seconds").not.toBeNull();
    expect(cabinet()).toBeNull();
    expect(signal?.aborted).toBe(false);

    await elapse(1);
    expect(cabinet(), "no answer in six seconds still kept the user out").not.toBeNull();
    expect(loader()).toBeNull();
    expect(signal?.aborted, "the request nobody waits for any more was left running").toBe(true);

    late.resolve(answer("not-subscribed"));
    await settle();

    expect(wallHeading(), "a late answer threw the wall over a cabinet already in use").toBeNull();
    expect(cabinet()).not.toBeNull();
  });

  it("moves focus to the screen's heading when it appears, and names the screen by it", async () => {
    await wallUp();

    const heading = wallHeading();
    expect(document.activeElement, "focus did not land on the heading").toBe(heading);
    const landmark = container?.querySelector("main");
    expect(landmark?.getAttribute("aria-labelledby"), "the screen is not labelled by its heading").toBe(heading?.id);
    expect(heading?.id.length).toBeGreaterThan(0);
  });
});

describe("the verdict belongs to an account", () => {
  it("tells two panel accounts apart by their id — the panel's session carries no userId", async () => {
    expect("userId" in PANEL_SESSION_WIRE, "precondition: the fixture is the panel's wire shape").toBe(false);
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.getChannelGate.mockResolvedValueOnce(answer("subscribed"));
    await mount();
    expect(cabinet()).not.toBeNull();

    signIn(OTHER_ACCOUNT);
    await settle();

    expect(api.getChannelGate, "another account walked in on the first one's verdict").toHaveBeenCalledTimes(2);
    expect(wallHeading()).not.toBeNull();
    expect(cabinet()).toBeNull();

    // The same account signing back in — after its session died — keeps its verdict.
    signIn(null);
    await settle();
    signIn({ ...OTHER_ACCOUNT });
    await settle();

    expect(api.getChannelGate, "the same account was asked again on signing back in").toHaveBeenCalledTimes(2);
    expect(wallHeading()).not.toBeNull();
  });

  it("tells two legacy sessions apart by their Telegram id when there is no panel id", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.getChannelGate.mockResolvedValueOnce(answer("subscribed"));
    await mount({ session: LEGACY_SESSION });
    expect(cabinet()).not.toBeNull();

    signIn(LEGACY_OTHER_ACCOUNT);
    await settle();

    expect(api.getChannelGate, "two legacy sessions were taken for one account").toHaveBeenCalledTimes(2);
    expect(wallHeading()).not.toBeNull();
  });

  it("does not let the cabinet run for a newly signed-in account before that account is checked", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.getChannelGate.mockResolvedValueOnce(answer("subscribed"));
    await mount();
    expect(cabinetRanFor, "precondition: the first account is in").toEqual([PANEL_SESSION_WIRE.id]);

    const second = deferred<ReturnType<typeof answer>>();
    api.getChannelGate.mockReturnValueOnce(second.promise);
    signIn(OTHER_ACCOUNT);
    await settle();

    expect(cabinetRanFor, "the cabinet ran for the new account on the previous account's verdict").toEqual([
      PANEL_SESSION_WIRE.id,
    ]);
    expect(loader()).not.toBeNull();

    second.resolve(answer("subscribed"));
    await settle();
    expect(cabinetRanFor).toEqual([PANEL_SESSION_WIRE.id, OTHER_ACCOUNT.id]);
  });

  it("does not let a check still out for the previous account stand in for the next account's press", async () => {
    await wallUp();
    const previous = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValueOnce(previous.promise).mockResolvedValue(answer("not-subscribed"));
    await press(checkButton());

    signIn(OTHER_ACCOUNT);
    await settle();
    expect(wallHeading(), "precondition: the next account is walled too").not.toBeNull();

    await press(checkButton());
    expect(api.checkChannelGate, "the next account's press was swallowed by the previous account's check").toHaveBeenCalledTimes(2);
  });

  it("does not let a 429 that lands for the previous account hold the next one back", async () => {
    await wallUp();
    const previous = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValueOnce(previous.promise).mockResolvedValue(answer("not-subscribed"));
    await press(checkButton());

    signIn(OTHER_ACCOUNT);
    await settle();
    previous.reject(httpFailure(429, { retryAfter: 60 }));
    await settle();

    await press(checkButton());
    expect(api.checkChannelGate, "the previous account's 429 held the next account back").toHaveBeenCalledTimes(2);
  });

  it("drops an answer that arrives for the account signed in before", async () => {
    openInMiniApp();
    const first = deferred<ReturnType<typeof answer>>();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.getChannelGate.mockReturnValueOnce(first.promise).mockResolvedValueOnce(answer("not-subscribed"));
    await mount();

    signIn(OTHER_ACCOUNT);
    await settle();
    expect(wallHeading()).not.toBeNull();

    first.resolve(answer("subscribed"));
    await settle();

    expect(wallHeading(), "the previous account's answer opened the cabinet for this one").not.toBeNull();
    expect(cabinet()).toBeNull();
  });

  it("does not land an account's first answer on its second ask after a quick A → B → A", async () => {
    openInMiniApp();
    const firstAskA = deferred<ReturnType<typeof answer>>();
    const askB = deferred<ReturnType<typeof answer>>();
    const secondAskA = deferred<ReturnType<typeof answer>>();
    api.getChannelGate
      .mockReturnValueOnce(firstAskA.promise)
      .mockReturnValueOnce(askB.promise)
      .mockReturnValueOnce(secondAskA.promise);
    await mount();
    signIn(OTHER_ACCOUNT);
    await settle();
    signIn(SESSION);
    await settle();
    expect(api.getChannelGate, "precondition: A was asked a second time").toHaveBeenCalledTimes(3);

    firstAskA.resolve(answer("subscribed"));
    await settle();
    expect(cabinet(), "A's first answer was taken for its second ask").toBeNull();
    expect(loader()).not.toBeNull();

    secondAskA.resolve(answer("not-subscribed"));
    await settle();
    expect(wallHeading()).not.toBeNull();
  });
});

describe("«✅ Я подписался»", () => {
  it.each(["subscribed", "off", "unverified"])(
    "asks Telegram again and opens the cabinet on %s",
    async (status) => {
      await wallUp();
      api.checkChannelGate.mockResolvedValue(answer(status));

      await press(checkButton());

      expect(api.checkChannelGate).toHaveBeenCalledTimes(1);
      expect(cabinet(), `the cabinet did not open on ${status}`).not.toBeNull();
      expect(wallHeading()).toBeNull();
    },
  );

  it("is busy and unavailable while its check is out, keeps keyboard focus, and a second press sends nothing", async () => {
    await wallUp();
    const pending = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValue(pending.promise);
    const button = checkButton();
    act(() => button.focus());

    await press(button);

    const busy = checkButton();
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled"), "the button stayed available during its own check").toBe("true");
    // jsdom has no focus fixup, so a natively disabled button would keep focus
    // HERE while Chromium drops it to <body>. The attribute is the defect.
    expect(busy.hasAttribute("disabled"), "a native `disabled` drops keyboard focus in Chromium webviews").toBe(false);
    expect(document.activeElement, "focus left the button that was pressed").toBe(busy);
    // `disabled:` styles never apply to a button that is not disabled.
    expect(busy.className, "an unavailable button would look exactly like an available one").toContain(
      "aria-disabled:opacity-40",
    );
    expect(statusRegion().textContent).toBe(ru.channelGate.checking);

    await press(busy);
    expect(api.checkChannelGate, "a second press sent a second check").toHaveBeenCalledTimes(1);

    pending.resolve(answer("not-subscribed"));
    await settle();

    const idle = checkButton();
    expect(idle.getAttribute("aria-disabled")).toBe("false");
    expect(idle.getAttribute("aria-busy")).toBe("false");
    expect(document.activeElement, "focus was taken back to the heading on a redraw").toBe(idle);
  });

  it("gives the check a signal, and gives up on it after ten seconds with the failure text", async () => {
    await wallUp();
    api.checkChannelGate.mockImplementation(checkThatWaitsForItsSignal);

    await press(checkButton());
    const signal = (api.checkChannelGate.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal, "the check was sent without a way to abandon it").toBeInstanceOf(AbortSignal);

    await elapse(9_999);
    expect(checkButton().getAttribute("aria-busy"), "the check was given up early").toBe("true");

    await elapse(1);
    expect(signal?.aborted, "a check nobody waits for was left running").toBe(true);
    expect(checkButton().getAttribute("aria-busy"), "the button kept spinning past its budget").toBe("false");
    expect(notice()?.textContent).toBe(ru.channelGate.checkFailed);
  });

  it("keeps the wall and says «❌ Вы ещё не подписаны…» when Telegram still says not-subscribed", async () => {
    const bridge = installBridge();
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed", "https://t.me/+moved_invite"));

    await press(checkButton());

    expect(wallHeading()).not.toBeNull();
    expect(cabinet()).toBeNull();
    expect(statusRegion().textContent).toBe(ru.channelGate.notSubscribed);
    expect(checkButton().getAttribute("aria-disabled")).toBe("false");

    // The operator moved the channel while the user sat here: the button
    // follows the link the check came back with.
    const join = joinButton();
    expect(join).not.toBeNull();
    act(() => join?.click());
    expect(bridge.openTelegramLink).toHaveBeenLastCalledWith("https://t.me/+moved_invite");
  });

  it.each([
    ["a 500", () => httpFailure(500)],
    ["a dropped connection", () => new AxiosError("Network Error", AxiosError.ERR_NETWORK)],
  ])("keeps the wall and says «Не удалось проверить подписку…» on %s", async (_label, failure) => {
    await wallUp();
    api.checkChannelGate.mockRejectedValue(failure());

    await press(checkButton());

    expect(wallHeading()).not.toBeNull();
    expect(cabinet()).toBeNull();
    expect(statusRegion().textContent).toBe(ru.channelGate.checkFailed);
    expect(checkButton().getAttribute("aria-disabled")).toBe("false");
    expect(api.getSession, "a failure that is not a 401 re-read the session").not.toHaveBeenCalled();
  });

  it("keeps the wall on a 401 while the session still stands, and re-reads it without a loader over the wall", async () => {
    await wallUp();
    api.checkChannelGate.mockRejectedValue(httpFailure(401, { message: "Unauthorized" }));
    const reread = deferred<ReiwaSession | null>();
    api.getSession.mockReturnValue(reread.promise);

    await press(checkButton());

    expect(api.getSession, "a 401 on the re-check did not re-read the session").toHaveBeenCalledTimes(1);
    // The re-read is out: the session the app already has stays in force while
    // it is, so nothing is swapped for the loader.
    expect(loader(), "the session was thrown away while it was being re-read").toBeNull();
    expect(wallHeading(), "a failed re-check took the wall down").not.toBeNull();

    reread.resolve(SESSION);
    await settle();
    expect(wallHeading()).not.toBeNull();
    expect(statusRegion().textContent).toBe(ru.channelGate.checkFailed);
  });

  it("hands a session that really died back to the app's own sign-in on a 401, instead of repeating the failure", async () => {
    await wallUp();
    api.checkChannelGate.mockRejectedValue(httpFailure(401, { message: "Session expired" }));
    api.getSession.mockResolvedValue(null);

    await press(checkButton());

    // With no session the gate steps aside; in the app `StealthLayout` then
    // sends the Mini App to `/bootstrap` for a fresh Telegram sign-in.
    expect(wallHeading(), "the wall stayed over a session that is gone").toBeNull();
    expect(cabinet()).not.toBeNull();
  });

  it("holds the button back for the retryAfter a 429 names, says it once, and counts down outside the live region", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { message: "Too many requests", retryAfter: 42 }));

    await press(checkButton());

    expect(announced()?.textContent).toBe(rateLimitedText(42));
    expect(countdown()?.textContent).toBe(rateLimitedText(42));
    // A ticking node inside a live region — hidden or not — is one a screen
    // reader may read out every second.
    expect(statusRegion().contains(countdown()), "the ticking countdown sits inside the live region").toBe(false);
    expect(countdown()?.getAttribute("aria-hidden")).toBe("true");
    expect(checkButton().getAttribute("aria-disabled")).toBe("true");

    await press(checkButton());
    expect(api.checkChannelGate, "a press during the hold sent a check").toHaveBeenCalledTimes(1);

    // Second by second, not one advance of thirty: inside a single batch an
    // unrelated redraw — the bridge waiter's twenty-second ceiling — renders
    // only once the batch is over, when the clock already reads thirty, and
    // paints the right number for a countdown that does not count.
    for (let second = 1; second <= 30; second += 1) await elapse(1_000);
    expect(countdown()?.textContent, "the countdown did not count").toBe(rateLimitedText(12));

    await elapse(11_999);
    expect(checkButton().getAttribute("aria-disabled"), "the hold ended early").toBe("true");

    await elapse(1);
    expect(checkButton().getAttribute("aria-disabled"), "the hold never ended").toBe("false");
    expect(countdown(), "the countdown outlived the hold").toBeNull();
    expect(announced(), "the rate-limit sentence outlived the hold").toBeNull();

    await press(checkButton());
    expect(api.checkChannelGate).toHaveBeenCalledTimes(2);
  });

  it("does not change the sentence it announced while the countdown ticks", async () => {
    await wallUp();
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { retryAfter: 42 }));
    await press(checkButton());
    const sentence = announced();

    await elapse(5_000);

    expect(announced(), "the announced sentence was replaced while nobody pressed").toBe(sentence);
    expect(announced()?.textContent).toBe(rateLimitedText(42));
    expect(countdown()?.textContent).toBe(rateLimitedText(37));
  });

  it("takes the wait from the Retry-After header when the body names none", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, "Too Many Requests", { "retry-after": "37" }));

    await press(checkButton());

    expect(countdown()?.textContent).toBe(rateLimitedText(37));
    await elapse(36_999);
    expect(checkButton().getAttribute("aria-disabled")).toBe("true");
    await elapse(1);
    expect(checkButton().getAttribute("aria-disabled")).toBe("false");
  });

  it("finds the hold over by the wall clock after the phone slept through it, and never counts below zero", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { retryAfter: 60 }));
    await press(checkButton());
    expect(countdown()?.textContent).toBe(rateLimitedText(60));

    // Two minutes asleep: the wall clock moves, and not one timer fires.
    vi.setSystemTime(Date.now() + 120_000);
    // Something redraws the screen before any tick does — the session query
    // bringing a changed field back. A deep-equal copy would not do it: React
    // Query shares the old object and nothing redraws.
    const pointsCredited = { ...PANEL_SESSION_WIRE, points: 121 };
    signIn(pointsCredited);
    await act(async () => {
      await Promise.resolve();
    });
    expect(countdown()?.textContent, "the countdown went below zero").toBe(rateLimitedText(0));

    // Coming back to the Mini App finds the hold over — no timer has had to fire.
    await returnToDocument();
    expect(checkButton().getAttribute("aria-disabled"), "the slept-through hold still shut the button").toBe("false");
    expect(countdown()).toBeNull();
  });

  it("ends a slept-through hold on its next tick", async () => {
    await wallUp();
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { retryAfter: 60 }));
    await press(checkButton());

    vi.setSystemTime(Date.now() + 120_000);
    await elapse(1_000);

    expect(checkButton().getAttribute("aria-disabled"), "the first tick after the sleep left the hold on").toBe("false");
    expect(countdown()).toBeNull();
  });

  it("sends the check when a press lands after the hold's end, before any tick has noticed", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { retryAfter: 20 }));
    await press(checkButton());

    vi.setSystemTime(Date.now() + 20_000);
    await press(checkButton());

    expect(api.checkChannelGate, "a press after the end of the hold was still held back").toHaveBeenCalledTimes(2);
    expect(countdown()).toBeNull();
    expect(statusRegion().textContent).toBe(ru.channelGate.notSubscribed);
  });

  it("puts «Проверяем подписку…» in place of the previous result while a new press is checked, then the new result", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValueOnce(answer("not-subscribed"));
    await press(checkButton());
    expect(statusRegion().textContent).toBe(ru.channelGate.notSubscribed);

    const pending = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValueOnce(pending.promise);
    await press(checkButton());

    expect(statusRegion().textContent).toBe(ru.channelGate.checking);
    pending.reject(httpFailure(500));
    await settle();
    expect(statusRegion().textContent).toBe(ru.channelGate.checkFailed);
  });

  it.each([
    ["not-subscribed", () => answer("not-subscribed")],
    ["failed", () => Promise.reject(httpFailure(500))],
    ["rate-limited", () => Promise.reject(httpFailure(429, { retryAfter: 30 }))],
  ])("draws the %s result in the theme's foreground, not in a fixed red or amber", async (kind, reply) => {
    await wallUp();
    api.checkChannelGate.mockImplementation(async () => reply());

    await press(checkButton());

    const shown = container?.querySelector<HTMLElement>(`[data-notice="${kind}"]`) ?? null;
    expect(shown, `no ${kind} result on screen`).not.toBeNull();
    expect(shown?.className, "the result is not drawn in the theme's foreground").toContain(
      "text-[color:var(--brand-foreground)]",
    );
    expect(shown?.className, "a palette text colour is unreadable on a light theme").not.toMatch(/\btext-(red|amber)-\d/);
  });

  it("keeps room for the tallest result under the buttons, so the pressed button does not move", async () => {
    await wallUp();
    const room = container?.querySelector("[data-result-room]");

    // Four lines of the result's own text, plus the frame's `py-3` and its two
    // 1px borders: the failure sentence is three lines at 320px, four in a
    // wider brand font. `min-h-18` (72px) was a line and a half short.
    expect(CHANNEL_GATE_RESULT_ROOM).toBe("min-h-[calc(4lh+1.5rem+2px)]");
    expect(room?.className, "the result area keeps no room of its own").toContain(CHANNEL_GATE_RESULT_ROOM);
    expect(room?.contains(statusRegion())).toBe(true);
  });
});

describe("«📢 Перейти в канал»", () => {
  it("opens the link through the Telegram bridge, inside the tap", async () => {
    const bridge = installBridge();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await wallUp();

    const join = joinButton();
    expect(join, "no join button although the answer carried a link").not.toBeNull();
    act(() => join?.click());

    expect(bridge.openTelegramLink).toHaveBeenCalledTimes(1);
    expect(bridge.openTelegramLink).toHaveBeenCalledWith(JOIN_URL);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the link in a new window when the SDK never arrived", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await wallUp();

    act(() => joinButton()?.click());

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(JOIN_URL, "_blank", "noopener,noreferrer");
  });

  it("is not offered when the answer carries no link, and the check button still is", async () => {
    await wallUp(null);

    expect(joinButton(), "a join button with nothing to open").toBeNull();
    expect(checkButton()).not.toBeNull();
  });
});

describe("coming back to the Mini App while the screen is up", () => {
  it("asks at most once in twenty seconds however often the document flaps, and again after", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));

    await returnToDocument();
    expect(api.checkChannelGate, "a return to the Mini App did not re-check").toHaveBeenCalledTimes(1);

    for (let flap = 0; flap < 5; flap += 1) {
      visibility = "hidden";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await elapse(1_000);
      await returnToDocument();
    }
    expect(api.checkChannelGate, "visibility flapping spammed the check").toHaveBeenCalledTimes(1);

    await elapse(14_999);
    await returnToDocument();
    expect(api.checkChannelGate, "a return 19 999 ms after the last check was let through").toHaveBeenCalledTimes(1);

    await elapse(1);
    await returnToDocument();
    expect(api.checkChannelGate, "the throttle never reopened").toHaveBeenCalledTimes(2);
  });

  it("sends no automatic check within ten seconds of a press", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    await press(checkButton());

    await elapse(9_999);
    await refocusWindow();
    expect(api.checkChannelGate, "a focus right after a press spent a second check").toHaveBeenCalledTimes(1);

    await elapse(1);
    await refocusWindow();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(2);
  });

  it("counts the window regaining focus as a return — Telegram Desktop keeps it visible while the channel opens", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("subscribed"));

    await refocusWindow();

    expect(api.checkChannelGate, "coming back to the window did not re-check").toHaveBeenCalledTimes(1);
    expect(cabinet()).not.toBeNull();
  });

  it("does not count something inside the screen taking focus as a return", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));

    act(() => checkButton().focus());
    act(() => joinButton()?.focus());
    act(() => wallHeading()?.focus());
    await settle();

    expect(api.checkChannelGate, "a keyboard user tabbing through the screen set off a check").not.toHaveBeenCalled();
  });

  it("counts the bridge's activated event as a return, and stops listening to it once the user is in", async () => {
    const bridge = installBridge();
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("subscribed"));

    expect(bridge.onEvent).toHaveBeenCalledWith("activated", expect.any(Function));
    const handler = bridge.onEvent.mock.calls.find(([eventType]) => eventType === "activated")?.[1];

    act(() => bridge.emit("activated"));
    await settle();

    expect(api.checkChannelGate, "the Mini App becoming active again did not re-check").toHaveBeenCalledTimes(1);
    expect(cabinet()).not.toBeNull();
    expect(bridge.offEvent, "the activated handler was left subscribed").toHaveBeenCalledWith("activated", handler);
  });

  it("subscribes to activated when the bridge arrives after the screen is already up", async () => {
    // The SDK comes from telegram.org, which this product's customers often
    // cannot reach quickly: the screen is up first, the bridge later.
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    const bridge = installBridge();
    await elapse(100);

    expect(bridge.onEvent, "a bridge that arrived late was never listened to").toHaveBeenCalledWith(
      "activated",
      expect.any(Function),
    );
    act(() => bridge.emit("activated"));
    await settle();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(1);
  });

  it("shares one twenty-second window across every kind of return", async () => {
    const bridge = installBridge();
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));

    await refocusWindow();
    await elapse(2_000);
    act(() => bridge.emit("activated"));
    await settle();
    await elapse(2_000);
    await returnToDocument();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await settle();

    expect(api.checkChannelGate, "one return per signal, not one per window").toHaveBeenCalledTimes(1);

    await elapse(16_000);
    await refocusWindow();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(2);
  });

  it("keeps working when the bridge refuses the subscription", async () => {
    const bridge = installBridge();
    bridge.onEvent.mockImplementation(() => {
      throw new Error("WebAppMethodUnsupported");
    });
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));

    await refocusWindow();

    expect(wallHeading(), "a bridge that threw took the screen down").not.toBeNull();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(1);
  });

  it("lets the user in when the bridge refuses to unsubscribe", async () => {
    const bridge = installBridge();
    bridge.offEvent.mockImplementation(() => {
      throw new Error("WebAppMethodUnsupported");
    });
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("subscribed"));

    await press(checkButton());

    expect(cabinet(), "a bridge that threw on the way out took the cabinet down").not.toBeNull();
  });

  it("opens the cabinet when the check it makes says subscribed", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("subscribed"));

    await returnToDocument();

    expect(cabinet(), "the user joined, came back, and was still walled").not.toBeNull();
    expect(wallHeading()).toBeNull();
  });

  it("writes nothing to the live region — not «Проверяем подписку…», not a result", async () => {
    await wallUp();
    const automatic = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValueOnce(automatic.promise);

    await returnToDocument();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(1);
    expect(statusRegion().textContent, "the automatic check announced itself").toBe("");
    expect(checkButton().getAttribute("aria-busy"), "the automatic check showed as the user's").toBe("false");

    automatic.resolve(answer("not-subscribed"));
    await settle();
    expect(statusRegion().textContent, "an automatic check spoke as if the user had pressed").toBe("");

    await elapse(20_000);
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(500));
    await returnToDocument();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(2);
    expect(statusRegion().textContent, "an automatic check reported its own failure").toBe("");
    expect(wallHeading()).not.toBeNull();
  });

  it("leaves a press's result where it is — not replaced, not repeated — while an automatic check runs", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValueOnce(answer("not-subscribed"));
    await press(checkButton());
    const result = notice();
    expect(result?.textContent).toBe(ru.channelGate.notSubscribed);

    await elapse(10_000);
    const automatic = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValueOnce(automatic.promise);
    await returnToDocument();
    expect(api.checkChannelGate).toHaveBeenCalledTimes(2);
    expect(notice(), "the automatic check took the press's result off the screen").toBe(result);

    automatic.resolve(answer("not-subscribed"));
    await settle();
    // The same node: a result put back would be a result announced twice.
    expect(notice(), "the press's result was put up again and announced a second time").toBe(result);
    expect(notice()?.textContent).toBe(ru.channelGate.notSubscribed);
  });

  it("quietly clears a press's failure once an automatic check has had an answer", async () => {
    await wallUp();
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(500));
    await press(checkButton());
    expect(notice()?.textContent).toBe(ru.channelGate.checkFailed);

    await elapse(10_000);
    api.checkChannelGate.mockResolvedValueOnce(answer("not-subscribed"));
    await returnToDocument();

    expect(statusRegion().textContent, "a check that worked left «could not check» on screen").toBe("");
  });

  it("makes the automatic check the user's when they press during it, and then speaks its answer", async () => {
    await wallUp();
    const automatic = deferred<ReturnType<typeof answer>>();
    api.checkChannelGate.mockReturnValueOnce(automatic.promise);

    await returnToDocument();
    expect(checkButton().getAttribute("aria-disabled"), "the automatic check shut the button").toBe("false");

    await press(checkButton());
    expect(api.checkChannelGate, "the press sent a second check on top of the automatic one").toHaveBeenCalledTimes(1);
    expect(checkButton().getAttribute("aria-disabled")).toBe("true");
    expect(checkButton().getAttribute("aria-busy")).toBe("true");

    automatic.resolve(answer("not-subscribed"));
    await settle();

    expect(statusRegion().textContent, "the press was lost: its answer was not spoken").toBe(ru.channelGate.notSubscribed);
  });

  it("gives a taken-over check a whole budget of its own, not what the automatic one had left", async () => {
    await wallUp();
    api.checkChannelGate.mockImplementation(checkThatWaitsForItsSignal);
    await returnToDocument();

    await elapse(9_500);
    await press(checkButton());

    await elapse(9_999);
    expect(checkButton().getAttribute("aria-busy"), "the taken-over check was given up on the automatic one's clock").toBe(
      "true",
    );

    await elapse(1);
    expect(statusRegion().textContent).toBe(ru.channelGate.checkFailed);
  });

  it("counts a back/forward-cache restore as a return, but not going hidden and not the load's own pageshow", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));

    // The load's own pageshow, landing while the document is VISIBLE — so only
    // `persisted` can tell it from a return, and not the visibility state.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    });
    await settle();
    expect(api.checkChannelGate, "the page's own first pageshow triggered a check").not.toHaveBeenCalled();

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(api.checkChannelGate, "going hidden triggered a check").not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await settle();
    expect(api.checkChannelGate, "a restore from the back/forward cache was not a return").toHaveBeenCalledTimes(1);
  });

  it("sends nothing more while a press is already being checked, and does not use up the window by it", async () => {
    await wallUp();
    const pending = deferred<ReturnType<typeof answer>>();
    // A real answer for any check past the first, so a check that should not
    // have gone out fails the count below instead of tripping over an empty stub.
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockReturnValueOnce(pending.promise);

    await press(checkButton());
    await returnToDocument();

    expect(api.checkChannelGate, "a return doubled a check already in flight").toHaveBeenCalledTimes(1);

    pending.resolve(answer("not-subscribed"));
    await settle();
    // Past the quiet after the press, and well inside the twenty seconds a
    // swallowed return would have started.
    await elapse(10_000);
    await returnToDocument();

    expect(
      api.checkChannelGate,
      "the return that sent nothing still started the twenty-second window, so the next return was swallowed",
    ).toHaveBeenCalledTimes(2);
  });

  it("sends no second check when the user comes back to a press still out after the phone slept", async () => {
    // Asleep, the check's budget timer does not fire and the request stalls.
    // By the wall clock the quiet after the press and the twenty-second gap
    // have both run out, so the only thing between this return and a second
    // request for the same answer is knowing a check is still out.
    await wallUp();
    api.checkChannelGate.mockReturnValue(deferred<ReturnType<typeof answer>>().promise);
    await press(checkButton());
    expect(api.checkChannelGate).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 60_000);
    await returnToDocument();
    await refocusWindow();

    expect(api.checkChannelGate, "a return sent a second check while the press was still out").toHaveBeenCalledTimes(1);
    expect(checkButton().getAttribute("aria-busy"), "the press's own check stopped showing").toBe("true");
  });

  it("sends nothing on a return while checks are held back after a 429, and does not use up the window by it", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { retryAfter: 20 }));
    await press(checkButton());

    await elapse(15_000);
    await refocusWindow();
    expect(api.checkChannelGate, "a return during the hold sent a check").toHaveBeenCalledTimes(1);

    await elapse(5_000);
    await refocusWindow();
    expect(api.checkChannelGate, "the return swallowed by the hold used up the window").toHaveBeenCalledTimes(2);
  });

  it("after an automatic check's 429 the button still looks pressable, and a press is told how long is left", async () => {
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockRejectedValueOnce(httpFailure(429, { retryAfter: 30 }));

    await refocusWindow();
    expect(statusRegion().textContent).toBe("");
    expect(checkButton().getAttribute("aria-disabled")).toBe("false");

    await elapse(10_000);
    await press(checkButton());

    expect(api.checkChannelGate, "the press sent a check into the hold").toHaveBeenCalledTimes(1);
    // Twenty, both copies: ten of the thirty seconds went by before the press.
    expect(announced()?.textContent).toBe(rateLimitedText(20));
    expect(countdown()?.textContent).toBe(rateLimitedText(20));
    expect(checkButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("takes down every listener it put up once the user is in", async () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    await wallUp();
    api.checkChannelGate.mockResolvedValue(answer("subscribed"));
    await press(checkButton());
    expect(cabinet()).not.toBeNull();

    const listeners = (spy: typeof windowAdd, type: string) =>
      spy.mock.calls.filter(([eventType]) => eventType === type).map(([, listener]) => listener);
    for (const [label, add, remove, type] of [
      ["window focus", windowAdd, windowRemove, "focus"],
      ["window pageshow", windowAdd, windowRemove, "pageshow"],
      ["document visibilitychange", documentAdd, documentRemove, "visibilitychange"],
    ] as const) {
      const added = listeners(add, type);
      expect(added.length, `precondition: the screen listened to ${label}`).toBeGreaterThan(0);
      for (const listener of added) {
        expect(listeners(remove, type), `a ${label} listener outlived the screen`).toContain(listener);
      }
    }

    // And nothing that is still listening asks.
    await elapse(20_000);
    await returnToDocument();
    await refocusWindow();
    expect(api.checkChannelGate, "the gate kept checking behind an open cabinet").toHaveBeenCalledTimes(1);
  });
});

// The full exempt/gated split, through the real router, is
// `channel-gate-app-routes.test.tsx`; this is the gate's own half of it.
describe("routes the wall does not cover", () => {
  it("renders an exempt route whatever the answer, and still asks", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount({ path: "/payment-return" });

    expect(probe("payment-return"), "a buyer back from the payment provider was walled").not.toBeNull();
    expect(wallHeading()).toBeNull();
    // The check still ran, so the cabinet is walled the moment they leave.
    expect(api.getChannelGate).toHaveBeenCalledTimes(1);
  });

  it("keeps /tma on screen while the session is still being read, so its own sign-in is not swapped for a loader", async () => {
    openInMiniApp();
    api.getSession.mockReturnValue(deferred<ReiwaSession | null>().promise);

    await mount({ path: "/tma", session: "unread" });

    expect(probe("tma"), "the sign-in handshake was replaced mid-flight").not.toBeNull();
    expect(loader()).toBeNull();
  });

  it("brings the wall down over the cabinet when /tma hands over to it inside the router", async () => {
    openInMiniApp();
    const session = deferred<ReiwaSession | null>();
    api.getSession.mockReturnValue(session.promise);
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount({ path: "/tma", session: "unread" });
    session.resolve(SESSION);
    await settle();
    expect(probe("tma"), "precondition: the exempt route is still showing").not.toBeNull();

    const handOver = probe("tma") as HTMLButtonElement;
    act(() => handOver.click());
    await settle();

    expect(wallHeading(), "the exemption decided on /tma was carried onto /dashboard").not.toBeNull();
    expect(cabinet()).toBeNull();
  });

  it("does not re-check on a return while an exempt route, not the screen, is on display", async () => {
    openInMiniApp();
    api.getChannelGate.mockResolvedValue(answer("not-subscribed"));
    api.checkChannelGate.mockResolvedValue(answer("not-subscribed"));

    await mount({ path: "/payment-return" });
    await returnToDocument();
    await refocusWindow();

    expect(probe("payment-return")).not.toBeNull();
    expect(api.checkChannelGate, "a return behind an exempt route asked Telegram for a screen nobody sees").not.toHaveBeenCalled();
  });
});

describe("the words", () => {
  it("are the same set of keys in Russian and English, all filled in and none left untranslated", () => {
    const ruKeys = Object.keys(ru.channelGate).sort();
    expect(ruKeys.length).toBeGreaterThan(0);
    expect(Object.keys(en.channelGate).sort()).toEqual(ruKeys);
    for (const key of ruKeys) {
      const russian = ru.channelGate[key as keyof typeof ru.channelGate];
      const english = en.channelGate[key as keyof typeof en.channelGate];
      expect(russian.trim().length, `ru.channelGate.${key} is empty`).toBeGreaterThan(0);
      expect(english.trim().length, `en.channelGate.${key} is empty`).toBeGreaterThan(0);
      expect(english, `en.channelGate.${key} is the Russian text`).not.toBe(russian);
    }
  });

  it("carry the owner's Russian wording exactly", () => {
    expect(ru.channelGate).toMatchObject({
      title: "Подпишитесь на канал",
      body: "Чтобы пользоваться сервисом, подпишитесь на наш канал, затем нажмите «Я подписался».",
      join: "📢 Перейти в канал",
      check: "✅ Я подписался",
      notSubscribed: "❌ Вы ещё не подписаны на канал. Подпишитесь и попробуйте снова.",
      checkFailed: "Не удалось проверить подписку. Попробуйте ещё раз через пару секунд.",
    });
  });

  it("name the wait in both languages, so the rate-limit text can say how long", () => {
    expect(ru.channelGate.rateLimited).toContain("{{seconds}}");
    expect(en.channelGate.rateLimited).toContain("{{seconds}}");
  });
});

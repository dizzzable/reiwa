// @vitest-environment jsdom

/**
 * «Вывести средства» on the partner page — rendered, in Russian, with the app's
 * own dictionaries, sheets and readers. Only the network functions are
 * replaced; the panel's answers are shaped as the panel and the cabinet send
 * them: a created request, a coded 409 or 422, the hold's 400 with its code, a
 * 401 — and, from a panel from before the codes, a 2xx `{ error }` or a bare 400.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The button had no `onClick`. `createWithdrawal` existed and nothing called
 * it, so no partner could take money out of the cabinet — and the bot sends
 * them here for it. Nor did the page say anything about the hold on the balance
 * after a password recovery, which the purchase and renewal pages already did.
 *
 * ── What the panel really takes ─────────────────────────────────────────────
 *
 * Read from `InternalPartnerController.withdraw` and
 * `PartnersService.createWithdrawalRequest`: a positive whole number of minor
 * units, at most the balance and at least the operator's minimum (none on a
 * panel from before it was enforced); free-text method and requisites; no "one
 * pending request at a time". The amount leaves the balance at once; an
 * operator pays by hand, or rejects and the amount returns.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPartnerInfo: vi.fn(),
  getPartnerEarnings: vi.fn(),
  getPartnerWithdrawals: vi.fn(),
  createWithdrawal: vi.fn(),
  // «Партнёрка» builds its share links through `useShareLinks`, which reads
  // the referral summary (and, under «только по приглашениям», the invite).
  // Plain functions, so a mock reset between cases cannot empty them.
  getReferralSummary: vi.fn(),
  createReferralInvite: vi.fn(),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  const strip = (props: Record<string, unknown>): Record<string, unknown> => {
    const { whileTap, whileHover, initial, animate, exit, transition, layout, ...rest } = props;
    return rest;
  };
  return {
    motion: new Proxy(
      {},
      { get: (_target, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) },
    ),
    AnimatePresence: ({ children }: { children?: unknown }) => children,
  };
});
vi.mock("@/hooks/use-session", () => ({
  useSession: () => ({ session: { id: "reiwa-id-1" }, isLoading: false, isAuthenticated: true }),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa" }, botUsername: "reiwa_test_bot" }),
}));
// Each pulls its own queries in; this file is about the money.
vi.mock("../src/features/referrals/components/invite-link-hero", () => ({ InviteLinkHero: () => null }));
vi.mock("../src/features/partner/components/partner-referrals-list", () => ({ PartnerReferralsList: () => null }));
vi.mock("../src/features/partner/components/partner-advertising-section", () => ({
  PartnerAdvertisingSection: () => null,
}));

import { i18n } from "@/i18n/i18n";
import { formatHoldEnd } from "@/lib/partner-balance-hold";
import PartnerPage from "../src/features/partner/partner-page";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Relative: the hold must still be standing whenever this runs. */
const HOLD_UNTIL = new Date(Date.now() + 2 * DAY_MS).toISOString();
const HOLD_CODE = "WITHDRAWAL_HOLD_AFTER_RECOVERY";

const REQUISITES = "2200 1234 5678 9012, Т-Банк";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function partnerInfo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "partner-1",
    isActive: true,
    balance: 50_000,
    totalEarned: 90_000,
    totalWithdrawn: 40_000,
    programAvailable: true,
    balancePaymentEnabled: true,
    balanceCurrency: "RUB",
    balanceHold: null,
    referralPoints: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** A request as the panel returns it from `POST …/partner/withdraw`, relations and all. */
function panelRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "w-new",
    partnerId: "partner-1",
    amount: 15_050,
    status: "PENDING",
    method: "card",
    requisites: REQUISITES,
    adminComment: null,
    processedBy: null,
    processedAt: null,
    createdAt: "2026-09-19T10:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
    partner: { id: "partner-1", isActive: true, user: { id: "u-1", name: "Partner", username: null, telegramId: null } },
    ...over,
  };
}

/** The failure as the page's axios raises it. */
function httpFailure(status: number, data: Record<string, unknown>): Error {
  const response = { status, statusText: String(status), headers: {}, config: {}, data };
  return new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_REQUEST", {} as never, {}, response as never);
}

const tr = (key: string, options?: Record<string, unknown>): string => {
  const text = i18n.t(key, options);
  expect(text, `no translation for ${key}`).not.toBe(key);
  return text;
};

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const until = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > until) throw new Error(`gave up waiting for ${what}; on screen: ${document.body.textContent}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <PartnerPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")];
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return buttons().find((candidate) => candidate.textContent?.trim() === label);
}

async function click(element: HTMLElement | null | undefined, what: string): Promise<void> {
  if (!element) throw new Error(`no ${what} on screen; it shows: ${document.body.textContent}`);
  await act(async () => {
    element.click();
  });
  await settle();
}

async function openBalance(): Promise<void> {
  const card = buttons().find((candidate) => candidate.textContent?.includes(tr("partner.balance")));
  await click(card, "balance card");
}

function withdrawButton(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>("[data-testid='partner-withdraw-open']");
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>("[data-testid='partner-withdraw-dialog']");
}

async function openWithdraw(): Promise<void> {
  await openBalance();
  await click(withdrawButton(), "«Вывести средства»");
  expect(dialog(), "«Вывести средства» opened nothing").not.toBeNull();
}

function setField(selector: string, value: string): void {
  const field = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!field) throw new Error(`no field ${selector}; on screen: ${document.body.textContent}`);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setValue?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function amountField(): HTMLInputElement | null {
  return document.body.querySelector<HTMLInputElement>("#partner-withdraw-amount");
}

async function chooseMethod(method: string): Promise<void> {
  await click(document.body.querySelector<HTMLElement>(`[role='radio'][data-method='${method}']`), `method ${method}`);
}

async function fillAndConfirm(amount: string, method: string, requisites: string): Promise<void> {
  setField("#partner-withdraw-amount", amount);
  await chooseMethod(method);
  setField("#partner-withdraw-requisites", requisites);
  await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");
}

function submitButton(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>("[data-testid='partner-withdraw-submit']");
}

function refusalText(): string | null {
  return document.body.querySelector("[data-testid='partner-withdraw-refusal']")?.textContent ?? null;
}

/** Waits for ANY refusal and returns it, so a wrong sentence fails the comparison instead of timing out. */
async function refusal(): Promise<string> {
  await waitUntil(() => refusalText() !== null, "a refusal");
  return refusalText()!;
}

beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPartnerInfo.mockResolvedValue(partnerInfo());
  api.getPartnerEarnings.mockResolvedValue({ earnings: [] });
  api.getPartnerWithdrawals.mockResolvedValue({ withdrawals: [] });
  api.getReferralSummary.mockResolvedValue({ referralCode: 'reiwa-id-1' });
  api.createReferralInvite.mockResolvedValue({});
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("«Вывести средства» opens a withdrawal request", () => {
  it("opens from the balance sheet, with the balance and the limits spelled out", async () => {
    await mount();
    await openBalance();

    const button = withdrawButton();
    expect(button?.textContent).toBe(tr("partner.withdraw"));
    expect(button?.disabled).toBe(false);
    await click(button, "«Вывести средства»");

    expect(dialog(), "«Вывести средства» opened nothing").not.toBeNull();
    const shown = dialog()!.textContent ?? "";
    expect(shown).toContain(tr("partnerWithdraw.available", { amount: "500.00 ₽" }));
    expect(shown).toContain(tr("partnerWithdraw.amountLimits", { min: "0.01 ₽", max: "500.00 ₽" }));
    expect(shown).toContain(tr("partnerWithdraw.howItWorks"));
    expect(api.createWithdrawal).not.toHaveBeenCalled();
  });

  it("sends what the panel takes — minor units, the method, the requisites trimmed — only after the summary", async () => {
    api.createWithdrawal.mockResolvedValue(
      panelRequest({ method: "sbp", requisites: "+7 900 123-45-67, Т-Банк" }),
    );
    await mount();
    await openWithdraw();

    await fillAndConfirm("150,50", "sbp", "  +7 900 123-45-67, Т-Банк \n");

    const summary = document.body.querySelector("[data-testid='partner-withdraw-confirm']")?.textContent ?? "";
    expect(summary).toContain("150.50 ₽");
    expect(summary).toContain(tr("partnerWithdraw.methods.sbp"));
    expect(summary).toContain("+7 900 123-45-67, Т-Банк");
    expect(summary).toContain(tr("partnerWithdraw.confirmNote", { amount: "150.50 ₽" }));
    expect(api.createWithdrawal, "sent before the customer looked at it").not.toHaveBeenCalled();

    const infoReads = api.getPartnerInfo.mock.calls.length;
    const listReads = api.getPartnerWithdrawals.mock.calls.length;
    api.getPartnerWithdrawals.mockResolvedValue({
      withdrawals: [panelRequest({ method: "sbp", requisites: "+7 900 123-45-67, Т-Банк" })],
    });
    await click(submitButton(), "«Отправить заявку»");

    expect(api.createWithdrawal).toHaveBeenCalledTimes(1);
    expect(api.createWithdrawal).toHaveBeenCalledWith({
      amount: 15_050,
      method: "sbp",
      requisites: "+7 900 123-45-67, Т-Банк",
    });

    await waitUntil(() => document.body.querySelector("[data-testid='partner-withdraw-done']") !== null, "the created request");
    const done = document.body.querySelector("[data-testid='partner-withdraw-done']")!.textContent ?? "";
    expect(done).toContain(tr("partnerWithdraw.doneTitle"));
    expect(done).toContain("150.50 ₽");
    expect(done).toContain(tr("partnerWithdraw.history.statuses.PENDING"));
    expect(done).toContain(tr("partnerWithdraw.doneBody"));
    // The balance moved and the list grew: both are read again.
    await waitUntil(() => api.getPartnerInfo.mock.calls.length > infoReads, "the partner info re-read");
    await waitUntil(() => api.getPartnerWithdrawals.mock.calls.length > listReads, "the list re-read");

    await click(buttonLabelled(tr("partnerWithdraw.done")), "«Готово»");
    await waitUntil(() => document.body.querySelector("[data-testid='partner-withdrawal']") !== null, "the list");
    const listed = document.body.querySelector("[data-testid='partner-withdrawals']")!.textContent ?? "";
    expect(listed).toContain("150.50 ₽");
    expect(listed).toContain(tr("partnerWithdraw.history.statuses.PENDING"));
  });

  it("takes the whole balance in one tap", async () => {
    api.createWithdrawal.mockResolvedValue(panelRequest({ amount: 50_000 }));
    await mount();
    await openWithdraw();

    await click(buttonLabelled(tr("partnerWithdraw.amountAll")), "«Весь баланс»");
    expect(amountField()?.value).toBe("500.00");
    setField("#partner-withdraw-requisites", REQUISITES);
    await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");
    await click(submitButton(), "«Отправить заявку»");

    expect(api.createWithdrawal).toHaveBeenCalledWith({ amount: 50_000, method: "card", requisites: REQUISITES });
  });

  it("sends one request per tap, however fast the taps come", async () => {
    api.createWithdrawal.mockReturnValue(new Promise(() => {}));
    await mount();
    await openWithdraw();
    await fillAndConfirm("100", "card", REQUISITES);

    const submit = submitButton();
    expect(submit).not.toBeNull();
    // Two taps inside one frame: the second lands before the button re-renders disabled.
    await act(async () => {
      submit!.click();
      submit!.click();
    });
    await settle();

    expect(api.createWithdrawal, "each request takes money: a double tap took it twice").toHaveBeenCalledTimes(1);
  });

  it("says what is wrong with the form, and sends nothing", async () => {
    await mount();
    await openWithdraw();

    await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");
    const amountError = (): string | null =>
      document.body.querySelector("[data-testid='partner-withdraw-amount-error']")?.textContent ?? null;
    const requisitesError = (): string | null =>
      document.body.querySelector("[data-testid='partner-withdraw-requisites-error']")?.textContent ?? null;
    expect(amountError()).toBe(tr("partnerWithdraw.errors.amountRequired"));
    expect(requisitesError()).toBe(tr("partnerWithdraw.errors.requisitesRequired"));
    expect(amountField()?.getAttribute("aria-invalid")).toBe("true");

    setField("#partner-withdraw-amount", "1e3");
    expect(amountError()).toBe(tr("partnerWithdraw.errors.amountInvalid"));
    setField("#partner-withdraw-amount", "0");
    expect(amountError()).toBe(tr("partnerWithdraw.errors.amountTooSmall", { min: "0.01 ₽" }));
    setField("#partner-withdraw-amount", "500.01");
    expect(amountError()).toBe(tr("partnerWithdraw.errors.amountTooLarge", { max: "500.00 ₽" }));
    setField("#partner-withdraw-requisites", "x".repeat(501));
    expect(requisitesError()).toBe(tr("partnerWithdraw.errors.requisitesTooLong", { max: 500 }));

    await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");
    expect(document.body.querySelector("[data-testid='partner-withdraw-confirm']")).toBeNull();
    expect(api.createWithdrawal).not.toHaveBeenCalled();
  });
});

describe("a refusal, in words", () => {
  async function submitRequest(amount = "150,50"): Promise<void> {
    await mount();
    await openWithdraw();
    await fillAndConfirm(amount, "card", REQUISITES);
    await click(submitButton(), "«Отправить заявку»");
  }

  it("the invited-only program — a 2xx `{ error }` — is a refusal, not a created request", async () => {
    api.createWithdrawal.mockResolvedValue({ error: "PARTNER_PROGRAM_INVITED_ONLY" });
    await submitRequest();

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.invitedOnly"));
    expect(document.body.querySelector("[data-testid='partner-withdraw-done']")).toBeNull();
  });

  it("a partner the panel no longer has — `{ error: 'Partner not found' }`", async () => {
    api.createWithdrawal.mockResolvedValue({ error: "Partner not found" });
    await submitRequest();

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.notPartner"));
    expect(document.body.querySelector("[data-testid='partner-withdraw-done']")).toBeNull();
  });

  it("the recovery hold the page did not know about: the purchase page's words, then the standing notice", async () => {
    api.getPartnerInfo
      .mockResolvedValueOnce(partnerInfo())
      .mockResolvedValue(partnerInfo({ balanceHold: { until: HOLD_UNTIL, timezone: "Europe/Moscow" } }));
    api.createWithdrawal.mockRejectedValue(
      httpFailure(400, {
        code: HOLD_CODE,
        holdUntil: HOLD_UNTIL,
        message: "The partner balance is on hold after an account recovery",
      }),
    );
    await submitRequest();

    // The copy on screen predates the hold, so its zone is unknown: UTC, named —
    // exactly what the purchase page says in the same place.
    expect(await refusal()).toBe(
      tr("partnerBalanceHold.refusedUntil", { until: formatHoldEnd(HOLD_UNTIL, null, "ru") }),
    );
    await waitUntil(() => api.getPartnerInfo.mock.calls.length >= 2, "the partner info re-read");
    const notice = tr("partnerBalanceHold.notice", { until: formatHoldEnd(HOLD_UNTIL, "Europe/Moscow", "ru") });
    await waitUntil(() => (dialog()?.textContent ?? "").includes(notice), "the standing hold notice");
    const submit = submitButton();
    expect(submit?.disabled).toBe(true);
    const describedBy = submit?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(notice);
  });

  it("a bare 400 with less money on the balance now: how much there is, and back to the amount", async () => {
    api.getPartnerInfo.mockResolvedValueOnce(partnerInfo()).mockResolvedValue(partnerInfo({ balance: 10_000 }));
    api.createWithdrawal.mockRejectedValue(httpFailure(400, { message: "Withdrawal request failed" }));
    await submitRequest();

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.insufficient", { balance: "100.00 ₽" }));
    expect(amountField(), "the refusal did not go back to the amount").not.toBeNull();
    expect(api.createWithdrawal).toHaveBeenCalledTimes(1);

    // Back on the form for real: a smaller amount is typed there, and the
    // summary comes only from «Далее» — not by itself, mid-typing.
    setField("#partner-withdraw-amount", "50");
    await settle();
    expect(document.body.querySelector("[data-testid='partner-withdraw-confirm']"), "the summary replaced the form mid-typing").toBeNull();
    expect(amountField()).not.toBeNull();
    await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");
    expect(document.body.querySelector("[data-testid='partner-withdraw-confirm']")?.textContent).toContain("50.00 ₽");
  });

  it("a bare 400 from a partner the operator switched off", async () => {
    api.getPartnerInfo.mockResolvedValueOnce(partnerInfo()).mockResolvedValue(partnerInfo({ isActive: false }));
    api.createWithdrawal.mockRejectedValue(httpFailure(400, { message: "Withdrawal request failed" }));
    await submitRequest();

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.inactive"));
  });

  it("a bare 400 once the program has become invited-only", async () => {
    api.getPartnerInfo.mockResolvedValueOnce(partnerInfo()).mockResolvedValue(partnerInfo({ programAvailable: false }));
    api.createWithdrawal.mockRejectedValue(httpFailure(400, { message: "Withdrawal request failed" }));
    await submitRequest();

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.invitedOnly"));
  });

  it("a request created although its answer was lost is shown as created, and not sent again", async () => {
    api.createWithdrawal.mockRejectedValue(httpFailure(400, { message: "Withdrawal request failed" }));
    // Empty while the customer fills the form; the request is there once asked again.
    api.getPartnerWithdrawals.mockResolvedValueOnce({ withdrawals: [] }).mockResolvedValue({
      withdrawals: [panelRequest()],
    });
    await submitRequest();

    await waitUntil(
      () => document.body.querySelector("[data-testid='partner-withdraw-done']") !== null || refusalText() !== null,
      "an outcome",
    );
    expect(refusalText(), "a request that exists was reported as failed").toBeNull();
    expect(document.body.querySelector("[data-testid='partner-withdraw-done']")?.textContent).toContain("150.50 ₽");
    expect(api.createWithdrawal).toHaveBeenCalledTimes(1);
  });

  it("nothing explains it: says so, and says to look at the list before trying again", async () => {
    api.createWithdrawal.mockRejectedValue(httpFailure(400, { message: "Withdrawal request failed" }));
    await submitRequest();

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.failed"));
    expect(document.body.querySelector("[data-testid='partner-withdraw-done']")).toBeNull();
  });

  it("a revoked session says nothing: the transport is already on its way to sign-in", async () => {
    // The cabinet's fresh session check, for a session signed out elsewhere.
    api.createWithdrawal.mockRejectedValue(
      httpFailure(401, { code: "SESSION_REVOKED", message: "This session was signed out. Sign in again." }),
    );
    await submitRequest();
    await settle();

    expect(refusalText()).toBeNull();
    expect(document.body.querySelector("[data-testid='partner-withdraw-done']")).toBeNull();
    // The answer arrived and was read: the button is live again, not stuck.
    expect(submitButton()?.disabled).toBe(false);
  });

  it("the session could not be checked: nothing was done — the purchase page's words, and the summary stays for another try", async () => {
    api.createWithdrawal.mockRejectedValue(
      httpFailure(503, {
        code: "SESSION_CHECK_UNAVAILABLE",
        message: "Could not confirm that this sign-in is still valid. Nothing was changed. Try again in a minute.",
      }),
    );
    await mount();
    await openWithdraw();
    await fillAndConfirm("150,50", "card", REQUISITES);
    const infoReads = api.getPartnerInfo.mock.calls.length;
    const listReads = api.getPartnerWithdrawals.mock.calls.length;
    await click(submitButton(), "«Отправить заявку»");

    expect(await refusal()).toBe(tr("auth.sessionCheckUnavailable"));
    // Nothing reached the panel: nothing to re-read, nothing to explain.
    await settle();
    expect(api.getPartnerInfo.mock.calls.length).toBe(infoReads);
    expect(api.getPartnerWithdrawals.mock.calls.length).toBe(listReads);
    expect(submitButton()?.disabled).toBe(false);

    api.createWithdrawal.mockResolvedValue(panelRequest());
    await click(submitButton(), "«Отправить заявку» again");
    await waitUntil(() => document.body.querySelector("[data-testid='partner-withdraw-done']") !== null, "the created request");
    expect(api.createWithdrawal).toHaveBeenCalledTimes(2);
  });
});

describe("the recovery hold on the partner page", () => {
  it("is on the page itself: temporary, why, until when, in the operator's clock", async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ balanceHold: { until: HOLD_UNTIL, timezone: "Europe/Moscow" } }));
    await mount();

    const notice = document.getElementById("partner-page-balance-hold");
    expect(notice, "the page says nothing about the hold").not.toBeNull();
    expect(notice!.textContent).toBe(
      tr("partnerBalanceHold.notice", { until: formatHoldEnd(HOLD_UNTIL, "Europe/Moscow", "ru") }),
    );
    expect(notice!.textContent).toMatch(/GMT\+3/);
  });

  it("keeps «Вывести средства» in view, takes no tap, and points at the hold", async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ balanceHold: { until: HOLD_UNTIL, timezone: "Europe/Moscow" } }));
    await mount();
    await openBalance();

    const button = withdrawButton();
    expect(button, "the button left the sheet").not.toBeNull();
    expect(button!.disabled).toBe(true);
    const reason = document.getElementById(button!.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(
      tr("partnerBalanceHold.notice", { until: formatHoldEnd(HOLD_UNTIL, "Europe/Moscow", "ru") }),
    );
    await click(button, "«Вывести средства»");
    expect(dialog()).toBeNull();
    expect(api.createWithdrawal).not.toHaveBeenCalled();
  });

  it("names UTC when the operator set no time zone", async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ balanceHold: { until: HOLD_UNTIL, timezone: null } }));
    await mount();

    const notice = document.getElementById("partner-page-balance-hold");
    expect(notice?.textContent).toBe(tr("partnerBalanceHold.notice", { until: formatHoldEnd(HOLD_UNTIL, null, "ru") }));
    expect(notice?.textContent).toMatch(/UTC/);
  });

  it.each([
    ["no hold", null],
    ["a hold that has ended", { until: new Date(Date.now() - 60_000).toISOString(), timezone: "Europe/Moscow" }],
    ["a panel too old to report holds", undefined],
  ] as const)("says nothing and leaves the button live with %s", async (_case, balanceHold) => {
    const info = partnerInfo();
    if (balanceHold === undefined) delete info["balanceHold"];
    else info["balanceHold"] = balanceHold;
    api.getPartnerInfo.mockResolvedValue(info);
    await mount();
    await openBalance();

    expect(document.getElementById("partner-page-balance-hold")).toBeNull();
    expect(withdrawButton()?.disabled).toBe(false);
    expect(withdrawButton()?.hasAttribute("aria-describedby")).toBe(false);
    // …and the page is really there.
    expect(document.body.textContent).toContain(tr("partner.title"));
  });
});

describe("why else «Вывести средства» takes no tap", () => {
  it.each([
    ["the program is open to invited users only", { programAvailable: false }, "partnerWithdraw.refused.invitedOnly"],
    ["the operator switched the partner off", { isActive: false }, "partnerWithdraw.refused.inactive"],
    ["there is nothing on the balance", { balance: 0 }, "partnerWithdraw.empty"],
  ] as const)("%s — and it says so", async (_case, over, key) => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo(over));
    await mount();
    await openBalance();

    const button = withdrawButton();
    expect(button?.disabled).toBe(true);
    const reason = document.getElementById(button?.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(tr(key));
  });
});

describe("the requests, and where each one stands", () => {
  it("names every status, says a rejected amount came back, and shows the operator's reason", async () => {
    api.getPartnerWithdrawals.mockResolvedValue({
      withdrawals: [
        panelRequest({ id: "w-1", status: "PENDING", amount: 10_000 }),
        panelRequest({ id: "w-2", status: "COMPLETED", amount: 20_000, method: "crypto", requisites: "USDT TRC-20 T9yD", processedAt: "2026-09-18T10:00:00.000Z" }),
        panelRequest({ id: "w-3", status: "REJECTED", amount: 30_000, adminComment: "Неверный номер карты", processedAt: "2026-09-17T10:00:00.000Z" }),
        panelRequest({ id: "w-4", status: "CANCELED", amount: 40_000, method: "paypal-by-hand" }),
        panelRequest({ id: "w-5", status: "ON_HOLD", amount: 50_000 }),
      ],
    });
    await mount();
    await openBalance();
    await waitUntil(() => document.body.querySelectorAll("[data-testid='partner-withdrawal']").length === 5, "five requests");

    const rows = [...document.body.querySelectorAll<HTMLElement>("[data-testid='partner-withdrawal']")];
    const status = (row: HTMLElement): string =>
      row.querySelector("[data-testid='partner-withdrawal-status']")?.textContent ?? "";
    expect(rows.map(status)).toEqual([
      tr("partnerWithdraw.history.statuses.PENDING"),
      tr("partnerWithdraw.history.statuses.COMPLETED"),
      tr("partnerWithdraw.history.statuses.REJECTED"),
      tr("partnerWithdraw.history.statuses.CANCELED"),
      // A status this build does not know is shown as it came, not guessed at.
      tr("partnerWithdraw.history.unknownStatus", { status: "ON_HOLD" }),
    ]);
    expect(rows[0]!.textContent).toContain("100.00 ₽");
    expect(rows[1]!.textContent).toContain(tr("partnerWithdraw.methods.crypto"));
    expect(rows[2]!.textContent).toContain(tr("partnerWithdraw.history.refunded"));
    expect(rows[2]!.textContent).toContain(tr("partnerWithdraw.history.comment", { comment: "Неверный номер карты" }));
    // Only a rejection returns the money — nothing sets CANCELED, so nothing is claimed about it.
    expect(rows[3]!.textContent).not.toContain(tr("partnerWithdraw.history.refunded"));
    expect(rows[3]!.textContent).toContain("paypal-by-hand");
    expect(rows[0]!.textContent).not.toContain(tr("partnerWithdraw.history.refunded"));
  });

  it("says nothing at all when the list is empty — which is also what a failed read looks like", async () => {
    await mount();
    await openBalance();

    expect(document.body.querySelector("[data-testid='partner-withdrawals']")).toBeNull();
    expect(document.body.textContent).not.toContain(tr("partnerWithdraw.history.title"));
    // The sheet around it is on screen.
    expect(withdrawButton()).not.toBeNull();
    expect(api.getPartnerWithdrawals).toHaveBeenCalled();
  });
});

describe("a refusal the panel names with a code", () => {
  async function submitRefused(failure: Error, amount = "150,50"): Promise<{ infoReads: number; listReads: number }> {
    api.createWithdrawal.mockRejectedValue(failure);
    await mount();
    await openWithdraw();
    await fillAndConfirm(amount, "card", REQUISITES);
    const infoReads = api.getPartnerInfo.mock.calls.length;
    const listReads = api.getPartnerWithdrawals.mock.calls.length;
    await click(submitButton(), "«Отправить заявку»");
    return { infoReads, listReads };
  }

  it.each([
    [409, "PARTNER_PROGRAM_INVITED_ONLY", "partnerWithdraw.refused.invitedOnly"],
    [409, "PARTNER_NOT_ACTIVE", "partnerWithdraw.refused.inactive"],
    [409, "PARTNER_NOT_FOUND", "partnerWithdraw.refused.notPartner"],
  ] as const)("%i %s: its own words, and the partner info read again", async (status, code, key) => {
    const reads = await submitRefused(httpFailure(status, { code, message: "x" }));

    expect(await refusal()).toBe(tr(key));
    await waitUntil(() => api.getPartnerInfo.mock.calls.length > reads.infoReads, "the partner info re-read");
    // A named refusal is a refusal: nothing to look for on the list.
    expect(api.getPartnerWithdrawals.mock.calls.length).toBe(reads.listReads);
    expect(document.body.querySelector("[data-testid='partner-withdraw-done']")).toBeNull();
  });

  it("422 WITHDRAWAL_INSUFFICIENT_BALANCE: how much there is now, and back to the amount", async () => {
    api.getPartnerInfo.mockResolvedValueOnce(partnerInfo()).mockResolvedValue(partnerInfo({ balance: 10_000 }));

    await submitRefused(httpFailure(422, { code: "WITHDRAWAL_INSUFFICIENT_BALANCE", message: "x" }));

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.insufficient", { balance: "100.00 ₽" }));
    expect(amountField(), "the refusal did not go back to the amount").not.toBeNull();
  });

  it("422 WITHDRAWAL_BELOW_MINIMUM: the minimum it carried, and back to the amount", async () => {
    await submitRefused(
      httpFailure(422, { code: "WITHDRAWAL_BELOW_MINIMUM", message: "x", minWithdrawalAmount: 30_700 }),
    );

    expect(await refusal()).toBe(tr("partnerWithdraw.refused.belowMinimum", { min: "307.00 ₽" }));
    expect(amountField(), "the refusal did not go back to the amount").not.toBeNull();
    expect(refusalText()).not.toBe(tr("partnerWithdraw.refused.failed"));
  });
});

describe("the operator's minimum, before anything is sent", () => {
  it("is in the limits, and a smaller amount is refused on the form", async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ minWithdrawalAmount: 30_700 }));
    await mount();
    await openWithdraw();

    expect(dialog()!.textContent).toContain(tr("partnerWithdraw.amountLimits", { min: "307.00 ₽", max: "500.00 ₽" }));
    setField("#partner-withdraw-amount", "306.99");
    setField("#partner-withdraw-requisites", REQUISITES);
    await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");

    expect(document.body.querySelector("[data-testid='partner-withdraw-amount-error']")?.textContent).toBe(
      tr("partnerWithdraw.errors.amountTooSmall", { min: "307.00 ₽" }),
    );
    expect(document.body.querySelector("[data-testid='partner-withdraw-confirm']")).toBeNull();
    expect(api.createWithdrawal).not.toHaveBeenCalled();

    // Exactly the minimum is enough.
    setField("#partner-withdraw-amount", "307");
    await click(document.body.querySelector("[data-testid='partner-withdraw-next']"), "«Далее»");
    expect(document.body.querySelector("[data-testid='partner-withdraw-confirm']")?.textContent).toContain("307.00 ₽");
  });

  it("takes no tap on «Вывести средства» when the whole balance is below it, and says so", async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ balance: 20_000, minWithdrawalAmount: 30_700 }));
    await mount();
    await openBalance();

    const button = withdrawButton();
    expect(button?.disabled).toBe(true);
    const reason = document.getElementById(button?.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(tr("partnerWithdraw.belowMinimum", { min: "307.00 ₽", balance: "200.00 ₽" }));
  });
});

describe("the balance in its own currency", () => {
  it("prints the balance currency everywhere the page shows money — no «₽» for a dollar balance", async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ balanceCurrency: "USD" }));
    api.getPartnerEarnings.mockResolvedValue({
      earnings: [{ id: "e-1", level: 1, percent: 10, earnedAmount: 150, createdAt: "2026-09-18T10:00:00.000Z" }],
    });
    api.getPartnerWithdrawals.mockResolvedValue({ withdrawals: [panelRequest({ amount: 12_345 })] });
    await mount();

    // The stat card, before anything is opened.
    expect(container?.textContent).toContain("500.00 $");
    expect(container?.textContent).toContain(tr("partner.earned", { amount: "900.00 $" }));

    await openBalance();
    await waitUntil(() => (document.body.textContent ?? "").includes("+1.50 $"), "the earnings list");
    await waitUntil(() => document.body.querySelector("[data-testid='partner-withdrawal']") !== null, "the requests");
    const sheet = document.body.textContent ?? "";
    expect(sheet).toContain(`${tr("partner.totalEarned")}: 900.00 $`);
    expect(sheet).toContain("123.45 $");
    expect(sheet).not.toContain("₽");
  });
});

describe("every sheet on the page is described, or says it is not", () => {
  const SHEETS = [
    ["partner.level", "partner.levelDescription"],
    ["partner.referrals", null],
    ["partner.balance", null],
    ["partner.info", "partner.infoDescription"],
  ] as const;

  it.each(SHEETS)("%s: no «Missing Description» from Radix", async (label, description) => {
    const warnings: string[] = [];
    const record = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    await mount();

    const card = buttons().find((candidate) => candidate.textContent?.includes(tr(label)));
    await click(card, `the ${label} card`);

    const content = document.body.querySelector<HTMLElement>("[role='dialog']");
    expect(content, `the ${label} sheet did not open`).not.toBeNull();
    expect(warnings.filter((line) => line.includes("Missing `Description`"))).toEqual([]);
    if (description === null) {
      expect(content!.hasAttribute("aria-describedby")).toBe(false);
    } else {
      const describedBy = content!.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBe(tr(description));
    }
    vi.restoreAllMocks();
  });
});

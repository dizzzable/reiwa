// @vitest-environment jsdom
/**
 * A refused add-on purchase says why, and returns to the step where the
 * subscriber can act on it.
 *
 * Every refusal used to end in «Не удалось создать платёж. Попробуйте позже.»
 * on the confirmation screen — for an add-on withdrawn while the page was open,
 * a lapsed subscription, a payment method switched off — so the subscriber
 * pressed «Перейти к оплате» again and met the same refusal. The cabinet now
 * forwards the refusals the panel names as a code
 * (`src/api/routes/add-on-purchase-errors.ts`); this pins what the page makes
 * of each one, with the real dictionaries, and that a failure without a known
 * code still gets exactly the old answer.
 *
 * Mounted the way the app mounts the wizard: the store advanced into the
 * checkout step, which fires the purchase on mount.
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next, { type TFunction } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  claimFreeTrafficReset: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getEnabledGateways: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
  purchaseAddOn: vi.fn(),
}));
const translate = vi.hoisted(() => ({
  t: ((key: string) => key) as (key: string, options?: Record<string, unknown>) => string,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate.t(key, options),
    i18n: { language: "ru" },
  }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, className }: { readonly children?: ReactNode; readonly className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
}));
vi.mock("@/lib/use-access-mode", () => ({
  useAccessMode: () => ({ purchasesBlocked: false, restricted: false, isLoading: false }),
}));
vi.mock("@/lib/branding-provider", () => ({ useBranding: () => ({ customIcons: [] }) }));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/subscription/subscription-select-card", () => ({
  SubscriptionSelectCard: () => null,
}));

import type { EligibleAddOn } from "../src/lib/api-client/content";
import AddOnsPage from "../src/features/addons/addons-page";
import {
  ADD_ON_PURCHASE_REFUSAL_CODES,
  answerAddOnPurchaseFailure,
  type AddOnPurchaseRefusalCode,
} from "../src/features/addons/purchase-refusal";
import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { useAddOnStore, type AddOnStep } from "../src/stores/addons.store";

const ADD_ON: EligibleAddOn = {
  id: "addon-1",
  revision: 3,
  name: "Трафик плюс",
  description: null,
  type: "EXTRA_TRAFFIC",
  icon: null,
  value: 50,
  lifetime: "UNTIL_SUBSCRIPTION_END",
  eligibility: {
    eligible: true,
    activation: "NOW",
    expiresAt: "2026-10-12T09:30:00.000Z",
    dated: true,
    explanationCode: "ELIGIBLE_UNTIL_SUBSCRIPTION_END",
  },
  prices: [{ currency: "RUB", price: "99" }],
};
const GATEWAY = { id: "YOOKASSA", label: "YooKassa", icon: "", currency: "RUB" };

const ELIGIBILITY = ["add-ons-eligibility"];
const GATEWAYS = ["gateways"];
const SUBSCRIPTIONS = ["subscriptions"];
const POLICY = ["platform-policy"];

interface Expected {
  readonly ru: string;
  readonly en: string;
  readonly step: AddOnStep;
  readonly reread: readonly (readonly string[])[];
}

const UNAVAILABLE: Omit<Expected, "step" | "reread"> = {
  ru: "Эта опция больше недоступна для вашей подписки. Список опций обновлён — выберите другую.",
  en: "This add-on is no longer available for your subscription. The list has been refreshed — choose another one.",
};
const CHANGED: Omit<Expected, "step" | "reread"> = {
  ru: "Опция изменилась, пока вы её выбирали. Список обновлён — проверьте условия и цену и выберите снова.",
  en: "The add-on changed while you were choosing it. The list has been refreshed — check the terms and price and choose again.",
};
const PAYMENT_METHOD: Omit<Expected, "step" | "reread"> = {
  ru: "Этот способ оплаты сейчас недоступен. Выберите другой или напишите в поддержку.",
  en: "This payment method is unavailable right now. Choose another one or contact support.",
};

/** What the subscriber reads for each code, and where the wizard takes them. */
const EXPECTED: Readonly<Record<AddOnPurchaseRefusalCode, Expected>> = {
  ADDON_LIFETIME_UNAVAILABLE: { ...UNAVAILABLE, step: "addon", reread: [ELIGIBILITY] },
  ADDON_NOT_AVAILABLE: { ...UNAVAILABLE, step: "addon", reread: [ELIGIBILITY] },
  ADDON_ALREADY_UNLIMITED: {
    ru: "У подписки уже безлимит — эта опция ей не нужна. Список опций обновлён.",
    en: "Your subscription is already unlimited — it does not need this add-on. The list has been refreshed.",
    step: "addon",
    reread: [ELIGIBILITY],
  },
  ADDON_SUBSCRIPTION_NOT_ACTIVE: {
    ru: "Подписка не активна, докупить к ней опцию нельзя. Сначала продлите подписку.",
    en: "The subscription is not active, so add-ons cannot be bought for it. Renew the subscription first.",
    step: "subscriptions",
    reread: [SUBSCRIPTIONS, ELIGIBILITY],
  },
  ADDON_NO_PRICE_FOR_GATEWAY: { ...CHANGED, step: "addon", reread: [ELIGIBILITY] },
  ADDON_REVISION_CONFLICT: { ...CHANGED, step: "addon", reread: [ELIGIBILITY] },
  IDEMPOTENCY_KEY_CONFLICT: {
    ru: "Эта попытка оплаты устарела. Нажмите «Перейти к оплате» ещё раз.",
    en: "This payment attempt is out of date. Press “Proceed to payment” again.",
    step: "review",
    reread: [],
  },
  PROVIDER_OUTCOME_UNKNOWN: {
    ru: "Платёжная система не ответила, и страница оплаты не открылась. Подождите несколько минут и попробуйте снова.",
    en: "The payment provider did not respond, so the payment page did not open. Wait a few minutes and try again.",
    step: "review",
    reread: [],
  },
  PAYMENT_GATEWAY_NOT_ACTIVE: { ...PAYMENT_METHOD, step: "gateway", reread: [GATEWAYS] },
  PAYMENT_GATEWAY_NOT_CONFIGURED: { ...PAYMENT_METHOD, step: "gateway", reread: [GATEWAYS] },
  PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED: { ...PAYMENT_METHOD, step: "gateway", reread: [GATEWAYS] },
  PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED: {
    ru: "Telegram Stars можно оплатить только в приложении Telegram. Выберите другой способ оплаты.",
    en: "Telegram Stars can only be paid in the Telegram app. Choose another payment method.",
    step: "gateway",
    reread: [GATEWAYS],
  },
  PURCHASES_DISABLED: {
    ru: "Покупки временно отключены. Попробуйте позже.",
    en: "Purchases are temporarily disabled. Please try again later.",
    step: "review",
    reread: [POLICY],
  },
  SERVICE_RESTRICTED: {
    ru: "Сервис временно недоступен: идут технические работы. Попробуйте позже.",
    en: "The service is temporarily unavailable for maintenance. Please try again later.",
    step: "review",
    reread: [POLICY],
  },
};

/** Today's answer, which every failure without a known code must keep. */
const GENERIC = { ru: "Не удалось создать платёж. Попробуйте позже.", en: "Failed to create payment. Please try again later." };

/** The error axios rejects with, carrying what the cabinet answered. */
function refusal(status: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

/** The status the cabinet sends each code with (`add-on-purchase-errors.ts`). */
function cabinetStatus(code: AddOnPurchaseRefusalCode): number {
  if (code === "ADDON_REVISION_CONFLICT" || code === "IDEMPOTENCY_KEY_CONFLICT") return 409;
  if (code === "PROVIDER_OUTCOME_UNKNOWN") return 502;
  if (code === "PURCHASES_DISABLED") return 403;
  if (code === "SERVICE_RESTRICTED") return 503;
  return 400;
}

let ruT: TFunction;
let enT: TFunction;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;
let invalidated: unknown[];

beforeAll(async () => {
  const ruInstance = i18next.createInstance();
  await ruInstance.init({ lng: "ru", resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } });
  ruT = ruInstance.t.bind(ruInstance);
  const enInstance = i18next.createInstance();
  await enInstance.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  enT = enInstance.t.bind(enInstance);
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Opens the wizard on its checkout step, which asks for the purchase on mount. */
async function checkoutRefusedWith(error: unknown): Promise<void> {
  api.purchaseAddOn.mockRejectedValueOnce(error);
  useAddOnStore.setState({
    step: "checkout",
    selectedSubscriptionId: "sub-1",
    selectedAddOn: ADD_ON,
    selectedGateway: GATEWAY,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AddOnsPage />
      </QueryClientProvider>,
    );
  });
  await settle();
  await settle();
  expect(api.purchaseAddOn).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  translate.t = (key, options) => ruT(key, options);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  invalidated = [];
  const invalidate = queryClient.invalidateQueries.bind(queryClient);
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters, options) => {
    invalidated.push(filters?.queryKey);
    return invalidate(filters, options);
  });
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  api.getEnabledGateways.mockResolvedValue([]);
  api.getSubscriptionAddOns.mockResolvedValue({ contractVersion: 2, availability: "EMPTY", target: null, addOns: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useAddOnStore.getState().reset();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("each refusal the cabinet forwards", () => {
  it("has an answer here for every code the page knows", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ADD_ON_PURCHASE_REFUSAL_CODES].sort());
  });

  it.each([...ADD_ON_PURCHASE_REFUSAL_CODES])("%s: says why and goes back to the step where it is fixed", async (code) => {
    const expected = EXPECTED[code];
    await checkoutRefusedWith(refusal(cabinetStatus(code), { code, message: "fixed sentence" }));

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(expected.ru);
    expect(useAddOnStore.getState().step).toBe(expected.step);
    expect(invalidated).toEqual(expected.reread);
    // The subscriber was not sent anywhere, and nothing was bought.
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each([...ADD_ON_PURCHASE_REFUSAL_CODES])("%s: the same words in English", (code) => {
    const answer = answerAddOnPurchaseFailure(refusal(cabinetStatus(code), { code, message: "x" }));

    expect(enT(answer.messageKey)).toBe(EXPECTED[code].en);
    expect(ruT(answer.messageKey)).toBe(EXPECTED[code].ru);
  });
});

describe("a failure without a known code keeps today's answer", () => {
  it.each([
    ["a code the page does not know", refusal(400, { code: "SOMETHING_NEW", message: "Something new" })],
    ["the generic refusal", refusal(400, { message: "Add-on purchase failed" })],
    ["a code in the message, not in `code`", refusal(400, { message: "ADDON_LIFETIME_UNAVAILABLE" })],
    ["a known code on a 401, where the session is gone", refusal(401, { code: "ADDON_NOT_AVAILABLE" })],
    ["a code in another case", refusal(400, { code: "addon_not_available" })],
    ["a body that is not an object", refusal(502, "<html>502 Bad Gateway</html>")],
    ["no answer at all", Object.assign(new Error("Network Error"), { isAxiosError: true })],
  ])("%s", async (_name, error) => {
    await checkoutRefusedWith(error);

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(GENERIC.ru);
    expect(useAddOnStore.getState().step).toBe("review");
    expect(invalidated).toEqual([]);
    // The selection survives for a retry from the confirmation screen.
    expect(useAddOnStore.getState()).toMatchObject({
      selectedSubscriptionId: "sub-1",
      selectedAddOn: ADD_ON,
      selectedGateway: GATEWAY,
    });
  });

  it("in English too", () => {
    const answer = answerAddOnPurchaseFailure(refusal(400, { message: "Add-on purchase failed" }));

    expect(enT(answer.messageKey)).toBe(GENERIC.en);
  });
});

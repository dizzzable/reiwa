/**
 * Session-scoped handoff between a successful creation checkout and the
 * dashboard subscription assembly state.
 *
 * This is intentionally separate from `pending-checkout`: provider URLs may
 * be absent and are cleared as soon as payment completes, while a provisioning
 * receipt must survive until the real Remnawave-backed card is ready.
 */

const STORAGE_KEY = "reiwa:subscription-provisioning-receipts";
const STORAGE_VERSION = 1;
const MAX_PAYMENT_ID_LENGTH = 256;
const MAX_SLOT_INDEX = 10_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const SUBSCRIPTION_PROVISIONING_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
export const SUBSCRIPTION_PROVISIONING_RECEIPT_MAX_ENTRIES = 8;
export const SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT =
  "reiwa:subscription-provisioning-receipts-changed";

export type SubscriptionCreationPurchaseType = "NEW" | "ADDITIONAL";
export type SubscriptionProvisioningReceiptPhase =
  | "AWAITING_PAYMENT"
  | "PROVISIONING";
export type SubscriptionProvisioningSlotIndexSource =
  | "CHECKOUT"
  | "PAYMENT_STATUS";
export type SubscriptionProvisioningReceiptSource = "PAYMENT" | "TRIAL";

export interface SubscriptionProvisioningReceipt {
  readonly version: 1;
  readonly paymentId: string;
  /**
   * Missing means PAYMENT for receipts written before trial provisioning was
   * introduced. Keeping the field optional preserves an in-flight checkout
   * across a deploy.
   */
  readonly source?: SubscriptionProvisioningReceiptSource;
  /** Exact local subscription created by the free-trial endpoint. */
  readonly subscriptionId?: string;
  readonly purchaseType: SubscriptionCreationPurchaseType;
  readonly slotIndex: number;
  /**
   * PAYMENT_STATUS means the original count is unknown (for example, the
   * provider return opened in another tab or action-policy was unavailable).
   * The dashboard must append after its current real items instead of trusting
   * the zero fallback.
   */
  readonly slotIndexSource: SubscriptionProvisioningSlotIndexSource;
  readonly createdAt: number;
  readonly phase: SubscriptionProvisioningReceiptPhase;
}

export interface SubscriptionProvisioningReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SubscriptionProvisioningReceiptStoreOptions {
  readonly storage?: SubscriptionProvisioningReceiptStorage | null;
  readonly now?: number;
}

type ReceiptMap = Record<string, SubscriptionProvisioningReceipt>;

interface StoredReceiptEnvelope {
  readonly version: 1;
  readonly receipts: ReceiptMap;
}

type SaveReceiptInput = Omit<SubscriptionProvisioningReceipt, "version" | "createdAt"> & {
  readonly createdAt?: number;
};

export interface SaveTrialSubscriptionProvisioningReceiptInput {
  readonly subscriptionId: string;
  readonly slotIndex: number;
  readonly createdAt?: number;
}

interface LoadedReceiptMap {
  readonly receipts: ReceiptMap;
  readonly dirty: boolean;
}

export function isSubscriptionCreationPurchaseType(
  value: unknown,
): value is SubscriptionCreationPurchaseType {
  return value === "NEW" || value === "ADDITIONAL";
}

/**
 * ADDITIONAL is also used by add-on transactions, so purchaseType alone is
 * not a creation discriminator. An existing receipt proves the checkout came
 * from the creation wizard; otherwise the backend provisioning status must be
 * applicable. The known add-on route is an extra compatibility guard.
 */
export function shouldTrackSubscriptionProvisioningReceipt(input: {
  readonly purchaseType: unknown;
  readonly subscriptionProvisioningStatus: unknown;
  readonly hasExistingReceipt: boolean;
  readonly returnTo?: string | null;
}): input is typeof input & {
  readonly purchaseType: SubscriptionCreationPurchaseType;
} {
  return (
    isSubscriptionCreationPurchaseType(input.purchaseType) &&
    input.returnTo !== "/addons" &&
    (input.hasExistingReceipt ||
      input.subscriptionProvisioningStatus !== "NOT_APPLICABLE")
  );
}

export function saveSubscriptionProvisioningReceipt(
  input: SaveReceiptInput,
  options: SubscriptionProvisioningReceiptStoreOptions = {},
): SubscriptionProvisioningReceipt | null {
  const now = resolveNow(options.now);
  const receipt: SubscriptionProvisioningReceipt = {
    version: STORAGE_VERSION,
    paymentId: input.paymentId,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.subscriptionId === undefined
      ? {}
      : { subscriptionId: input.subscriptionId }),
    purchaseType: input.purchaseType,
    slotIndex: input.slotIndex,
    slotIndexSource: input.slotIndexSource,
    createdAt: input.createdAt ?? now,
    phase: input.phase,
  };
  if (!isValidReceipt(receipt, receipt.paymentId, now, false)) return null;

  const storage = resolveStorage(options.storage);
  if (storage === null) {
    notifyReceiptChange(true);
    return receipt;
  }

  const loaded = loadReceiptMap(storage, now);
  const receipts = { ...loaded.receipts, [receipt.paymentId]: receipt };
  writeReceiptMap(storage, boundReceiptMap(receipts));
  return receipt;
}

/**
 * A free trial has no payment-status resource to poll. Its receipt therefore
 * carries the authoritative local subscription ID and uses a namespaced key
 * only for session-storage bookkeeping.
 */
export function saveTrialSubscriptionProvisioningReceipt(
  input: SaveTrialSubscriptionProvisioningReceiptInput,
  options: SubscriptionProvisioningReceiptStoreOptions = {},
): SubscriptionProvisioningReceipt | null {
  return saveSubscriptionProvisioningReceipt(
    {
      paymentId: `trial:${input.subscriptionId}`,
      source: "TRIAL",
      subscriptionId: input.subscriptionId,
      purchaseType: "NEW",
      slotIndex: input.slotIndex,
      slotIndexSource: "CHECKOUT",
      phase: "PROVISIONING",
      createdAt: input.createdAt,
    },
    options,
  );
}

export function isTrialSubscriptionProvisioningReceipt(
  receipt: SubscriptionProvisioningReceipt,
): receipt is SubscriptionProvisioningReceipt & {
  readonly source: "TRIAL";
  readonly subscriptionId: string;
} {
  return (
    receipt.source === "TRIAL" &&
    typeof receipt.subscriptionId === "string" &&
    receipt.subscriptionId.length > 0
  );
}

/**
 * Restores a missing receipt from the payment-status response without
 * overwriting the accurate checkout slot when the original receipt exists.
 * Phase transitions are monotonic: a stale PENDING response cannot move a
 * receipt back from PROVISIONING to AWAITING_PAYMENT.
 */
export function ensureSubscriptionProvisioningReceipt(
  input: SaveReceiptInput,
  options: SubscriptionProvisioningReceiptStoreOptions = {},
): SubscriptionProvisioningReceipt | null {
  const existing = readSubscriptionProvisioningReceipt(input.paymentId, options);
  if (existing === null) {
    return saveSubscriptionProvisioningReceipt(input, options);
  }

  const phase =
    existing.phase === "PROVISIONING" || input.phase === "PROVISIONING"
      ? "PROVISIONING"
      : "AWAITING_PAYMENT";
  return saveSubscriptionProvisioningReceipt(
    {
      ...existing,
      purchaseType: input.purchaseType,
      phase,
      createdAt: existing.createdAt,
    },
    options,
  );
}

export function readSubscriptionProvisioningReceipt(
  paymentId: string,
  options: SubscriptionProvisioningReceiptStoreOptions = {},
): SubscriptionProvisioningReceipt | null {
  if (!isValidPaymentId(paymentId)) return null;
  const storage = resolveStorage(options.storage);
  if (storage === null) return null;

  const now = resolveNow(options.now);
  const loaded = loadReceiptMap(storage, now);
  if (loaded.dirty) persistCleanedMap(storage, loaded.receipts);
  return loaded.receipts[paymentId] ?? null;
}

export function listSubscriptionProvisioningReceipts(
  options: SubscriptionProvisioningReceiptStoreOptions = {},
): SubscriptionProvisioningReceipt[] {
  const storage = resolveStorage(options.storage);
  if (storage === null) return [];

  const now = resolveNow(options.now);
  const loaded = loadReceiptMap(storage, now);
  if (loaded.dirty) persistCleanedMap(storage, loaded.receipts);
  return Object.values(loaded.receipts).sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.paymentId.localeCompare(right.paymentId),
  );
}

export function clearSubscriptionProvisioningReceipt(
  paymentId?: string,
  options: SubscriptionProvisioningReceiptStoreOptions = {},
): void {
  const storage = resolveStorage(options.storage);
  if (storage === null) {
    notifyReceiptChange(false);
    return;
  }

  if (paymentId === undefined) {
    safeRemove(storage);
    return;
  }
  if (!isValidPaymentId(paymentId)) return;

  const loaded = loadReceiptMap(storage, resolveNow(options.now));
  if (!(paymentId in loaded.receipts)) {
    if (loaded.dirty) persistCleanedMap(storage, loaded.receipts);
    return;
  }
  const receipts = { ...loaded.receipts };
  delete receipts[paymentId];
  persistCleanedMap(storage, receipts);
}

function resolveStorage(
  override: SubscriptionProvisioningReceiptStorage | null | undefined,
): SubscriptionProvisioningReceiptStorage | null {
  if (override !== undefined) return override;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function resolveNow(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : Date.now();
}

function loadReceiptMap(
  storage: SubscriptionProvisioningReceiptStorage,
  now: number,
): LoadedReceiptMap {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { receipts: {}, dirty: false };
  }
  if (raw === null) return { receipts: {}, dirty: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    safeRemove(storage);
    return { receipts: {}, dirty: false };
  }
  if (!isRecord(parsed) || parsed["version"] !== STORAGE_VERSION) {
    safeRemove(storage);
    return { receipts: {}, dirty: false };
  }
  const candidate = parsed["receipts"];
  if (!isRecord(candidate)) {
    safeRemove(storage);
    return { receipts: {}, dirty: false };
  }

  const receipts: ReceiptMap = {};
  let dirty = false;
  for (const [paymentId, value] of Object.entries(candidate)) {
    if (!isValidReceipt(value, paymentId, now, true)) {
      dirty = true;
      continue;
    }
    receipts[paymentId] = value;
  }
  const bounded = boundReceiptMap(receipts);
  if (Object.keys(bounded).length !== Object.keys(receipts).length) dirty = true;
  return { receipts: bounded, dirty };
}

function isValidReceipt(
  value: unknown,
  mapKey: string,
  now: number,
  enforceTtl: boolean,
): value is SubscriptionProvisioningReceipt {
  if (!isRecord(value)) return false;
  if (value["version"] !== STORAGE_VERSION) return false;
  if (value["paymentId"] !== mapKey || !isValidPaymentId(mapKey)) return false;
  if (
    value["source"] !== undefined &&
    value["source"] !== "PAYMENT" &&
    value["source"] !== "TRIAL"
  ) {
    return false;
  }
  if (value["source"] === "TRIAL") {
    if (!isValidPaymentId(value["subscriptionId"])) return false;
  } else if (value["subscriptionId"] !== undefined) {
    return false;
  }
  if (!isSubscriptionCreationPurchaseType(value["purchaseType"])) return false;
  if (
    typeof value["slotIndex"] !== "number" ||
    !Number.isInteger(value["slotIndex"]) ||
    value["slotIndex"] < 0 ||
    value["slotIndex"] > MAX_SLOT_INDEX
  ) {
    return false;
  }
  if (
    value["slotIndexSource"] !== "CHECKOUT" &&
    value["slotIndexSource"] !== "PAYMENT_STATUS"
  ) {
    return false;
  }
  if (
    typeof value["createdAt"] !== "number" ||
    !Number.isFinite(value["createdAt"]) ||
    value["createdAt"] < 0 ||
    value["createdAt"] > now + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return false;
  }
  if (
    value["phase"] !== "AWAITING_PAYMENT" &&
    value["phase"] !== "PROVISIONING"
  ) {
    return false;
  }
  return (
    !enforceTtl ||
    now - value["createdAt"] <= SUBSCRIPTION_PROVISIONING_RECEIPT_TTL_MS
  );
}

function isValidPaymentId(paymentId: unknown): paymentId is string {
  return (
    typeof paymentId === "string" &&
    paymentId.length > 0 &&
    paymentId.length <= MAX_PAYMENT_ID_LENGTH
  );
}

function boundReceiptMap(receipts: ReceiptMap): ReceiptMap {
  const sorted = Object.values(receipts).sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.paymentId.localeCompare(left.paymentId),
  );
  return Object.fromEntries(
    sorted
      .slice(0, SUBSCRIPTION_PROVISIONING_RECEIPT_MAX_ENTRIES)
      .map((receipt) => [receipt.paymentId, receipt]),
  );
}

function persistCleanedMap(
  storage: SubscriptionProvisioningReceiptStorage,
  receipts: ReceiptMap,
): void {
  if (Object.keys(receipts).length === 0) {
    safeRemove(storage);
    return;
  }
  writeReceiptMap(storage, receipts);
}

function writeReceiptMap(
  storage: SubscriptionProvisioningReceiptStorage,
  receipts: ReceiptMap,
): void {
  const envelope: StoredReceiptEnvelope = {
    version: STORAGE_VERSION,
    receipts,
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    notifyReceiptChange(Object.keys(receipts).length > 0);
  } catch {
    // Storage can be blocked or over quota. Provisioning remains server-driven;
    // losing the local animation handoff must never fail a payment request.
  }
}

function safeRemove(storage: SubscriptionProvisioningReceiptStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
    notifyReceiptChange(false);
  } catch {
    // Best-effort cleanup only.
  }
}

function notifyReceiptChange(hasPendingProvisioning: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ readonly hasPendingProvisioning: boolean }>(
      SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
      { detail: { hasPendingProvisioning } },
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

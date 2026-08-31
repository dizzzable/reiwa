/**
 * Add-ons namespace — optional extras (extra traffic / extra devices)
 * an operator attaches to plans. Surfaced on the SPA purchase flow so
 * a user can top up a subscription beyond its base plan limits.
 */
import { z } from 'zod';

import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface AddOnPrice {
  readonly id: string;
  readonly currency: string;
  readonly price: string;
}

export interface AddOn {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES';
  readonly icon: string | null;
  readonly value: number;
  readonly isActive: boolean;
  readonly orderIndex: number;
  readonly applicablePlanIds: readonly string[];
  readonly prices: readonly AddOnPrice[];
}

// ── v2 subscription-scoped eligibility contract (runtime-validated) ──────────
// Mirrors the rezeis `AddOnEligibilityResult` (contract v2). Validated with Zod
// so a malformed upstream payload fails loudly instead of silently flowing an
// untyped shape to the client — and an upstream OUTAGE (transport error) is NOT
// collapsed into an empty catalog (the error propagates).

const addOnPriceSchema = z.object({
  currency: z.string(),
  price: z.string(),
});

const eligibilityInfoSchema = z.object({
  eligible: z.literal(true),
  activation: z.enum(['NOW', 'TERM_START']),
  // NULLABLE, because `RESET_TRAFFIC` grants nothing and so has no lifetime.
  // Left as a bare `z.string()` this schema would have REFUSED the whole
  // eligibility response the moment an operator created a reset add-on — and
  // the cabinet's options screen would have gone blank for every customer, not
  // just for the one add-on it could not read. This repository has paid for
  // that exact shape before, parsing a healthy panel's response with a schema
  // from the wrong era.
  expiresAt: z.string().nullable(),
  explanationCode: z.string(),
});

const eligibleAddOnSchema = z.object({
  id: z.string(),
  revision: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['EXTRA_TRAFFIC', 'EXTRA_DEVICES', 'RESET_TRAFFIC']),
  icon: z.string().nullable(),
  value: z.number(),
  lifetime: z.enum(['UNTIL_NEXT_RESET', 'UNTIL_SUBSCRIPTION_END']),
  eligibility: eligibilityInfoSchema,
  /**
   * `RESET_TRAFFIC` only; absent or null on every other type.
   *
   * Optional as well as nullable so a cabinet build can meet a backend that
   * predates the field — the two ship as separate images, and a required key
   * here would blank the screen against an older panel rather than simply
   * showing a price.
   */
  freeAllowance: z
    .object({
      freeUsesPerTerm: z.number(),
      freeRemaining: z.number(),
      isFree: z.boolean(),
    })
    .nullable()
    .optional(),
  prices: z.array(addOnPriceSchema),
});

const addOnEligibilityResultSchema = z.object({
  contractVersion: z.literal(2),
  availability: z.enum(['AVAILABLE', 'EMPTY']),
  target: z
    .object({ subscriptionId: z.string(), termId: z.string(), planId: z.string() })
    .nullable(),
  addOns: z.array(eligibleAddOnSchema),
});

export type AddOnEligibilityResult = z.infer<typeof addOnEligibilityResultSchema>;
export type EligibleAddOn = z.infer<typeof eligibleAddOnSchema>;

const checkoutResultSchema = z.object({
  paymentId: z.string(),
  transactionStatus: z.string(),
  gatewayType: z.string(),
  purchaseType: z.string(),
  amount: z.string(),
  currency: z.string(),
  checkoutUrl: z.string().nullable(),
  providerMode: z.string(),
  createdAt: z.string(),
});

export type AddOnCheckoutResult = z.infer<typeof checkoutResultSchema>;

export interface AddOnPurchaseInput {
  readonly identity: UserIdentity;
  readonly addOnId: string;
  readonly subscriptionId: string;
  readonly gatewayType: string;
  readonly channel?: string;
  readonly successUrl?: string | null;
  readonly failUrl?: string | null;
  /** v2: pinned catalog revision — a stale composition is rejected upstream. */
  readonly expectedAddOnRevision?: number;
  /** v2: per-intent idempotency key forwarded to the upstream checkout. */
  readonly idempotencyKey?: string;
  /** v2: contract version the client composed against. */
  readonly contractVersion?: number;
}

export class AddOnsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Active add-ons applicable to a given plan (empty `applicablePlanIds`
   * upstream means "all plans"). Used by the purchase flow.
   */
  listForPlan(planId: string): Promise<readonly AddOn[]> {
    return this.transport.request<readonly AddOn[]>(
      'GET',
      `/api/internal/add-ons/plan/${encodeURIComponent(planId)}`,
    );
  }

  /**
   * v2 subscription-scoped eligibility. The backend is the authority: it
   * computes eligibility against the subscription's active term baseline and
   * returns only eligible add-ons with server-resolved prices. The response is
   * runtime-validated; a transport error (upstream outage) propagates and is
   * never masked as an empty catalog.
   *
   * The caller identity is forwarded so the backend can scope the subscription
   * to its owner (a foreign subscriptionId resolves to a 404, never another
   * user's eligibility).
   */
  async listForSubscription(
    subscriptionId: string,
    identity?: UserIdentity,
  ): Promise<AddOnEligibilityResult> {
    const params = new URLSearchParams();
    if (typeof identity?.userId === 'string' && identity.userId.length > 0) {
      params.set('userId', identity.userId);
    }
    if (typeof identity?.telegramId === 'string' && identity.telegramId.length > 0) {
      params.set('telegramId', identity.telegramId);
    }
    const query = params.toString();
    const raw = await this.transport.request<unknown>(
      'GET',
      `/api/internal/add-ons/subscriptions/${encodeURIComponent(subscriptionId)}${
        query.length > 0 ? `?${query}` : ''
      }`,
    );
    return addOnEligibilityResultSchema.parse(raw);
  }

  /**
   * Takes a FREE traffic reset from the subscription's allowance.
   *
   * Not a checkout, and deliberately a different call: a free reset mints no
   * transaction, chooses no gateway and settles nothing. The backend re-checks
   * the allowance itself — the offer's `freeAllowance` is what the screen shows,
   * never what it decides, so two open tabs cannot each spend the last free use.
   */
  async claimFreeTrafficReset(
    subscriptionId: string,
    addOnId: string,
  ): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
    const raw = await this.transport.request<unknown>(
      'POST',
      `/api/internal/add-ons/subscriptions/${encodeURIComponent(subscriptionId)}/reset-traffic`,
      { addOnId },
    );
    const body = (raw ?? {}) as Record<string, unknown>;
    return {
      ok: body.ok === true,
      reason: typeof body.reason === 'string' ? body.reason : null,
    };
  }

  /**
   * Creates a checkout for an extra-traffic / extra-devices top-up on an
   * existing subscription. Returns the runtime-validated provider checkout
   * payload. The client never asserts price/eligibility — those are resolved
   * upstream; the client only forwards its selection + a per-intent
   * idempotency key.
   */
  async purchase(input: AddOnPurchaseInput): Promise<AddOnCheckoutResult> {
    const payload: Record<string, unknown> = {
      addOnId: input.addOnId,
      subscriptionId: input.subscriptionId,
      gatewayType: input.gatewayType,
    };
    if (typeof input.identity.userId === 'string' && input.identity.userId.length > 0) {
      payload['userId'] = input.identity.userId;
    }
    if (typeof input.identity.telegramId === 'string' && input.identity.telegramId.length > 0) {
      payload['telegramId'] = input.identity.telegramId;
    }
    if (input.channel) payload['channel'] = input.channel;
    if (input.successUrl) payload['successUrl'] = input.successUrl;
    if (input.failUrl) payload['failUrl'] = input.failUrl;
    if (typeof input.expectedAddOnRevision === 'number') {
      payload['expectedAddOnRevision'] = input.expectedAddOnRevision;
    }
    if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
      payload['idempotencyKey'] = input.idempotencyKey;
    }
    if (typeof input.contractVersion === 'number') {
      payload['contractVersion'] = input.contractVersion;
    }
    const raw = await this.transport.request<unknown>(
      'POST',
      '/api/internal/add-ons/purchase',
      payload,
    );
    return checkoutResultSchema.parse(raw);
  }
}

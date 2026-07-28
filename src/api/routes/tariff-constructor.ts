import { Router } from 'express';
import { z } from 'zod';

import type { AdminClient } from '../../lib/admin-client.js';
import type { ReiwaConfig } from '../../config.js';
import type { SessionStore } from '../../lib/session-store.js';
import { UpstreamError } from '../../core/errors/upstream-error.js';
import { buildPaymentReturnUrl } from '../../lib/payment-return-url.js';
import { requireMode } from '../middleware/access-mode.js';
import { createFlexibleSessionMiddleware, type AuthRequest } from '../middleware/session.js';
import { resolveUserIdentity } from '../middleware/user-identity.js';
import { sendSafeError } from '../lib/error-response.js';
import { describeUpstreamError, isUpstreamStatus } from '../lib/upstream-error.js';

const quoteRequestSchema = z.strictObject({
  revisionId: z.string().min(1),
  durationDays: z.number().int().positive(),
  currency: z.string().min(1),
  selections: z.array(z.strictObject({
    type: z.enum(['TRAFFIC', 'DEVICES']),
    value: z.number().int().nonnegative(),
  })),
});

const checkoutRequestSchema = quoteRequestSchema.extend({
  gatewayType: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  expectedAmount: z.string().regex(/^\d+(?:\.\d+)?$/),
  expectedCurrency: z.string().min(1),
  source: z.enum(['tma', 'web']),
});

function sendConstructorError(req: Parameters<typeof sendSafeError>[0], res: Parameters<typeof sendSafeError>[1], error: unknown): void {
  if (isUpstreamStatus(error, 404)) {
    res.status(404).json({ code: 'disabled', message: 'Tariff constructor is disabled' });
    return;
  }
  const code = extractConstructorErrorCode(error);
  const mapped = code ? CONSTRUCTOR_ERRORS[code] : undefined;
  if (mapped) {
    res.status(mapped.status).json({ code: mapped.publicCode, message: mapped.message });
    return;
  }
  if (isUpstreamStatus(error, 422)) {
    res.status(422).json({ code: 'unavailable', message: 'Selection is unavailable' });
    return;
  }
  sendSafeError(req, res, error, 502, 'Tariff constructor temporarily unavailable', 'tariff-constructor');
}

const CONSTRUCTOR_ERRORS: Record<string, { status: number; publicCode: string; message: string }> = {
  TARIFF_CONSTRUCTOR_REVISION_MISMATCH: { status: 409, publicCode: 'QUOTE_CHANGED', message: 'Tariff quote changed' },
  TARIFF_CONSTRUCTOR_QUOTE_MISMATCH: { status: 409, publicCode: 'QUOTE_CHANGED', message: 'Tariff quote changed' },
  QUOTE_CHANGED: { status: 409, publicCode: 'QUOTE_CHANGED', message: 'Tariff quote changed' },
  IDEMPOTENCY_KEY_CONFLICT: { status: 409, publicCode: 'IDEMPOTENCY_KEY_CONFLICT', message: 'This retry key belongs to a different checkout' },
  PROVIDER_CHECKOUT_CREATION_UNRESOLVED: { status: 502, publicCode: 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED', message: 'Payment creation status is unresolved. Check payment status before retrying.' },
  SUBSCRIPTION_LIMIT_REACHED: { status: 400, publicCode: 'SUBSCRIPTION_LIMIT_REACHED', message: 'Subscription limit reached' },
};

export function extractConstructorErrorCode(error: unknown): string | null {
  const body = error instanceof UpstreamError ? error.body : describeUpstreamError(error).message;
  try {
    const payload = JSON.parse(body) as { code?: unknown; errorCode?: unknown; message?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.errorCode === 'string') return payload.errorCode;
    if (payload.message !== null && typeof payload.message === 'object' && typeof (payload.message as { code?: unknown }).code === 'string') return (payload.message as { code: string }).code;
  } catch {
    return /subscription limit reached|maximum number of active subscriptions/i.test(body) ? 'SUBSCRIPTION_LIMIT_REACHED' : null;
  }
  return null;
}

export function createTariffConstructorRouter(deps: { adminClient: AdminClient | null; sessionStore: SessionStore | null; config: ReiwaConfig }) {
  const router = Router();
  const requireSession = createFlexibleSessionMiddleware(deps.sessionStore);

  router.get('/tariff-constructor', async (req, res) => {
    if (!deps.adminClient) {
      res.status(503).json({ code: 'unavailable', message: 'Tariff constructor unavailable' });
      return;
    }
    try {
      res.json(await deps.adminClient.tariffConstructor.getManifest());
    } catch (error: unknown) {
      sendConstructorError(req, res, error);
    }
  });

  router.post('/tariff-constructor/quote', async (req, res) => {
    if (!deps.adminClient) {
      res.status(503).json({ code: 'unavailable', message: 'Tariff constructor unavailable' });
      return;
    }
    const parsed = quoteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'invalid_request', message: 'Invalid quote request' });
      return;
    }
    try {
      res.json(await deps.adminClient.tariffConstructor.quote(parsed.data));
    } catch (error: unknown) {
      sendConstructorError(req, res, error);
    }
  });

  router.post('/tariff-constructor/checkout', requireSession, requireMode('purchase.new'), async (req: AuthRequest, res) => {
    const parsed = checkoutRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ code: 'invalid_request', message: 'Invalid checkout request' });
      return;
    }
    if (!deps.adminClient) {
      res.status(503).json({ code: 'unavailable', message: 'Tariff constructor unavailable' });
      return;
    }
    const returnContext = parsed.data.source === 'tma' ? 'tma' : req.context ?? 'web';
    const returnUrl = buildPaymentReturnUrl({ context: returnContext, config: deps.config });
    if (!returnUrl || !/^https?:\/\//i.test(returnUrl)) {
      res.status(503).json({ code: 'unavailable', message: 'Payment return URL unavailable' });
      return;
    }
    try {
      const identity = resolveUserIdentity(req);
      const rawPolicy = await deps.adminClient.subscription.getActionPolicy(identity);
      const policy = rawPolicy !== null && typeof rawPolicy === 'object' ? rawPolicy as Record<string, unknown> : {};
      const count = typeof policy.activeSubscriptionCount === 'number' ? Math.max(0, Math.floor(policy.activeSubscriptionCount)) : 0;
      const max = typeof policy.maxSubscriptions === 'number' ? Math.max(1, Math.floor(policy.maxSubscriptions)) : 1;
      const limitWarning = Array.isArray(policy.warnings) && policy.warnings.some((warning) => warning !== null && typeof warning === 'object' && (warning as { code?: unknown }).code === 'SUBSCRIPTION_LIMIT_REACHED');
      if (limitWarning || count >= max) {
        res.status(400).json({ code: 'SUBSCRIPTION_LIMIT_REACHED', message: 'Subscription limit reached' });
        return;
      }
      res.json(await deps.adminClient.tariffConstructor.checkout(identity, {
        ...parsed.data,
        purchaseType: count > 0 ? 'ADDITIONAL' : 'NEW',
        channel: req.context === 'tma' ? 'TELEGRAM' : 'WEB',
        successUrl: returnUrl,
        failUrl: returnUrl,
      }));
    } catch (error: unknown) {
      sendConstructorError(req, res, error);
    }
  });

  return router;
}

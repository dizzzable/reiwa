import http from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { UpstreamError } from '../../src/core/errors/upstream-error.js';
import { createTariffConstructorRouter, extractConstructorErrorCode } from '../../src/api/routes/tariff-constructor.js';

const config = { REIWA_DOMAIN: 'https://reiwa.example', BOT_USERNAME: 'reiwa_test_bot' } as never;
const validBody = {
  revisionId: 'revision-1', durationDays: 30, currency: 'RUB',
  selections: [{ type: 'TRAFFIC', value: 100 }], gatewayType: 'YOOKASSA',
  idempotencyKey: 'attempt-1', expectedAmount: '499.00', expectedCurrency: 'RUB',
  source: 'web',
};
const checkoutResult = {
  paymentId: 'payment-1', transactionStatus: 'PENDING', gatewayType: 'YOOKASSA',
  purchaseType: 'NEW', amount: '499.00', currency: 'RUB', checkoutUrl: 'https://pay.example/1',
  providerMode: 'REDIRECT', createdAt: '2026-07-28T00:00:00.000Z',
};

function appWith(input: { count?: number; max?: number; warnings?: unknown[]; checkout?: ReturnType<typeof vi.fn> }) {
  const checkout = input.checkout ?? vi.fn().mockResolvedValue(checkoutResult);
  const getActionPolicy = vi.fn().mockResolvedValue({ activeSubscriptionCount: input.count ?? 0, maxSubscriptions: input.max ?? 3, warnings: input.warnings ?? [] });
  const app = express();
  app.locals.adminClient = null;
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as express.Request & { webSession?: { userId: string } }).webSession = { userId: 'server-user' };
    next();
  });
  app.use(createTariffConstructorRouter({ adminClient: { subscription: { getActionPolicy }, tariffConstructor: { checkout } } as never, sessionStore: null, config }));
  return { app, checkout, getActionPolicy };
}

async function post(app: express.Express, body: unknown, context?: 'tma'): Promise<{ status: number; body: Record<string, unknown> }> {
  if (context) app.use((_req, _res, next) => next());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port: address.port, path: '/tariff-constructor/checkout', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...(context ? { 'x-telegram-init-data': 'test' } : {}) } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { server.close(); resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }); });
    });
    request.on('error', reject); request.end(raw);
  });
}

describe('tariff constructor checkout BFF contract', () => {
  it.each(['userId', 'telegramId', 'purchaseType', 'channel', 'successUrl', 'failUrl', 'savedPaymentMethodId', 'savePaymentMethod', 'savePaymentMethodConsent'])('rejects client-controlled %s', async (field) => {
    const deps = appWith({});
    const response = await post(deps.app, { ...validBody, [field]: 'malicious' });
    expect(response.status).toBe(400);
    expect(deps.checkout).not.toHaveBeenCalled();
  });

  it('uses the Mini App hint only for return URL, not the trusted payment channel', async () => {
    const deps = appWith({});
    const response = await post(deps.app, { ...validBody, source: 'tma' });
    expect(response.status).toBe(200);
    expect(deps.checkout).toHaveBeenCalledWith({ userId: 'server-user' }, expect.objectContaining({
      channel: 'WEB', successUrl: 'https://t.me/reiwa_test_bot?start=payment_return', failUrl: 'https://t.me/reiwa_test_bot?start=payment_return',
    }));
  });

  it.each([[0, 'NEW'], [2, 'ADDITIONAL']] as const)('derives identity, purchase type, channel, URLs and forwards quote pins for count %i', async (count, purchaseType) => {
    const deps = appWith({ count });
    const response = await post(deps.app, validBody);
    expect(response.status).toBe(200);
    expect(deps.getActionPolicy).toHaveBeenCalledWith({ userId: 'server-user' });
    expect(deps.checkout).toHaveBeenCalledWith({ userId: 'server-user' }, expect.objectContaining({
      revisionId: 'revision-1', durationDays: 30, currency: 'RUB', selections: validBody.selections,
      gatewayType: 'YOOKASSA', idempotencyKey: 'attempt-1', expectedAmount: '499.00', expectedCurrency: 'RUB',
      purchaseType, channel: 'WEB', successUrl: 'https://reiwa.example/payment-return', failUrl: 'https://reiwa.example/payment-return',
    }));
  });

  it('blocks at capacity before checkout', async () => {
    const deps = appWith({ count: 3, max: 3 });
    const response = await post(deps.app, validBody);
    expect(response).toMatchObject({ status: 400, body: { code: 'SUBSCRIPTION_LIMIT_REACHED' } });
    expect(deps.checkout).not.toHaveBeenCalled();
  });

  it.each([
    ['TARIFF_CONSTRUCTOR_REVISION_MISMATCH', 409, 'QUOTE_CHANGED'],
    ['TARIFF_CONSTRUCTOR_QUOTE_MISMATCH', 409, 'QUOTE_CHANGED'],
    ['IDEMPOTENCY_KEY_CONFLICT', 409, 'IDEMPOTENCY_KEY_CONFLICT'],
    ['PROVIDER_CHECKOUT_CREATION_UNRESOLVED', 502, 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED'],
    ['SUBSCRIPTION_LIMIT_REACHED', 400, 'SUBSCRIPTION_LIMIT_REACHED'],
  ] as const)('maps %s safely', async (code, status, publicCode) => {
    const checkout = vi.fn().mockRejectedValue(new UpstreamError('POST', '/checkout', status, JSON.stringify({ errorCode: code })));
    const response = await post(appWith({ checkout }).app, validBody);
    expect(response).toMatchObject({ status, body: { code: publicCode } });
  });

  it('parses top-level, errorCode and nested Nest codes without guessing', () => {
    expect(extractConstructorErrorCode(new UpstreamError('POST', '/checkout', 409, '{"code":"QUOTE_CHANGED"}'))).toBe('QUOTE_CHANGED');
    expect(extractConstructorErrorCode(new UpstreamError('POST', '/checkout', 409, '{"errorCode":"IDEMPOTENCY_KEY_CONFLICT"}'))).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(extractConstructorErrorCode(new UpstreamError('POST', '/checkout', 409, '{"message":{"code":"QUOTE_CHANGED"}}'))).toBe('QUOTE_CHANGED');
    expect(extractConstructorErrorCode(new UpstreamError('POST', '/checkout', 409, '{"message":{"code":"TARIFF_CONSTRUCTOR_QUOTE_MISMATCH"}}'))).toBe('TARIFF_CONSTRUCTOR_QUOTE_MISMATCH');
    expect(extractConstructorErrorCode(new UpstreamError('POST', '/checkout', 409, '{}'))).toBeNull();
  });
});

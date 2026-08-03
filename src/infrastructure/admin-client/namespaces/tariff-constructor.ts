import { z } from 'zod';

import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

const decimalString = z.string().regex(/^\d+(?:\.\d+)?$/);
const currency = z.string().min(1);
const moduleType = z.enum(['TRAFFIC', 'DEVICES']);

export const tariffConstructorManifestSchema = z.strictObject({
  contractVersion: z.literal(1),
  revisionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  durations: z.array(z.strictObject({
    days: z.number().int().positive(),
    currency,
    baseAmount: decimalString,
  })).min(1),
  modules: z.array(z.strictObject({
    type: moduleType,
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    defaultValue: z.number().int().nonnegative(),
    step: z.number().int().positive(),
    prices: z.array(z.strictObject({
      days: z.number().int().positive(),
      currency,
      perStepAmount: decimalString,
    })),
  })),
});

export const tariffConstructorQuoteInputSchema = z.strictObject({
  revisionId: z.string().min(1),
  durationDays: z.number().int().positive(),
  currency,
  selections: z.array(z.strictObject({
    type: moduleType,
    value: z.number().int().nonnegative(),
  })),
});

export const tariffConstructorQuoteSchema = z.strictObject({
  contractVersion: z.literal(1),
  revisionId: z.string().min(1),
  durationDays: z.number().int().positive(),
  currency,
  lines: z.array(z.strictObject({
    kind: z.enum(['BASE', 'MODULE']),
    module: moduleType.optional(),
    value: z.number().int().nonnegative().optional(),
    steps: z.number().int().nonnegative().optional(),
    perStepAmount: decimalString.optional(),
    amount: decimalString,
  })),
  total: decimalString,
});

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
});

export const tariffConstructorCheckoutInputSchema = tariffConstructorQuoteInputSchema.extend({
  userId: z.string().min(1).optional(),
  telegramId: z.string().min(1).optional(),
  purchaseType: z.enum(['NEW', 'ADDITIONAL']),
  gatewayType: z.string().min(1),
  channel: z.enum(['WEB', 'TELEGRAM']),
  idempotencyKey: z.string().min(1).max(128),
  expectedAmount: decimalString,
  expectedCurrency: currency,
  successUrl: httpUrl,
  failUrl: httpUrl,
  savedPaymentMethodId: z.string().min(1).optional(),
  savePaymentMethod: z.boolean().optional(),
  savePaymentMethodConsent: z.boolean().optional(),
});

export const tariffConstructorCheckoutSchema = z.strictObject({
  paymentId: z.string().min(1),
  transactionStatus: z.enum(['PENDING', 'COMPLETED', 'CANCELED', 'FAILED']),
  gatewayType: z.string().min(1),
  purchaseType: z.enum(['NEW', 'ADDITIONAL']),
  amount: decimalString,
  currency,
  checkoutUrl: z.url().nullable(),
  providerMode: z.enum([
    'REDIRECT',
    'TELEGRAM_INVOICE',
    'IMMEDIATE',
    'NONE',
    'INVOICE',
    'EMBEDDED',
    'SAVED_METHOD',
  ]),
  createdAt: z.iso.datetime(),
});

export type TariffConstructorManifest = z.infer<typeof tariffConstructorManifestSchema>;
export type TariffConstructorQuoteInput = z.infer<typeof tariffConstructorQuoteInputSchema>;
export type TariffConstructorQuote = z.infer<typeof tariffConstructorQuoteSchema>;
export type TariffConstructorCheckoutInput = z.infer<typeof tariffConstructorCheckoutInputSchema>;
export type TariffConstructorCheckout = z.infer<typeof tariffConstructorCheckoutSchema>;

export class TariffConstructorNamespace {
  constructor(private readonly transport: AdminTransport) {}

  async getManifest(): Promise<TariffConstructorManifest> {
    const payload = await this.transport.request<unknown>('GET', '/api/internal/tariff-constructor/manifest');
    return tariffConstructorManifestSchema.parse(payload);
  }

  async quote(input: TariffConstructorQuoteInput): Promise<TariffConstructorQuote> {
    const body = tariffConstructorQuoteInputSchema.parse(input);
    const payload = await this.transport.request<unknown>('POST', '/api/internal/tariff-constructor/quote', body);
    return tariffConstructorQuoteSchema.parse(payload);
  }

  async checkout(
    identity: UserIdentity,
    input: Omit<TariffConstructorCheckoutInput, 'userId' | 'telegramId'>,
  ): Promise<TariffConstructorCheckout> {
    const payload = tariffConstructorCheckoutInputSchema.parse({
      ...input,
      ...(typeof identity.userId === 'string' && identity.userId.length > 0 ? { userId: identity.userId } : {}),
      ...(typeof identity.telegramId === 'string' && identity.telegramId.length > 0 ? { telegramId: identity.telegramId } : {}),
    });
    const response = await this.transport.request<unknown>('POST', '/api/internal/tariff-constructor/checkout', payload);
    return tariffConstructorCheckoutSchema.parse(response);
  }
}

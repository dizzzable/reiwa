import { z } from 'zod';

import type { AdminTransport } from '../transport.js';

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

export type TariffConstructorManifest = z.infer<typeof tariffConstructorManifestSchema>;
export type TariffConstructorQuoteInput = z.infer<typeof tariffConstructorQuoteInputSchema>;
export type TariffConstructorQuote = z.infer<typeof tariffConstructorQuoteSchema>;

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
}

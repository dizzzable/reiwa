import { apiClient } from './transport.js';
import type { CheckoutResult } from '@/types/api';
import { getClientSource } from '@/lib/client-source';

export type TariffModuleType = 'TRAFFIC' | 'DEVICES';

export interface TariffConstructorManifest {
  contractVersion: 1;
  revisionId: string;
  revision: number;
  durations: Array<{ days: number; currency: string; baseAmount: string }>;
  modules: Array<{
    type: TariffModuleType;
    min: number;
    max: number;
    defaultValue: number;
    step: number;
    prices: Array<{ days: number; currency: string; perStepAmount: string }>;
  }>;
}

export interface TariffConstructorQuoteRequest {
  revisionId: string;
  durationDays: number;
  currency: string;
  selections: Array<{ type: TariffModuleType; value: number }>;
}

export interface TariffConstructorQuote {
  contractVersion: 1;
  revisionId: string;
  durationDays: number;
  currency: string;
  lines: Array<{
    kind: 'BASE' | 'MODULE';
    module?: TariffModuleType;
    value?: number;
    steps?: number;
    perStepAmount?: string;
    amount: string;
  }>;
  total: string;
}

export const getTariffConstructorManifest = () =>
  apiClient.get<TariffConstructorManifest>('/tariff-constructor').then((response) => response.data);

export const getTariffConstructorQuote = (request: TariffConstructorQuoteRequest) =>
  apiClient.post<TariffConstructorQuote>('/tariff-constructor/quote', request).then((response) => response.data);

export interface TariffConstructorCheckoutRequest extends TariffConstructorQuoteRequest {
  gatewayType: string;
  idempotencyKey: string;
  expectedAmount: string;
  expectedCurrency: string;
}

export const createTariffConstructorCheckout = (request: TariffConstructorCheckoutRequest) =>
  apiClient.post<CheckoutResult>('/tariff-constructor/checkout', { ...request, source: getClientSource() }).then((response) => response.data);

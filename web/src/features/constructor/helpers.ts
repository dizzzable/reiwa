import type { TariffConstructorManifest, TariffConstructorQuoteRequest } from '@/lib/api-client';

export function quoteCompositionKey(request: TariffConstructorQuoteRequest, gatewayType = ''): string {
  return JSON.stringify({
    revisionId: request.revisionId,
    durationDays: request.durationDays,
    currency: request.currency,
    selections: request.selections.map(({ type, value }) => ({ type, value })),
    gatewayType,
  });
}

export function resolveCheckoutAttempt(previous: { compositionKey: string; idempotencyKey: string } | undefined, request: TariffConstructorQuoteRequest, createId: () => string, gatewayType = ''): { compositionKey: string; idempotencyKey: string } {
  const compositionKey = quoteCompositionKey(request, gatewayType);
  return previous?.compositionKey === compositionKey ? previous : { compositionKey, idempotencyKey: createId() };
}

export function reconcileQuoteRequest(previous: TariffConstructorQuoteRequest, manifest: TariffConstructorManifest): { request: TariffConstructorQuoteRequest; changed: boolean } {
  if (previous.revisionId === manifest.revisionId) return { request: previous, changed: false };
  const duration = manifest.durations.find((item) => item.days === previous.durationDays && item.currency === previous.currency) ?? manifest.durations[0];
  if (!duration) throw new Error('Manifest has no durations');
  const selections = manifest.modules.map((module) => {
    const oldValue = previous.selections.find((selection) => selection.type === module.type)?.value ?? module.defaultValue;
    const clamped = Math.min(module.max, Math.max(module.min, oldValue));
    const value = module.min + Math.round((clamped - module.min) / module.step) * module.step;
    return { type: module.type, value: Math.min(module.max, Math.max(module.min, value)) };
  });
  return { request: { revisionId: manifest.revisionId, durationDays: duration.days, currency: duration.currency, selections }, changed: true };
}

export interface CheckoutAttemptStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface CheckoutAttempt { compositionKey: string; idempotencyKey: string }
const ATTEMPT_KEY = 'reiwa:tariff-constructor:checkout-attempt';

export function loadCheckoutAttempt(storage: CheckoutAttemptStorage, request: TariffConstructorQuoteRequest, gatewayType = ''): CheckoutAttempt | undefined {
  try {
    const parsed = JSON.parse(storage.getItem(ATTEMPT_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = parsed as Record<string, unknown>;
    return value.compositionKey === quoteCompositionKey(request, gatewayType) && typeof value.idempotencyKey === 'string' && value.idempotencyKey.length > 0 && value.idempotencyKey.length <= 128
      ? { compositionKey: value.compositionKey, idempotencyKey: value.idempotencyKey }
      : undefined;
  } catch { return undefined; }
}

export function saveCheckoutAttempt(storage: CheckoutAttemptStorage, attempt: CheckoutAttempt): void {
  try { storage.setItem(ATTEMPT_KEY, JSON.stringify(attempt)); } catch { /* best effort */ }
}

export function clearCheckoutAttempt(storage: CheckoutAttemptStorage): void {
  try { storage.removeItem(ATTEMPT_KEY); } catch { /* best effort */ }
}

export function initialQuoteRequest(manifest: TariffConstructorManifest): TariffConstructorQuoteRequest {
  const duration = manifest.durations[0];
  if (!duration) throw new Error('Manifest has no durations');
  return {
    revisionId: manifest.revisionId,
    durationDays: duration.days,
    currency: duration.currency,
    selections: manifest.modules.map((module) => ({ type: module.type, value: module.defaultValue })),
  };
}

export function updateSelection(request: TariffConstructorQuoteRequest, type: TariffConstructorQuoteRequest['selections'][number]['type'], value: number): TariffConstructorQuoteRequest {
  return { ...request, selections: request.selections.map((selection) => selection.type === type ? { ...selection, value } : selection) };
}

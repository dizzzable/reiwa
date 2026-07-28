import type { TariffConstructorManifest, TariffConstructorQuoteRequest } from '@/lib/api-client';

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

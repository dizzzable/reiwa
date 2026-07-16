/**
 * Shared helpers for saved payment method UI labels.
 * Kept tiny so purchase/renewal pickers don't reimplement card formatting.
 */
import type { TFunction } from 'i18next';
import type { SavedPaymentMethod } from '@/lib/api-client/payment-methods';

export function formatSavedPaymentMethodTitle(
  method: Pick<SavedPaymentMethod, 'title' | 'methodType'>,
  t: TFunction,
): string {
  if (typeof method.title === 'string' && method.title.trim().length > 0) {
    return method.title.trim();
  }
  const typeKey = `paymentMethods.types.${method.methodType}`;
  const typeLabel = t(typeKey);
  return typeLabel === typeKey ? t('paymentMethods.fallbackTitle') : typeLabel;
}

export function formatSavedPaymentMethodMeta(
  method: Pick<
    SavedPaymentMethod,
    'methodType' | 'cardExpiryMonth' | 'cardExpiryYear' | 'gatewayType'
  >,
  t: TFunction,
): string {
  const parts: string[] = [];
  const typeKey = `paymentMethods.types.${method.methodType}`;
  const typeLabel = t(typeKey);
  parts.push(typeLabel === typeKey ? method.methodType : typeLabel);
  if (method.cardExpiryMonth && method.cardExpiryYear) {
    parts.push(
      t('paymentMethods.expires', {
        month: method.cardExpiryMonth.padStart(2, '0'),
        year: method.cardExpiryYear.slice(-2),
      }),
    );
  }
  return parts.join(' · ');
}

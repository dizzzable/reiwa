/**
 * PaymentMethodsPage
 * ──────────────────
 * Self-service list + unbind for provider-saved payment methods
 * (YooKassa cards / wallets used for autopayments).
 *
 * Support requirement: the buyer must be able to detach a card without
 * contacting support. Unbind is local soft-deactivate on the panel side —
 * YooKassa has no merchant "delete card" API.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CreditCard, Trash2, Unlink } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';

import { getPaymentMethods, unbindPaymentMethod } from '@/lib/api-client';
import { BackButton } from '@/components/ui/back-button';
import { Skeleton } from '@/components/ui/skeleton';
import { StadiumButton } from '@/components/ui/stadium-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function PaymentMethodsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [unbindId, setUnbindId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: getPaymentMethods,
    staleTime: 15_000,
    retry: false,
  });

  const methods = data?.methods ?? [];

  const unbindMutation = useMutation({
    mutationFn: (methodId: string) => unbindPaymentMethod(methodId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success(t('paymentMethods.unbound'));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    },
    onError: () => toast.error(t('paymentMethods.error')),
    onSettled: () => setUnbindId(null),
  });

  return (
    <div className="min-h-full pb-6">
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings" label={t('common.back')} />
        <h1 className="text-lg font-semibold">{t('settings.paymentMethods')}</h1>
      </div>

      <div className="mx-5 mb-4 rounded-2xl border border-white/6 bg-white/2 p-3.5">
        <p className="text-xs leading-relaxed text-zinc-400">
          {t('paymentMethods.hint')}
        </p>
      </div>

      <div className="mx-5">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : methods.length === 0 ? (
          <div className="rounded-2xl border border-white/6 bg-white/2 p-8 text-center">
            <CreditCard className="mx-auto h-8 w-8 text-zinc-600" />
            <p className="mt-2 text-sm text-zinc-400">{t('paymentMethods.empty')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {methods.map((method, i) => (
              <motion.div
                key={method.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="flex items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-3.5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10">
                  <CreditCard className="h-4 w-4 text-violet-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-200">
                    {method.title || t('paymentMethods.fallbackTitle')}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {formatMethodMeta(method, t)}
                  </p>
                </div>
                <StadiumButton
                  type="button"
                  variant="ghost"
                  className="h-9 shrink-0 px-3 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  onClick={() => setUnbindId(method.id)}
                  disabled={unbindMutation.isPending && unbindId === method.id}
                  aria-label={t('paymentMethods.unbind')}
                >
                  <Trash2 className="h-4 w-4" />
                </StadiumButton>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={unbindId !== null}
        onOpenChange={(open) => {
          if (!open && !unbindMutation.isPending) setUnbindId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Unlink className="h-5 w-5 text-red-400" />
              {t('paymentMethods.unbindTitle')}
            </DialogTitle>
            <DialogDescription>{t('paymentMethods.unbindConfirm')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex gap-2">
            <StadiumButton
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => setUnbindId(null)}
              disabled={unbindMutation.isPending}
            >
              {t('common.cancel')}
            </StadiumButton>
            <StadiumButton
              type="button"
              className="flex-1 bg-red-500/90 text-white hover:bg-red-500"
              disabled={unbindMutation.isPending || unbindId === null}
              onClick={() => {
                if (unbindId) unbindMutation.mutate(unbindId);
              }}
            >
              {unbindMutation.isPending
                ? t('paymentMethods.unbinding')
                : t('paymentMethods.unbind')}
            </StadiumButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatMethodMeta(
  method: {
    methodType: string;
    cardExpiryMonth: string | null;
    cardExpiryYear: string | null;
    gatewayType: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string,
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

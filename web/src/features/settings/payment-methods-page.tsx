/**
 * PaymentMethodsPage
 * ──────────────────
 * Self-service list + unbind + autopay toggle for provider-saved payment methods
 * (YooKassa cards / wallets used for autopayments).
 *
 * Support requirement: the buyer must be able to detach a card without
 * contacting support. Unbind is local soft-deactivate on the panel side —
 * YooKassa has no merchant "delete card" API.
 *
 * Autopay can also be disabled without unbinding: the card stays listed and
 * can be re-enabled later; off-session charge is blocked while disabled.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CreditCard, Trash2, Unlink } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';

import {
  getPaymentMethods,
  setPaymentMethodAutopay,
  unbindPaymentMethod,
  type SavedPaymentMethod,
} from '@/lib/api-client';
import { BackButton } from '@/components/ui/back-button';
import { Skeleton } from '@/components/ui/skeleton';
import { StadiumButton } from '@/components/ui/stadium-button';
import { Switch } from '@/components/ui/switch';
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

  const autopayMutation = useMutation({
    mutationFn: ({ methodId, autopayEnabled }: { methodId: string; autopayEnabled: boolean }) =>
      setPaymentMethodAutopay(methodId, autopayEnabled),
    onMutate: async ({ methodId, autopayEnabled }) => {
      await queryClient.cancelQueries({ queryKey: ['payment-methods'] });
      const previous = queryClient.getQueryData<{ methods: SavedPaymentMethod[]; total: number }>([
        'payment-methods',
      ]);
      if (previous) {
        queryClient.setQueryData(['payment-methods'], {
          ...previous,
          methods: previous.methods.map((m) =>
            m.id === methodId ? { ...m, autopayEnabled } : m,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(['payment-methods'], ctx.previous);
      }
      toast.error(t('paymentMethods.autopayError'));
    },
    onSuccess: (result) => {
      toast.success(
        result.autopayEnabled
          ? t('paymentMethods.autopayEnabled')
          : t('paymentMethods.autopayDisabled'),
      );
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
    },
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
            {methods.map((method, i) => {
              const autopayOn = method.autopayEnabled !== false;
              const busy =
                (unbindMutation.isPending && unbindMutation.variables === method.id) ||
                (autopayMutation.isPending && autopayMutation.variables?.methodId === method.id);

              return (
                <motion.div
                  key={method.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="rounded-2xl border border-white/6 bg-white/2 p-3.5"
                >
                  <div className="flex items-center gap-3">
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
                    <button
                      type="button"
                      aria-label={t('paymentMethods.unbind')}
                      disabled={busy}
                      onClick={() => setUnbindId(method.id)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/5 pt-3">
                    <div className="min-w-0">
                      <p className="text-sm text-zinc-200">{t('paymentMethods.autopay')}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
                        {autopayOn
                          ? t('paymentMethods.autopayOnHint')
                          : t('paymentMethods.autopayOffHint')}
                      </p>
                    </div>
                    <Switch
                      checked={autopayOn}
                      disabled={busy}
                      onCheckedChange={(next) => {
                        if (next === autopayOn) return;
                        autopayMutation.mutate({ methodId: method.id, autopayEnabled: next });
                      }}
                    />
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={unbindId !== null} onOpenChange={(open) => !open && setUnbindId(null)}>
        <DialogContent className="max-w-sm border-white/10 bg-zinc-900">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Unlink className="h-4 w-4 text-red-400" />
              {t('paymentMethods.unbindTitle')}
            </DialogTitle>
            <DialogDescription className="text-sm text-zinc-400">
              {t('paymentMethods.unbindConfirm')}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex gap-2">
            <StadiumButton
              variant="ghost"
              className="flex-1"
              onClick={() => setUnbindId(null)}
              disabled={unbindMutation.isPending}
            >
              {t('common.cancel')}
            </StadiumButton>
            <StadiumButton
              className="flex-1 bg-red-600 hover:bg-red-500"
              disabled={!unbindId || unbindMutation.isPending}
              onClick={() => unbindId && unbindMutation.mutate(unbindId)}
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
    cardLast4: string | null;
    cardExpiryMonth: string | null;
    cardExpiryYear: string | null;
  },
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  const typeLabel = t(`paymentMethods.types.${method.methodType}`, {
    defaultValue: t('paymentMethods.types.unknown'),
  });
  const parts = [typeLabel];
  if (method.cardLast4) {
    parts.push(`•••• ${method.cardLast4}`);
  }
  if (method.cardExpiryMonth && method.cardExpiryYear) {
    parts.push(
      t('paymentMethods.expires', {
        month: method.cardExpiryMonth,
        year: method.cardExpiryYear.slice(-2),
      }),
    );
  }
  return parts.join(' · ');
}

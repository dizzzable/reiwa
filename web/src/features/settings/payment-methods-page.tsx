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
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { CreditCard, Plus, ShieldCheck, Trash2, Unlink } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';

import {
  cancelProviderSubscription,
  getPaymentMethods,
  getPaymentMethodSetupStatus,
  startPaymentMethodSetup,
  setPaymentMethodAutopay,
  unbindPaymentMethod,
  type ProviderSubscription,
  type SavedPaymentMethod,
} from '@/lib/api-client';
import { formatDate } from '@/lib/utils';
import { AutopayGatewayMark } from '@/components/ui/gateway-icon';
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

/**
 * The panel refused the switch or «Отвязать» because a payment with this
 * method is being made right now (`SAVED_PAYMENT_METHOD_BUSY`, 409): nothing
 * changed, and the same action goes through in a minute. The switch goes back
 * to what the method really is, and the message says why.
 */
function isPaymentInProgress(error: unknown): boolean {
  const data = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data;
  return data?.code === 'SAVED_PAYMENT_METHOD_BUSY';
}

export default function PaymentMethodsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [unbindId, setUnbindId] = useState<string | null>(null);
  const [cancelSubscriptionId, setCancelSubscriptionId] = useState<string | null>(null);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupConsent, setSetupConsent] = useState(false);
  const completedSetupRef = useRef<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: getPaymentMethods,
    staleTime: 15_000,
    retry: false,
  });

  const methods = data?.methods ?? [];
  const providerSubscriptions = data?.providerSubscriptions ?? [];
  const setupId = searchParams.get('setupId');
  const canAddCard = data?.capabilities?.yookassaStandaloneSetup === true;

  const setupStatusQuery = useQuery({
    queryKey: ['payment-method-setup', setupId],
    queryFn: () => getPaymentMethodSetupStatus(setupId!),
    enabled: Boolean(setupId),
    retry: false,
    // Poll while the binding is pending. 3s pairs with the server-side refresh
    // throttle so we don't hammer YooKassa; the webhook/cron resolve it anyway
    // if the user leaves the page.
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? 3_000 : false,
  });

  useEffect(() => {
    const status = setupStatusQuery.data?.status;
    if (!setupId || !status || status === 'PENDING' || completedSetupRef.current === setupId) return;
    completedSetupRef.current = setupId;
    if (status === 'ACTIVE') {
      void queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success(t('paymentMethods.setupSuccess'));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    } else {
      toast.error(t('paymentMethods.setupFailed'));
    }
    searchParams.delete('setupId');
    setSearchParams(searchParams, { replace: true });
  }, [queryClient, searchParams, setSearchParams, setupId, setupStatusQuery.data?.status, t]);

  // Surface a failed status poll instead of leaving the "verifying" banner
  // hanging silently. React Query v5 has no `onError` on useQuery, so watch the
  // error and clear the param — the card may in fact be bound (webhook/cron will
  // reconcile it), so we tell the user to check back rather than claim failure.
  useEffect(() => {
    if (!setupId || !setupStatusQuery.isError || completedSetupRef.current === setupId) return;
    completedSetupRef.current = setupId;
    toast.error(t('paymentMethods.setupStatusUnavailable'));
    void queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
    searchParams.delete('setupId');
    setSearchParams(searchParams, { replace: true });
  }, [queryClient, searchParams, setSearchParams, setupId, setupStatusQuery.isError, t]);

  const setupMutation = useMutation({
    mutationFn: startPaymentMethodSetup,
    onSuccess: (setup) => {
      // Hosted YooKassa page keeps raw card data outside our PCI scope.
      window.location.assign(setup.checkoutUrl);
    },
    onError: () => toast.error(t('paymentMethods.setupError')),
  });

  const unbindMutation = useMutation({
    mutationFn: (methodId: string) => unbindPaymentMethod(methodId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success(t('paymentMethods.unbound'));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    },
    onError: (error) =>
      toast.error(isPaymentInProgress(error) ? t('paymentMethods.unbindBusy') : t('paymentMethods.error')),
    onSettled: () => setUnbindId(null),
  });

  const cancelSubscriptionMutation = useMutation({
    mutationFn: (subscriptionId: string) => cancelProviderSubscription(subscriptionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payment-methods'] });
      toast.success(t('paymentMethods.providerSubscriptions.cancelled'));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    },
    // Nothing was cancelled (the provider may be unreachable): the row stays,
    // and so does the button.
    onError: () => toast.error(t('paymentMethods.providerSubscriptions.cancelError')),
    onSettled: () => setCancelSubscriptionId(null),
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
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(['payment-methods'], ctx.previous);
      }
      toast.error(isPaymentInProgress(err) ? t('paymentMethods.autopayBusy') : t('paymentMethods.autopayError'));
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

      <div className="mx-5 mb-4 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3.5">
        <p className="text-xs leading-relaxed text-[var(--brand-muted-foreground)]">
          {t('paymentMethods.hint')}
        </p>
      </div>

      {canAddCard && (
        <div className="mx-5 mb-4 rounded-2xl border border-violet-400/15 bg-violet-500/5 p-3.5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15">
              <ShieldCheck className="h-4 w-4 text-violet-300" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-[var(--brand-foreground)]">{t('paymentMethods.setupTitle')}</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--brand-muted-foreground)]">{t('paymentMethods.setupHint')}</p>
            </div>
          </div>
          <StadiumButton
            className="mt-3 w-full"
            size="sm"
            icon={<Plus className="h-4 w-4" />}
            disabled={setupMutation.isPending}
            onClick={() => {
              setSetupConsent(false);
              setSetupDialogOpen(true);
            }}
          >
            {t('paymentMethods.addCard')}
          </StadiumButton>
        </div>
      )}

      {setupId && setupStatusQuery.data?.status === 'PENDING' && (
        <div className="mx-5 mb-4 rounded-2xl border border-amber-400/15 bg-amber-500/5 p-3 text-center text-xs text-amber-100">
          {t('paymentMethods.setupPending')}
        </div>
      )}

      {!isLoading && providerSubscriptions.length > 0 && (
        <div className="mx-5 mb-4 space-y-2">
          {providerSubscriptions.map((subscription) => (
            <ProviderSubscriptionCard
              key={subscription.id}
              subscription={subscription}
              busy={cancelSubscriptionMutation.isPending && cancelSubscriptionMutation.variables === subscription.id}
              onCancel={() => setCancelSubscriptionId(subscription.id)}
            />
          ))}
        </div>
      )}

      <div className="mx-5">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : methods.length === 0 && providerSubscriptions.length > 0 ? null : methods.length === 0 ? (
          <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-8 text-center">
            <CreditCard className="mx-auto h-8 w-8 text-[var(--brand-muted-foreground)] opacity-60" />
            <p className="mt-2 text-sm text-[var(--brand-muted-foreground)]">{t('paymentMethods.empty')}</p>
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
                  className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3.5"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10">
                      <CreditCard className="h-4 w-4 text-violet-400" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--brand-foreground)]">
                        {method.title || t('paymentMethods.fallbackTitle')}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--brand-muted-foreground)]">
                        {formatMethodMeta(method, t)}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={t('paymentMethods.unbind')}
                      disabled={busy}
                      onClick={() => setUnbindId(method.id)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--brand-muted-foreground)] transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-3">
                    <div className="min-w-0">
                      <p className="text-sm text-[var(--brand-foreground)]">{t('paymentMethods.autopay')}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-[var(--brand-muted-foreground)]">
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
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Unlink className="h-4 w-4 text-red-400" />
              {t('paymentMethods.unbindTitle')}
            </DialogTitle>
            <DialogDescription className="text-sm text-[var(--brand-muted-foreground)]">
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

      <Dialog
        open={cancelSubscriptionId !== null}
        onOpenChange={(open) => !open && setCancelSubscriptionId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">{t('paymentMethods.providerSubscriptions.cancelTitle')}</DialogTitle>
            <DialogDescription className="text-sm text-[var(--brand-muted-foreground)]">
              {t('paymentMethods.providerSubscriptions.cancelConfirm')}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex gap-2">
            <StadiumButton
              variant="ghost"
              className="flex-1"
              onClick={() => setCancelSubscriptionId(null)}
              disabled={cancelSubscriptionMutation.isPending}
            >
              {t('common.cancel')}
            </StadiumButton>
            <StadiumButton
              className="flex-1 bg-red-600 hover:bg-red-500"
              disabled={!cancelSubscriptionId || cancelSubscriptionMutation.isPending}
              onClick={() => cancelSubscriptionId && cancelSubscriptionMutation.mutate(cancelSubscriptionId)}
            >
              {cancelSubscriptionMutation.isPending
                ? t('paymentMethods.providerSubscriptions.cancelling')
                : t('paymentMethods.providerSubscriptions.cancel')}
            </StadiumButton>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={setupDialogOpen} onOpenChange={setSetupDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4 text-violet-300" />
              {t('paymentMethods.setupConfirmTitle')}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-[var(--brand-muted-foreground)]">
              {t('paymentMethods.setupConfirmBody')}
            </DialogDescription>
          </DialogHeader>
          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-sm text-[var(--brand-foreground)]">
            <Switch checked={setupConsent} onCheckedChange={setSetupConsent} />
            <span className="leading-relaxed">{t('paymentMethods.setupConsent')}</span>
          </label>
          <div className="mt-2 flex gap-2">
            <StadiumButton variant="ghost" className="flex-1" onClick={() => setSetupDialogOpen(false)}>
              {t('common.cancel')}
            </StadiumButton>
            <StadiumButton
              className="flex-1"
              disabled={!setupConsent || setupMutation.isPending}
              loading={setupMutation.isPending}
              onClick={() => setupMutation.mutate()}
            >
              {t('paymentMethods.continueToYookassa')}
            </StadiumButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * A subscription the provider runs (Platega): what it charges and when, and the
 * one thing the customer can do with it here — switch it off.
 */
function ProviderSubscriptionCard({
  subscription,
  busy,
  onCancel,
}: {
  subscription: ProviderSubscription;
  busy: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const pastDue = subscription.status === 'PAST_DUE';
  return (
    <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3.5">
      <div className="flex items-center gap-3">
        <AutopayGatewayMark type={subscription.gatewayType} currency={subscription.currency} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--brand-foreground)]">
            {subscription.planName ?? t('paymentMethods.providerSubscriptions.fallbackPlan')}
          </p>
          <p className="mt-0.5 text-xs text-[var(--brand-muted-foreground)]">
            {formatCharge(subscription, t)}
          </p>
        </div>
      </div>
      <p
        className={
          pastDue
            ? 'mt-3 text-[11px] leading-snug text-amber-300'
            : 'mt-3 text-[11px] leading-snug text-[var(--brand-muted-foreground)]'
        }
      >
        {pastDue
          ? t('paymentMethods.providerSubscriptions.pastDue')
          : subscription.nextChargeAt
            ? t('paymentMethods.providerSubscriptions.nextCharge', { date: formatDate(subscription.nextChargeAt) })
            : t('paymentMethods.providerSubscriptions.via')}
      </p>
      <StadiumButton
        variant="ghost"
        size="sm"
        className="mt-3 w-full"
        disabled={busy}
        onClick={onCancel}
      >
        {busy ? t('paymentMethods.providerSubscriptions.cancelling') : t('paymentMethods.providerSubscriptions.cancel')}
      </StadiumButton>
    </div>
  );
}

/** «299 ₽ каждый месяц», «990 ₽ раз в 3 месяца». */
function formatCharge(
  subscription: Pick<ProviderSubscription, 'amount' | 'currency' | 'intervalUnit' | 'intervalCount'>,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const amount = Number(subscription.amount);
  const sum = `${Number.isFinite(amount) ? amount.toLocaleString() : subscription.amount} ${
    subscription.currency === 'RUB' ? '₽' : subscription.currency
  }`;
  const unit = ['day', 'week', 'month', 'year'].includes(subscription.intervalUnit)
    ? subscription.intervalUnit
    : null;
  if (unit === null) return sum;
  const period =
    subscription.intervalCount === 1
      ? t(`paymentMethods.providerSubscriptions.everyUnit.${unit}`)
      : t(`paymentMethods.providerSubscriptions.every${unit[0]!.toUpperCase()}${unit.slice(1)}`, {
          count: subscription.intervalCount,
        });
  return `${sum} ${period}`;
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

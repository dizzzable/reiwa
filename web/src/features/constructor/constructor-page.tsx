import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Calculator } from 'lucide-react';
import { useNavigate } from 'react-router';

import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { createTariffConstructorCheckout, getEnabledGateways, getTariffConstructorManifest, getTariffConstructorQuote } from '@/lib/api-client';
import type { GatewayOption, TariffConstructorQuoteRequest, TariffModuleType } from '@/lib/api-client';
import { openExternalUrl } from '@/lib/utils';
import { savePendingCheckout } from '@/lib/pending-checkout';
import { saveSubscriptionProvisioningReceipt } from '@/lib/subscription-provisioning-receipt';
import { clearCheckoutAttempt, initialQuoteRequest, loadCheckoutAttempt, quoteCompositionKey, reconcileQuoteRequest, resolveCheckoutAttempt, saveCheckoutAttempt, updateSelection } from './helpers';

const LABELS: Record<TariffModuleType, string> = { TRAFFIC: 'Трафик', DEVICES: 'Устройства' };
const UNITS: Record<TariffModuleType, string> = { TRAFFIC: 'ГБ', DEVICES: '' };

export default function ConstructorPage() {
  const navigate = useNavigate();
  const manifestQuery = useQuery({ queryKey: ['tariff-constructor'], queryFn: getTariffConstructorManifest, staleTime: 60_000, retry: 1 });
  const [request, setRequest] = useState<TariffConstructorQuoteRequest>();
  const [quoteRequest, setQuoteRequest] = useState<TariffConstructorQuoteRequest>();
  const manifest = manifestQuery.data;
  const [gatewayType, setGatewayType] = useState('');
  const [attempt, setAttempt] = useState<{ compositionKey: string; idempotencyKey: string }>();
  const [configurationChanged, setConfigurationChanged] = useState(false);
  const [attemptBlocked, setAttemptBlocked] = useState(false);
  const gatewaysQuery = useQuery({ queryKey: ['gateways'], queryFn: getEnabledGateways, staleTime: 300_000 });

  useEffect(() => {
    if (!manifest) return;
    setRequest((current) => {
      if (!current) return initialQuoteRequest(manifest);
      const reconciled = reconcileQuoteRequest(current, manifest);
      if (reconciled.changed) setConfigurationChanged(true);
      return reconciled.request;
    });
  }, [manifest]);

  useEffect(() => {
    if (!request) return;
    setAttemptBlocked(false);
    const timer = window.setTimeout(() => setQuoteRequest(request), 300);
    return () => window.clearTimeout(timer);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    setAttempt((current) => {
      const persisted = loadCheckoutAttempt(window.sessionStorage, request, gatewayType);
      const next = resolveCheckoutAttempt(current ?? persisted, request, () => crypto.randomUUID(), gatewayType);
      saveCheckoutAttempt(window.sessionStorage, next);
      return next;
    });
  }, [request, gatewayType]);

  useEffect(() => {
    if (!gatewayType) return;
    const remainsAvailable = (gatewaysQuery.data ?? []).some((gateway) => gateway.type === gatewayType && gateway.isActive !== false && gateway.currency === request?.currency);
    if (!remainsAvailable) setGatewayType('');
  }, [gatewayType, gatewaysQuery.data, request?.currency]);

  const quoteQuery = useQuery({
    queryKey: ['tariff-constructor-quote', quoteRequest],
    queryFn: () => getTariffConstructorQuote(quoteRequest!),
    enabled: Boolean(quoteRequest),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  });

  useEffect(() => {
    if (!axios.isAxiosError(quoteQuery.error) || quoteQuery.error.response?.data?.code !== 'QUOTE_CHANGED') return;
    setConfigurationChanged(true);
    setQuoteRequest(undefined);
    void manifestQuery.refetch();
  }, [quoteQuery.error, manifestQuery]);

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (!request || !attempt || attemptBlocked) throw new Error('Checkout is not ready');
      const refreshed = await getTariffConstructorQuote(request);
      const refreshedIsCurrent = refreshed.revisionId === request.revisionId && refreshed.durationDays === request.durationDays && refreshed.currency === request.currency;
      if (!refreshedIsCurrent) throw new Error('Quote is stale');
      return createTariffConstructorCheckout({
        ...request,
        gatewayType,
        idempotencyKey: attempt.idempotencyKey,
        expectedAmount: refreshed.total,
        expectedCurrency: refreshed.currency,
      });
    },
    onSuccess: (result) => {
      const purchaseType = result.purchaseType === 'ADDITIONAL' ? 'ADDITIONAL' : 'NEW';
      savePendingCheckout(result.paymentId, result.checkoutUrl, { returnTo: '/constructor', label: 'Индивидуальный тариф' });
      saveSubscriptionProvisioningReceipt({ paymentId: result.paymentId, purchaseType, slotIndex: 0, slotIndexSource: 'PAYMENT_STATUS', phase: 'AWAITING_PAYMENT' });
      clearCheckoutAttempt(window.sessionStorage);
      if (result.checkoutUrl) openExternalUrl(result.checkoutUrl);
      navigate(`/payment-return?paymentId=${encodeURIComponent(result.paymentId)}`, { replace: true });
    },
    onError: (error) => {
      if (!axios.isAxiosError(error)) return;
      const code = error.response?.data?.code;
      if (!error.response || error.response.status >= 500 || code === 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED' || code === 'IDEMPOTENCY_KEY_CONFLICT') {
        setAttemptBlocked(true);
        return;
      }
      clearCheckoutAttempt(window.sessionStorage);
      setAttempt(undefined);
      if (code === 'QUOTE_CHANGED') {
        setConfigurationChanged(true);
        setQuoteRequest(undefined);
        void manifestQuery.refetch();
      }
    },
  });

  const currentCompositionKey = request ? quoteCompositionKey(request) : '';
  const quotedCompositionKey = quoteRequest ? quoteCompositionKey(quoteRequest) : '';
  const quoteIsCurrent = Boolean(quoteQuery.data && currentCompositionKey === quotedCompositionKey && quoteQuery.data.revisionId === request?.revisionId && quoteQuery.data.durationDays === request?.durationDays && quoteQuery.data.currency === request?.currency);

  if (manifestQuery.isLoading) return <div className="p-5"><div className="h-64 animate-pulse rounded-2xl bg-zinc-800/50" /></div>;
  if (!manifest || !request) return <div className="p-5 text-center text-zinc-400">Конструктор тарифа временно недоступен.</div>;

  return (
    <div className="mx-auto max-w-2xl px-5 pb-10">
      <header className="flex items-center gap-3 py-5">
        <BackButton fallback="/plans" label="Назад" />
        <div><h1 className="text-lg font-semibold">Соберите свой тариф</h1><p className="text-xs text-zinc-500">Предварительный расчёт индивидуальной конфигурации</p></div>
      </header>
      <main className="space-y-4">
        <section className="rounded-2xl border border-white/10 bg-zinc-900/70 p-4">
          <h2 className="mb-3 text-sm font-medium">Срок</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {manifest.durations.map((duration) => <Button key={`${duration.days}-${duration.currency}`} variant={request.durationDays === duration.days && request.currency === duration.currency ? 'default' : 'outline'} className="h-11" onClick={() => setRequest({ ...request, durationDays: duration.days, currency: duration.currency })}>{duration.days} дн. · {duration.currency}</Button>)}
          </div>
        </section>
        {manifest.modules.map((module) => {
          const value = request.selections.find((selection) => selection.type === module.type)?.value ?? module.defaultValue;
          const outputId = `module-${module.type}-value`;
          const unit = UNITS[module.type];
          return <section key={module.type} className="rounded-2xl border border-white/10 bg-zinc-900/70 p-4"><div className="mb-3 flex items-center justify-between"><label htmlFor={`module-${module.type}`} className="text-sm font-medium">{LABELS[module.type]}</label><output id={outputId} htmlFor={`module-${module.type}`} className="text-lg font-semibold">{value}{unit ? ` ${unit}` : ''}</output></div><input id={`module-${module.type}`} aria-describedby={outputId} aria-valuetext={`${value}${unit ? ` ${unit}` : ''}`} className="w-full accent-(--brand-primary)" type="range" min={module.min} max={module.max} step={module.step} value={value} onChange={(event) => setRequest(updateSelection(request, module.type, Number(event.target.value)))} /><div className="mt-1 flex justify-between text-xs text-zinc-500"><span>{module.min}{unit ? ` ${unit}` : ''}</span><span>{module.max}{unit ? ` ${unit}` : ''}</span></div></section>;
        })}
        <section className="rounded-2xl border border-white/10 bg-zinc-900/70 p-4">
          <label htmlFor="constructor-gateway" className="mb-3 block text-sm font-medium">Способ оплаты</label>
          <select id="constructor-gateway" className="h-11 w-full rounded-lg border border-white/10 bg-zinc-950 px-3" value={gatewayType} onChange={(event) => setGatewayType(event.target.value)}>
            <option value="">Выберите способ оплаты</option>
            {(gatewaysQuery.data ?? []).filter((gateway: GatewayOption) => gateway.isActive !== false && gateway.currency === request.currency).map((gateway: GatewayOption) => <option key={gateway.type} value={gateway.type}>{gateway.displayName || gateway.type}</option>)}
          </select>
        </section>
        <section aria-live="polite" aria-busy={quoteQuery.isFetching || checkoutMutation.isPending} className="rounded-2xl border border-(--brand-primary)/30 bg-(--brand-primary)/10 p-5">
          <div className="flex items-center gap-2 text-sm text-zinc-300"><Calculator className="h-4 w-4" />Расчёт стоимости</div>
          {configurationChanged ? <p role="status" className="mt-3 text-sm text-amber-200">Конфигурация тарифа изменилась. Параметры скорректированы, проверьте новый расчёт.</p> : null}
          {quoteQuery.isFetching ? <p role="status" className="mt-2 text-xs text-zinc-400">Обновляем расчёт…</p> : null}
          {quoteQuery.isError ? <p role="alert" className="mt-3 text-sm text-red-300">{axios.isAxiosError(quoteQuery.error) && quoteQuery.error.response?.data?.code === 'QUOTE_CHANGED' ? 'Тариф изменился. Обновляем конфигурацию…' : 'Не удалось рассчитать стоимость. Попробуйте позже.'}</p> : quoteQuery.data ? <p className={`mt-2 text-3xl font-semibold transition-opacity ${quoteQuery.isFetching ? 'opacity-60' : ''}`}>{quoteQuery.data.total} {quoteQuery.data.currency}</p> : <div role="status" aria-label="Загружаем расчёт" className="mt-3 h-9 w-32 animate-pulse rounded bg-white/10" />}
          {checkoutMutation.isError ? <p role="alert" className="mt-3 text-sm text-red-300">{axios.isAxiosError(checkoutMutation.error) && checkoutMutation.error.response?.data?.code === 'SUBSCRIPTION_LIMIT_REACHED' ? 'Достигнут лимит активных подписок.' : axios.isAxiosError(checkoutMutation.error) && checkoutMutation.error.response?.data?.code === 'QUOTE_CHANGED' ? 'Расчёт изменился. Обновляем параметры.' : axios.isAxiosError(checkoutMutation.error) && checkoutMutation.error.response?.data?.code === 'PROVIDER_CHECKOUT_CREATION_UNRESOLVED' ? 'Статус создания оплаты не определён. Проверьте историю платежей; повторная отправка заблокирована.' : axios.isAxiosError(checkoutMutation.error) && checkoutMutation.error.response?.data?.code === 'IDEMPOTENCY_KEY_CONFLICT' ? 'Эта попытка оплаты уже связана с другим запросом. Измените конфигурацию или проверьте историю платежей.' : 'Не удалось создать оплату. Повторите попытку.'}</p> : null}
          <Button className="mt-5 h-11 w-full" disabled={!gatewayType || !quoteIsCurrent || quoteQuery.isFetching || checkoutMutation.isPending || attemptBlocked} onClick={() => checkoutMutation.mutate()}>{checkoutMutation.isPending ? 'Проверяем расчёт…' : attemptBlocked ? 'Повторная отправка заблокирована' : 'Перейти к оплате'}</Button>
        </section>
      </main>
    </div>
  );
}

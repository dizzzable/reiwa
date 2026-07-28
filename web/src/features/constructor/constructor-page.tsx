import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Calculator } from 'lucide-react';

import { BackButton } from '@/components/ui/back-button';
import { Button } from '@/components/ui/button';
import { getTariffConstructorManifest, getTariffConstructorQuote } from '@/lib/api-client';
import type { TariffConstructorQuoteRequest, TariffModuleType } from '@/lib/api-client';
import { initialQuoteRequest, updateSelection } from './helpers';

const LABELS: Record<TariffModuleType, string> = { TRAFFIC: 'Трафик', DEVICES: 'Устройства' };
const UNITS: Record<TariffModuleType, string> = { TRAFFIC: 'ГБ', DEVICES: '' };

export default function ConstructorPage() {
  const manifestQuery = useQuery({ queryKey: ['tariff-constructor'], queryFn: getTariffConstructorManifest, staleTime: 60_000, retry: 1 });
  const [request, setRequest] = useState<TariffConstructorQuoteRequest>();
  const [quoteRequest, setQuoteRequest] = useState<TariffConstructorQuoteRequest>();
  const manifest = manifestQuery.data;

  useEffect(() => {
    if (manifest) setRequest(initialQuoteRequest(manifest));
  }, [manifest]);

  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(() => setQuoteRequest(request), 300);
    return () => window.clearTimeout(timer);
  }, [request]);

  const quoteQuery = useQuery({
    queryKey: ['tariff-constructor-quote', quoteRequest],
    queryFn: () => getTariffConstructorQuote(quoteRequest!),
    enabled: Boolean(quoteRequest),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  });

  useEffect(() => {
    if (axios.isAxiosError(quoteQuery.error) && quoteQuery.error.response?.status === 409) void manifestQuery.refetch();
  }, [quoteQuery.error, manifestQuery]);

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
        <section aria-live="polite" className="rounded-2xl border border-(--brand-primary)/30 bg-(--brand-primary)/10 p-5">
          <div className="flex items-center gap-2 text-sm text-zinc-300"><Calculator className="h-4 w-4" />Расчёт стоимости</div>
          {quoteQuery.isError ? <p className="mt-3 text-sm text-red-300">{axios.isAxiosError(quoteQuery.error) && quoteQuery.error.response?.status === 409 ? 'Тариф изменился. Обновляем конфигурацию…' : 'Не удалось рассчитать стоимость. Попробуйте позже.'}</p> : quoteQuery.data ? <p className={`mt-2 text-3xl font-semibold transition-opacity ${quoteQuery.isFetching ? 'opacity-60' : ''}`}>{quoteQuery.data.total} {quoteQuery.data.currency}</p> : <div className="mt-3 h-9 w-32 animate-pulse rounded bg-white/10" />}
          <Button className="mt-5 h-11 w-full" disabled>Покупка пока недоступна</Button>
        </section>
      </main>
    </div>
  );
}

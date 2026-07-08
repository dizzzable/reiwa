import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { getPlans } from '@/lib/api-client';
import { pickLocalized, safeUrl, type LandingSection } from '../landing-schema';

/**
 * Pricing — either binds to the live public plans catalog (`source: 'catalog'`)
 * or renders operator-authored static plan cards.
 *
 * The catalog payload is untyped upstream (`Promise<unknown>` in the api-client
 * type); we FAIL-CLOSED on empty / malformed / errored data: the catalog case
 * hides the section rather than rendering a broken pricing block. When the
 * platform is in a purchase-blocked mode, the section still renders as
 * information but the primary CTA routes to `/register` / `/sign-in` (there is
 * no purchase CTA pre-login by design).
 */
interface Props {
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}

interface PlanShape {
  id?: string;
  name?: string;
  description?: string | null;
  durationDays?: number;
  priceMonthlyCents?: number;
  priceCents?: number;
  currency?: string;
}

function formatMoney(cents: number | undefined, currency: string | undefined, locale: string): string {
  if (typeof cents !== 'number' || Number.isNaN(cents)) return '';
  const cur = typeof currency === 'string' && currency.length > 0 ? currency : 'RUB';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(0)} ${cur}`;
  }
}

function CatalogPricing({ heading }: { heading: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['landing', 'plans'],
    queryFn: getPlans,
    staleTime: 60_000,
  });
  if (isLoading || isError) return null;
  const plans = Array.isArray(data) ? (data as unknown as PlanShape[]) : [];
  const cleaned = plans.filter((p) => p && typeof p === 'object' && typeof p.id === 'string');
  if (cleaned.length === 0) return null;

  return (
    <section className="px-6 py-16">
      {heading.length > 0 && (
        <h2 className="mb-10 text-center text-3xl font-semibold text-white sm:text-4xl">{heading}</h2>
      )}
      <ul className="mx-auto grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cleaned.map((plan) => (
          <li
            key={plan.id}
            className="ls-surface flex flex-col gap-4 p-6 text-white"
          >
            <h3 className="text-lg font-semibold">{plan.name ?? '—'}</h3>
            {plan.description && <p className="text-sm text-zinc-300">{plan.description}</p>}
            <p className="text-3xl font-bold">
              {formatMoney(plan.priceCents ?? plan.priceMonthlyCents, plan.currency, 'ru')}
            </p>
            <Link
              to="/register"
              className="mt-auto inline-flex h-11 items-center justify-center rounded-full bg-(--brand-primary) px-6 text-sm font-semibold text-(--brand-primary-fg) transition hover:opacity-90"
            >
              →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StaticPricing({
  data,
  heading,
  locale,
  defaultLocale,
}: {
  data: {
    staticPlans?: Array<{
      name?: unknown;
      priceMonthly?: unknown;
      priceYearly?: unknown;
      currency?: unknown;
      features?: unknown[];
      cta?: { label?: unknown; action?: unknown; url?: unknown };
      highlighted?: unknown;
      badge?: unknown;
    }>;
  };
  heading: string;
  locale: string;
  defaultLocale: string;
}) {
  const plans = Array.isArray(data.staticPlans) ? data.staticPlans : [];
  if (plans.length === 0) return null;
  return (
    <section className="px-6 py-16">
      {heading.length > 0 && (
        <h2 className="mb-10 text-center text-3xl font-semibold text-white sm:text-4xl">{heading}</h2>
      )}
      <ul className="mx-auto grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan, index) => {
          const name = pickLocalized(plan.name, locale, defaultLocale);
          const currency = typeof plan.currency === 'string' ? plan.currency : 'RUB';
          const priceMonthly = typeof plan.priceMonthly === 'string' ? plan.priceMonthly : '';
          if (name.length === 0 || priceMonthly.length === 0) return null;
          const features = Array.isArray(plan.features) ? plan.features : [];
          const badge = pickLocalized(plan.badge, locale, defaultLocale);
          const ctaLabel = pickLocalized(plan.cta?.label, locale, defaultLocale);
          const ctaAction = plan.cta?.action;
          const ctaHref =
            ctaAction === 'register'
              ? '/register'
              : ctaAction === 'login'
              ? '/sign-in'
              : ctaAction === 'url'
              ? safeUrl(plan.cta?.url)
              : null;
          return (
            <li
              key={index}
              className={`ls-surface flex flex-col gap-4 p-6 text-white ${
                plan.highlighted ? 'border-(--brand-primary) bg-(--brand-primary)/10' : ''
              }`}
            >
              {badge && (
                <span className="inline-flex w-fit rounded-full bg-white/10 px-3 py-1 text-xs font-medium">
                  {badge}
                </span>
              )}
              <h3 className="text-lg font-semibold">{name}</h3>
              <p className="text-3xl font-bold">
                {priceMonthly} {currency}
              </p>
              <ul className="mt-2 flex flex-col gap-2 text-sm text-zinc-300">
                {features.map((raw, i) => {
                  const feature = pickLocalized(raw, locale, defaultLocale);
                  return feature.length > 0 ? (
                    <li key={i} className="flex items-start gap-2">
                      <span aria-hidden="true">•</span>
                      <span>{feature}</span>
                    </li>
                  ) : null;
                })}
              </ul>
              {ctaLabel.length > 0 && ctaHref && (
                <Link
                  to={ctaHref}
                  className="mt-auto inline-flex h-11 items-center justify-center rounded-full bg-(--brand-primary) px-6 text-sm font-semibold text-(--brand-primary-fg) transition hover:opacity-90"
                >
                  {ctaLabel}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type StaticPricingData = Parameters<typeof StaticPricing>[0]['data'];

export default function PricingSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as { source?: unknown; heading?: unknown };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const source = data.source === 'static' ? 'static' : 'catalog';
  if (source === 'catalog') {
    return <CatalogPricing heading={heading} />;
  }
  return (
    <StaticPricing
      data={section.data as StaticPricingData}
      heading={heading}
      locale={locale}
      defaultLocale={defaultLocale}
    />
  );
}

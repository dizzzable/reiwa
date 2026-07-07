import { Link } from 'react-router-dom';

import { pickLocalized, safeUrl, type LandingSection } from '../landing-schema';

/**
 * Hero — the top-of-page banner: eyebrow, heading (single h1 on the page),
 * subheading, and the two CTAs. All content is localized; missing translations
 * are hidden rather than shown as empty strings. External `url` CTAs get
 * `rel="noopener"` and open in a new tab; internal `register` / `login` route
 * via SPA client-side.
 */
export interface CtaShape {
  label?: unknown;
  action?: unknown;
  url?: unknown;
}

interface Props {
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}

function resolveCtaHref(action: unknown, url: unknown): { href: string; internal: boolean } | null {
  if (action === 'register') return { href: '/register', internal: true };
  if (action === 'login') return { href: '/sign-in', internal: true };
  if (action === 'url') {
    const safe = safeUrl(url);
    return safe === null ? null : { href: safe, internal: false };
  }
  return null;
}

function CtaLink({
  cta,
  locale,
  defaultLocale,
  variant,
}: {
  cta: CtaShape | undefined;
  locale: string;
  defaultLocale: string;
  variant: 'primary' | 'secondary';
}) {
  if (!cta || typeof cta !== 'object') return null;
  const label = pickLocalized(cta.label, locale, defaultLocale);
  if (label.length === 0) return null;
  const target = resolveCtaHref(cta.action, cta.url);
  if (target === null) return null;
  const className =
    variant === 'primary'
      ? 'inline-flex h-12 items-center justify-center rounded-full bg-(--brand-primary) px-8 text-base font-semibold text-(--brand-primary-fg) shadow-lg transition hover:opacity-90'
      : 'inline-flex h-12 items-center justify-center rounded-full border border-white/20 bg-white/5 px-8 text-base font-medium text-white transition hover:bg-white/10';
  if (target.internal) {
    return (
      <Link to={target.href} className={className}>
        {label}
      </Link>
    );
  }
  return (
    <a href={target.href} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}

export default function HeroSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    eyebrow?: unknown;
    heading?: unknown;
    subheading?: unknown;
    primaryCta?: CtaShape;
    secondaryCta?: CtaShape;
    media?: { src?: unknown; alt?: unknown };
    align?: unknown;
  };
  const eyebrow = pickLocalized(data.eyebrow, locale, defaultLocale);
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const subheading = pickLocalized(data.subheading, locale, defaultLocale);
  const align = data.align === 'left' ? 'left' : 'center';
  const mediaSrc = safeUrl(data.media?.src);
  const mediaAlt = pickLocalized(data.media?.alt, locale, defaultLocale);

  if (heading.length === 0) return null;

  return (
    <section
      className={`relative isolate flex flex-col gap-6 px-6 py-16 sm:py-24 ${
        align === 'center' ? 'items-center text-center' : 'items-start text-left'
      }`}
    >
      {eyebrow && (
        <p className="text-xs font-medium tracking-[0.2em] text-(--brand-primary) uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="max-w-3xl text-4xl font-semibold text-white sm:text-5xl md:text-6xl">
        {heading}
      </h1>
      {subheading && (
        <p className="max-w-2xl text-lg text-zinc-300 sm:text-xl">{subheading}</p>
      )}
      <div
        className={`mt-4 flex flex-col gap-3 sm:flex-row ${align === 'center' ? 'justify-center' : ''}`}
      >
        <CtaLink cta={data.primaryCta} locale={locale} defaultLocale={defaultLocale} variant="primary" />
        <CtaLink cta={data.secondaryCta} locale={locale} defaultLocale={defaultLocale} variant="secondary" />
      </div>
      {mediaSrc && (
        <img
          src={mediaSrc}
          alt={mediaAlt}
          loading="eager"
          decoding="async"
          className="mt-8 w-full max-w-4xl rounded-2xl border border-white/10 shadow-2xl"
        />
      )}
    </section>
  );
}

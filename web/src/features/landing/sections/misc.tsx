import { pickLocalized, safeUrl, type LandingSection } from '../landing-schema';

/**
 * Miscellaneous smaller landing sections that share the same 2-column /
 * card-grid pattern: Testimonials, Stats, TrustLogos, CtaBanner, Footer.
 * Grouped here to keep the section file count reasonable; each is a small
 * self-contained default export.
 */
interface Props {
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}

// ── Testimonials ──────────────────────────────────────────────────────────
export function TestimonialsSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    items?: Array<{
      quote?: unknown;
      author?: unknown;
      role?: unknown;
      avatar?: { src?: unknown; alt?: unknown };
      rating?: unknown;
    }>;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return null;
  return (
    <section className="px-6 py-16">
      {heading.length > 0 && (
        <h2 className="ls-title mb-10 text-center text-3xl font-semibold sm:text-4xl">{heading}</h2>
      )}
      <ul className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2">
        {items.map((item, index) => {
          const quote = pickLocalized(item.quote, locale, defaultLocale);
          const author = pickLocalized(item.author, locale, defaultLocale);
          if (quote.length === 0) return null;
          const role = pickLocalized(item.role, locale, defaultLocale);
          const avatarSrc = safeUrl(item.avatar?.src);
          const avatarAlt = pickLocalized(item.avatar?.alt, locale, defaultLocale);
          const rating = typeof item.rating === 'number' ? Math.max(0, Math.min(5, item.rating)) : null;
          return (
            <li
              key={index}
              className="ls-surface ls-title flex flex-col gap-4 p-6"
            >
              <p className="text-base">“{quote}”</p>
              <div className="flex items-center gap-3">
                {avatarSrc && (
                  <img
                    src={avatarSrc}
                    alt={avatarAlt}
                    loading="lazy"
                    decoding="async"
                    className="h-10 w-10 rounded-full border border-[color:var(--ls-border)]"
                  />
                )}
                <div className="text-sm">
                  <div className="font-medium">{author}</div>
                  {role.length > 0 && <div className="ls-muted">{role}</div>}
                </div>
              </div>
              {rating !== null && (
                <div aria-label={`Rating ${rating}/5`} className="flex gap-1 text-(--brand-primary)">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <span key={i} aria-hidden="true">
                      {i < rating ? '★' : '☆'}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Stats ─────────────────────────────────────────────────────────────────
export function StatsSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    items?: Array<{ value?: unknown; label?: unknown }>;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return null;
  return (
    <section className="px-6 py-12">
      {heading.length > 0 && (
        <h2 className="ls-title mb-8 text-center text-3xl font-semibold sm:text-4xl">{heading}</h2>
      )}
      <ul className="mx-auto grid max-w-5xl grid-cols-2 gap-6 sm:grid-cols-4">
        {items.map((item, index) => {
          const value = typeof item.value === 'string' ? item.value : '';
          const label = pickLocalized(item.label, locale, defaultLocale);
          if (value.length === 0) return null;
          return (
            <li key={index} className="ls-title text-center">
              <div className="text-3xl font-semibold text-(--brand-primary) sm:text-4xl">{value}</div>
              {label.length > 0 && <div className="ls-muted mt-1 text-sm">{label}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── TrustLogos ────────────────────────────────────────────────────────────
export function TrustLogosSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    logos?: Array<{ image?: { src?: unknown; alt?: unknown }; href?: unknown }>;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const logos = Array.isArray(data.logos) ? data.logos : [];
  if (logos.length === 0) return null;
  return (
    <section className="px-6 py-10">
      {heading.length > 0 && (
        <p className="ls-subtle mb-6 text-center text-xs font-medium tracking-[0.2em] uppercase">
          {heading}
        </p>
      )}
      <ul className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-6 opacity-70">
        {logos.map((logo, index) => {
          const src = safeUrl(logo.image?.src);
          if (src === null) return null;
          const alt = pickLocalized(logo.image?.alt, locale, defaultLocale);
          const href = safeUrl(logo.href);
          const img = (
            <img
              src={src}
              alt={alt}
              loading="lazy"
              decoding="async"
              // The height was reserved, the width was not, so each logo was
              // zero wide until it loaded and then shoved its neighbours along
              // the row. `min-w` holds a plausible slot; `object-contain` keeps
              // a narrow mark from being stretched to fill it.
              className="h-8 w-auto min-w-16 object-contain sm:h-10 sm:min-w-20"
            />
          );
          return (
            <li key={index}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {img}
                </a>
              ) : (
                img
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── CtaBanner ─────────────────────────────────────────────────────────────
export function CtaBannerSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    body?: unknown;
    cta?: { label?: unknown; action?: unknown; url?: unknown };
    style?: unknown;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  if (heading.length === 0) return null;
  const body = pickLocalized(data.body, locale, defaultLocale);
  const ctaLabel = pickLocalized(data.cta?.label, locale, defaultLocale);
  const action = data.cta?.action;
  const href =
    action === 'register'
      ? '/register'
      : action === 'login'
      ? '/sign-in'
      : action === 'url'
      ? safeUrl(data.cta?.url)
      : null;
  const isOutline = data.style === 'outline';
  const styleClass = isOutline
    ? 'border border-[color:var(--ls-border-strong)] bg-transparent text-[color:var(--ls-fg)]'
    : data.style === 'solid'
      ? 'bg-(--brand-primary) text-(--brand-primary-fg)'
      : 'bg-gradient-to-r from-(--brand-primary) to-(--brand-primary)/60 text-(--brand-primary-fg)';
  const buttonClass = isOutline
    ? 'bg-(--brand-primary) text-(--brand-primary-fg)'
    : 'bg-(--brand-primary-fg) text-(--brand-primary)';
  return (
    <section className="px-6 py-16">
      <div
        className={`mx-auto flex max-w-5xl flex-col items-center gap-4 rounded-3xl p-10 text-center ${styleClass}`}
      >
        <h2 className="text-3xl font-semibold sm:text-4xl">{heading}</h2>
        {body.length > 0 && <p className="max-w-2xl text-base opacity-90">{body}</p>}
        {ctaLabel.length > 0 && href && (
          <a
            href={href}
            className={`ls-cta inline-flex h-12 items-center justify-center rounded-full px-8 text-base font-semibold transition hover:opacity-90 ${buttonClass}`}
          >
            {ctaLabel}
          </a>
        )}
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────
export function FooterSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    columns?: Array<{
      title?: unknown;
      links?: Array<{ label?: unknown; href?: unknown }>;
    }>;
    legal?: unknown;
    socials?: Array<{ platform?: unknown; href?: unknown }>;
  };
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const legal = pickLocalized(data.legal, locale, defaultLocale);
  const socials = Array.isArray(data.socials) ? data.socials : [];
  return (
    <footer className="ls-muted border-t border-[color:var(--ls-border)] px-6 py-10 text-sm">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 sm:flex-row sm:justify-between">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {columns.map((col, index) => {
            const title = pickLocalized(col.title, locale, defaultLocale);
            const links = Array.isArray(col.links) ? col.links : [];
            if (title.length === 0 && links.length === 0) return null;
            return (
              <div key={index}>
                {title.length > 0 && (
                  <h3 className="ls-title mb-3 text-xs font-semibold tracking-wider uppercase">
                    {title}
                  </h3>
                )}
                <ul className="flex flex-col gap-2">
                  {links.map((link, i) => {
                    const label = pickLocalized(link.label, locale, defaultLocale);
                    const href = safeUrl(link.href);
                    if (label.length === 0 || href === null) return null;
                    const external = href.startsWith('https://');
                    return (
                      <li key={i}>
                        {external ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transition-colors hover:text-[color:var(--ls-fg)]"
                          >
                            {label}
                          </a>
                        ) : (
                          <a href={href} className="transition-colors hover:text-[color:var(--ls-fg)]">
                            {label}
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col items-start gap-4 sm:items-end">
          {socials.length > 0 && (
            <ul className="flex gap-3">
              {socials.map((s, i) => {
                const href = safeUrl(s.href);
                if (href === null) return null;
                const platform = typeof s.platform === 'string' ? s.platform : 'link';
                return (
                  <li key={i}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={platform}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--ls-border)] text-xs uppercase transition-colors hover:bg-[color:var(--ls-surface)]"
                    >
                      {platform.slice(0, 2)}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
          {legal.length > 0 && <p className="ls-subtle text-xs">{legal}</p>}
        </div>
      </div>
    </footer>
  );
}

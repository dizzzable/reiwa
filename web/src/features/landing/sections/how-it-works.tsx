import { pickLocalized, safeUrl, type LandingSection } from '../landing-schema';

/** HowItWorks — an ordered list of steps (1. 2. 3.) with an optional image. */
interface Props {
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}

export default function HowItWorksSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    steps?: Array<{ title?: unknown; body?: unknown; media?: { src?: unknown; alt?: unknown } }>;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (steps.length === 0) return null;

  return (
    <section className="px-6 py-16">
      {heading.length > 0 && (
        <h2 className="mb-10 text-center text-3xl font-semibold text-white sm:text-4xl">{heading}</h2>
      )}
      <ol className="mx-auto grid max-w-5xl gap-6 sm:grid-cols-3">
        {steps.map((step, index) => {
          const title = pickLocalized(step.title, locale, defaultLocale);
          const body = pickLocalized(step.body, locale, defaultLocale);
          if (title.length === 0) return null;
          const mediaSrc = safeUrl(step.media?.src);
          const mediaAlt = pickLocalized(step.media?.alt, locale, defaultLocale);
          return (
            <li
              key={index}
              className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white"
            >
              <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-(--brand-primary) font-semibold text-(--brand-primary-fg)">
                {index + 1}
              </span>
              <h3 className="text-lg font-semibold">{title}</h3>
              {body.length > 0 && <p className="mt-2 text-sm text-zinc-300">{body}</p>}
              {mediaSrc && (
                <img
                  src={mediaSrc}
                  alt={mediaAlt}
                  loading="lazy"
                  decoding="async"
                  className="mt-4 rounded-xl border border-white/10"
                />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

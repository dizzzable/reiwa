import { pickLocalized, sanitizeRichText, type LandingSection } from '../landing-schema';

/**
 * Faq — accordion of question/answer pairs. Answer supports a minimal allow-
 * list of inline tags (b/i/em/strong/a/ul/ol/li/p/br) and is sanitized on
 * render (defence-in-depth; the schema already restricts input).
 */
interface Props {
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}

export default function FaqSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    items?: Array<{ question?: unknown; answer?: unknown }>;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return null;

  return (
    <section className="px-6 py-16">
      {heading.length > 0 && (
        <h2 className="ls-title mb-10 text-center text-3xl font-semibold sm:text-4xl">{heading}</h2>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {items.map((item, index) => {
          const question = pickLocalized(item.question, locale, defaultLocale);
          const answer = pickLocalized(item.answer, locale, defaultLocale);
          if (question.length === 0) return null;
          return (
            <details
              key={index}
              className="ls-surface ls-title group p-4 open:bg-[color:var(--ls-surface-high)]"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium">
                <span>{question}</span>
                <span
                  aria-hidden="true"
                  className="ls-muted transition group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              {answer.length > 0 && (
                <div
                  className="ls-muted mt-3 text-sm leading-relaxed"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: sanitizeRichText(answer) }}
                />
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}

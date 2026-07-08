import { pickLocalized, type LandingSection } from '../landing-schema';

/**
 * FeaturesGrid — a 2/3/4-column list of icon+title+body cards. Icons are
 * looked up from a small allow-list (SVG glyphs bundled here) so the config
 * never carries arbitrary uploaded SVG. An unknown icon slug falls back to the
 * neutral dot icon.
 */
interface Props {
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}

const ICON_PATHS: Record<string, string> = {
  shield: 'M12 3l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V6l7-3z',
  lock: 'M6 10V7a6 6 0 0112 0v3M5 10h14v11H5z',
  zap: 'M13 3L4 14h7l-1 7 9-11h-7l1-7z',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 0v18M3 12h18',
  server: 'M4 5h16v6H4zm0 8h16v6H4zM8 8h.01M8 16h.01',
  wifi: 'M4 10a12 12 0 0116 0M7 13a8 8 0 0110 0M10 16a4 4 0 014 0M12 19h.01',
  'eye-off': 'M17.94 17.94A10 10 0 016 6M9 3l6 6m0 0l6 6',
  key: 'M15 7a4 4 0 11-4 4l-6 6v3h3l6-6a4 4 0 014-4z',
  check: 'M5 12l5 5 9-11',
  star: 'M12 2l3 7h7l-6 5 2 8-6-5-6 5 2-8-6-5h7z',
  rocket: 'M4 20l6-2 6-6-4-4-6 6-2 6zM14 4l6 6-4 4',
  users: 'M9 12a4 4 0 100-8 4 4 0 000 8zm10 8v-1a6 6 0 00-12 0v1',
  clock: 'M12 6v6l4 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  download: 'M12 3v14m0 0l-5-5m5 5l5-5M4 21h16',
  smartphone: 'M7 3h10v18H7zM10 18h4',
  gauge: 'M12 15V7m0 0l4 4M12 3a9 9 0 100 18 9 9 0 000-18z',
  heart: 'M12 20l-7-7a4 4 0 015.66-5.66L12 9l1.34-1.66A4 4 0 0119 13z',
  award: 'M12 3l3 6 6 1-4.5 4 1 6-5.5-3-5.5 3 1-6L3 10l6-1z',
  refresh: 'M4 12a8 8 0 0113.86-5.66L20 8M20 4v4h-4M20 12a8 8 0 01-13.86 5.66L4 16M4 20v-4h4',
  'help-circle': 'M9 9a3 3 0 015.66 1.34c0 1.5-3 2-3 3.66M12 17h.01M12 3a9 9 0 100 18 9 9 0 000-18z',
};

function Icon({ name }: { name: unknown }) {
  const path = typeof name === 'string' && ICON_PATHS[name] ? ICON_PATHS[name] : 'M12 12h.01';
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

export default function FeaturesGridSection({ section, locale, defaultLocale }: Props) {
  const data = section.data as {
    heading?: unknown;
    columns?: unknown;
    items?: Array<{ icon?: unknown; title?: unknown; body?: unknown }>;
  };
  const heading = pickLocalized(data.heading, locale, defaultLocale);
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return null;
  const cols = data.columns === 2 ? 'sm:grid-cols-2' : data.columns === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3';

  return (
    <section className="px-6 py-16">
      {heading.length > 0 && (
        <h2 className="mb-10 text-center text-3xl font-semibold text-white sm:text-4xl">{heading}</h2>
      )}
      <ul className={`mx-auto grid max-w-6xl gap-4 ${cols}`}>
        {items.map((item, index) => {
          const title = pickLocalized(item.title, locale, defaultLocale);
          const body = pickLocalized(item.body, locale, defaultLocale);
          if (title.length === 0) return null;
          return (
            <li
              key={index}
              className="ls-surface flex flex-col gap-3 p-6 text-white"
            >
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-(--brand-primary)/15 text-(--brand-primary)">
                <Icon name={item.icon} />
              </span>
              <h3 className="text-lg font-semibold">{title}</h3>
              {body.length > 0 && <p className="text-sm text-zinc-300">{body}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

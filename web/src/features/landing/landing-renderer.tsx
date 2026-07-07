import type { ComponentType, CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  LandingConfigPayload,
  LandingSection,
  LandingTheme,
  SectionType,
} from './landing-schema';
import HeroSection from './sections/hero';
import FeaturesGridSection from './sections/features-grid';
import HowItWorksSection from './sections/how-it-works';
import PricingSection from './sections/pricing';
import FaqSection from './sections/faq';
import {
  CtaBannerSection,
  FooterSection,
  StatsSection,
  TestimonialsSection,
  TrustLogosSection,
} from './sections/misc';

/**
 * Fixed section registry — the security boundary of the renderer. The config
 * carries a `type` discriminant, and this map is the ONLY place where a type
 * turns into a component. An unknown/unregistered type is dropped upstream by
 * `parseLandingPayload`, and a defensive check here doubles that (fail-closed).
 */
type SectionComponent = ComponentType<{
  section: LandingSection;
  locale: string;
  defaultLocale: string;
}>;

export const LANDING_SECTIONS: Record<SectionType, SectionComponent> = {
  hero: HeroSection,
  featuresGrid: FeaturesGridSection,
  howItWorks: HowItWorksSection,
  pricing: PricingSection,
  faq: FaqSection,
  testimonials: TestimonialsSection,
  stats: StatsSection,
  trustLogos: TrustLogosSection,
  ctaBanner: CtaBannerSection,
  footer: FooterSection,
};

/**
 * Map the config `theme` to CSS custom properties applied at the landing
 * root. `inherit: true` (default) leaves the app-wide brand tokens intact so
 * the landing follows operator branding by default.
 */
function themeToCssVars(theme: LandingTheme | undefined): CSSProperties {
  if (theme === undefined || theme.inherit === true) return {};
  const style: Record<string, string> = {};
  if (theme.colors?.primary) style['--brand-primary'] = theme.colors.primary;
  if (theme.colors?.bg) style['--brand-bg-primary'] = theme.colors.bg;
  if (theme.colors?.fg) style['--brand-fg'] = theme.colors.fg;
  if (theme.colors?.accent) style['--brand-accent'] = theme.colors.accent;
  if (theme.font?.family) style['font-family'] = theme.font.family;
  return style as CSSProperties;
}

interface LandingRendererProps {
  config: LandingConfigPayload;
}

/**
 * Render an ordered stack of visible sections from the config.
 * Unknown/invalid sections are skipped defensively — the page never errors.
 */
export default function LandingRenderer({ config }: LandingRendererProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language?.slice(0, 2).toLowerCase() ?? config.defaultLocale;
  const defaultLocale = config.defaultLocale;
  const style = themeToCssVars(config.theme);

  return (
    <main
      lang={locale}
      className="min-h-dvh w-full bg-(--brand-bg-primary) text-white"
      style={style}
    >
      {config.sections.map((section) => {
        const Component = LANDING_SECTIONS[section.type];
        if (!Component) return null; // defence-in-depth (parser already dropped these)
        return (
          <Component
            key={section.id}
            section={section}
            locale={locale}
            defaultLocale={defaultLocale}
          />
        );
      })}
    </main>
  );
}

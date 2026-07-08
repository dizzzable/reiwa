import type { ComponentType, CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import './landing.css';
import type {
  LandingConfigPayload,
  LandingSection,
  LandingTheme,
  SectionType,
} from './landing-schema';
import { LandingBg, Reveal } from './landing-background';
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

const RADIUS_PX: Record<NonNullable<LandingTheme['radius']>, string> = {
  none: '0px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
};

/**
 * Map the config `theme` to CSS custom properties applied at the landing root.
 * `inherit: true` (default) leaves the app-wide brand tokens intact so the
 * landing follows operator branding by default; overrides set explicit vars.
 */
function themeToCssVars(theme: LandingTheme | undefined): CSSProperties {
  const style: Record<string, string> = {};
  const primary = theme?.colors?.primary;
  const bg = theme?.colors?.bg;
  if (theme?.inherit !== true) {
    if (primary) style['--brand-primary'] = primary;
    if (bg) style['--brand-bg-primary'] = bg;
    if (theme?.colors?.fg) style['--brand-fg'] = theme.colors.fg;
    if (theme?.colors?.accent) style['--brand-accent'] = theme.colors.accent;
    if (theme?.font?.family) style['fontFamily'] = theme.font.family;
    if (theme?.radius) style['--ls-radius'] = RADIUS_PX[theme.radius];
  }
  // Effect vars always available (fall back to brand primary in CSS).
  if (primary) style['--ls-primary'] = primary;
  if (bg) style['--ls-bg'] = bg;
  return style as CSSProperties;
}

interface LandingRendererProps {
  config: LandingConfigPayload;
}

/**
 * Render an ordered stack of visible sections from the config, behind an
 * optional CSS background effect and with per-section scroll-reveal.
 * Unknown/invalid sections are skipped defensively — the page never errors.
 */
export default function LandingRenderer({ config }: LandingRendererProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language?.slice(0, 2).toLowerCase() ?? config.defaultLocale;
  const defaultLocale = config.defaultLocale;
  const theme = config.theme;
  const style = themeToCssVars(theme);
  const surface = theme?.surfaceStyle ?? 'solid';
  const bgColors =
    theme?.backgroundColors && theme.backgroundColors.length > 0
      ? theme.backgroundColors
      : theme?.colors?.primary
        ? [theme.colors.primary]
        : undefined;

  return (
    <main
      lang={locale}
      data-surface={surface}
      className="ls-root ls-root--page w-full"
      style={style}
    >
      <LandingBg
        effect={theme?.background}
        colors={bgColors}
        animate={theme?.animateBackground !== false}
      />
      {config.sections.map((section) => {
        const Component = LANDING_SECTIONS[section.type];
        if (!Component) return null; // defence-in-depth (parser already dropped these)
        return (
          <Reveal key={section.id} animation={section.animation}>
            <Component section={section} locale={locale} defaultLocale={defaultLocale} />
          </Reveal>
        );
      })}
    </main>
  );
}

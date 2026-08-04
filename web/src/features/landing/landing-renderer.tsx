import type { ComponentType, CSSProperties } from 'react';

import './landing.css';
import type {
  LandingConfigPayload,
  LandingSection,
  LandingTheme,
  SectionType,
} from './landing-schema';
import { LandingBg, LandingOverlay, Reveal } from './landing-background';
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

function readableForeground(background: string | undefined): string | undefined {
  if (!background) return undefined;
  const raw = background.trim().replace(/^#/, '');
  const expanded =
    raw.length === 3
      ? raw
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : raw;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return undefined;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * toLinear(red) +
    0.7152 * toLinear(green) +
    0.0722 * toLinear(blue);
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithDark = (luminance + 0.05) / 0.053;
  return contrastWithDark >= contrastWithWhite ? '#0a0a0a' : '#ffffff';
}

/**
 * Map the config `theme` to CSS custom properties applied at the landing root.
 * `inherit: true` (default) leaves the app-wide brand tokens intact so the
 * landing follows operator branding by default; overrides set explicit vars.
 *
 * Exported because the admin preview builds its own root element (it interleaves
 * builder chrome between sections) and must resolve the theme through THIS
 * function — a second mapping is exactly how `radius`, `fg` and `accent` came to
 * apply in production but not in the preview.
 */
export function themeToCssVars(theme: LandingTheme | undefined): CSSProperties {
  const style: Record<string, string> = {};
  const primary = theme?.colors?.primary;
  const bg = theme?.colors?.bg;
  if (theme?.inherit !== true) {
    if (primary) {
      style['--brand-primary'] = primary;
      style['--ls-primary'] = primary;
      const primaryForeground = readableForeground(primary);
      if (primaryForeground) {
        style['--brand-primary-fg'] = primaryForeground;
        style['--ls-primary-fg'] = primaryForeground;
      }
    }
    if (bg) {
      style['--brand-bg-primary'] = bg;
      style['--ls-bg'] = bg;
    }
    if (theme?.colors?.fg) style['--ls-fg'] = theme.colors.fg;
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
  /**
   * Viewer locale (2-letter). Injected by the host — reiwa derives it from
   * i18next, the admin preview from its locale switcher — so the kit itself
   * carries no i18n runtime. Defaults to the config's own default locale.
   */
  locale?: string;
}

/**
 * Render an ordered stack of visible sections from the config, behind an
 * optional CSS background effect and with per-section scroll-reveal.
 * Unknown/invalid sections are skipped defensively — the page never errors.
 */
export default function LandingRenderer({ config, locale: localeProp }: LandingRendererProps) {
  const locale = (localeProp ?? config.defaultLocale).slice(0, 2).toLowerCase();
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
      data-card-hover={theme?.cardHover ?? 'none'}
      data-cta={theme?.ctaStyle ?? 'none'}
      className="ls-root ls-root--page w-full"
      style={style}
    >
      <LandingBg
        effect={theme?.background}
        colors={bgColors}
        animate={theme?.animateBackground !== false}
      />
      <LandingOverlay
        overlay={theme?.backgroundOverlay}
        animate={theme?.animateBackground !== false}
      />
      {config.sections.map((section, index) => {
        const Component = LANDING_SECTIONS[section.type];
        if (!Component) return null; // defence-in-depth (parser already dropped these)
        return (
          <Reveal key={section.id} animation={section.animation} first={index === 0}>
            <Component section={section} locale={locale} defaultLocale={defaultLocale} />
          </Reveal>
        );
      })}
    </main>
  );
}

/**
 * The globe the operator chose, and how they set it up.
 *
 * ONE PLACE, EVERYTHING DERIVED. Three variants, each with its own props, its
 * own ranges and its own renderer. Left to spread naturally that becomes a
 * component map, a defaults map, a clamp table, a "which of these can hold a
 * marker" set and a panel form — five lists that must agree, in two repositories
 * that ship as separate images. The catalog below is stated once and the rest is
 * read off it, the same way `card-effect-catalog` does for the 54 card
 * backgrounds next door and for the same reason: a forgotten entry becomes a
 * type error instead of a globe that renders black on somebody's phone.
 *
 * THE READER IS TOTAL, AND THAT IS LOAD-BEARING. `describePublicConfigSnapshot`
 * deliberately does not validate this field, and the only thing that makes that
 * safe is this function answering a complete configuration for ANY input. It
 * once did not: `String(value)` on an enum prop threw for an object carrying a
 * non-callable `toString`, and the call site is the dashboard carousel's render
 * — so the throw took down the whole subscriptions screen, not just the globe.
 *
 * READING IS DEFENSIVE ON PURPOSE. The panel ships as its own image and can be
 * newer than this one, so a stored variant name may be one this build has never
 * heard of, and a stored number may be outside the range this build allows.
 * Neither is an error and neither may blank the screen: an unknown variant falls
 * back to the default, and every number is clamped. That is the same contract
 * `resolveIconEffect` follows for icon effects.
 *
 * IT LIVES IN `originkit/` FOR A REASON. Both apps need it — the cabinet to
 * render the planet, the panel to offer the operator the controls that produce
 * it — and this directory is vendored byte-for-byte into the panel by
 * `scripts/sync-originkit.mjs`, with a manifest test that fails on any drift.
 * Two hand-kept copies would diverge the first time a range changed, and the
 * symptom would be an operator tuning a slider to a value the cabinet quietly
 * clamps away.
 */

/** Which planet. */
export type GlobeVariant = 'globe' | 'globe-mesh' | 'dither-globe';

interface NumericProp {
  readonly kind: 'number';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}
interface ColorProp {
  readonly kind: 'color';
  readonly default: string;
}
interface BooleanProp {
  readonly kind: 'boolean';
  readonly default: boolean;
}
interface EnumProp {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly default: string;
}

export type GlobePropSpec = NumericProp | ColorProp | BooleanProp | EnumProp;

export interface GlobeVariantSpec {
  /**
   * Whether this variant can show where a server is.
   *
   * Only `globe` draws real geography — Natural Earth land, projected — so only
   * it has a place to put a marker. The other two are a Fibonacci point cloud
   * and a noise field; a "marker" on either would be a dot at a coordinate that
   * corresponds to nothing. The servers list is shown either way; what changes
   * is whether the planet above it points at anything.
   */
  readonly supportsMarkers: boolean;
  /**
   * What the variant costs the device.
   *
   * `dither-globe` draws on a plain 2D canvas and takes no WebGL context at
   * all, which matters: iOS allows a render process about sixteen live contexts
   * and the subscription card behind this sheet is already holding one.
   */
  readonly renderer: 'webgl' | 'canvas2d';
  readonly props: Readonly<Record<string, GlobePropSpec>>;
}

const num = (min: number, max: number, step: number, value: number): NumericProp => ({
  kind: 'number',
  min,
  max,
  step,
  default: value,
});
const color = (value: string): ColorProp => ({ kind: 'color', default: value });
const bool = (value: boolean): BooleanProp => ({ kind: 'boolean', default: value });
const choice = (values: readonly string[], value: string): EnumProp => ({
  kind: 'enum',
  values,
  default: value,
});

/**
 * Every prop the operator can set, per variant.
 *
 * Ranges are the ones the source component's own control panel uses, so a
 * slider here cannot produce a value the renderer was never shown. `style` and
 * the marker config are absent deliberately: the first is layout the cabinet
 * owns, the second is data, not decoration.
 */
export const GLOBE_CATALOG = {
  globe: {
    supportsMarkers: true,
    renderer: 'webgl',
    props: {
      speed: num(0, 10, 1, 2),
      smoothing: num(0, 20, 1, 8),
      scale: num(1, 20, 1, 8),
      direction: choice(['left', 'right'], 'left'),
      stopOnHover: bool(true),
      initialLatitude: num(-90, 90, 1, 23),
      initialLongitude: num(-180, 180, 1, -23),
      dragSpeed: num(0, 20, 1, 5),
      detail: num(1, 10, 1, 5),
      fill: choice(['dots', 'solid'], 'dots'),
      fillColor: color('#FFFFFF'),
      dotColor: color('#FFFFFF'),
      dotSize: num(1, 20, 1, 5),
      dotDensity: num(1, 20, 1, 8),
      allDots: bool(false),
      showOutline: bool(true),
      outlineColor: color('#FFFFFF'),
      outlineWidth: num(1, 5, 1, 1),
      showGrid: bool(true),
      graticuleColor: color('#D4D4D4'),
      oceanColor: color('#000000'),
      markerColor: color('#00F7FF'),
      markerSize: num(10, 80, 5, 40),
    },
  },
  'globe-mesh': {
    supportsMarkers: false,
    renderer: 'webgl',
    props: {
      dot: color('#FFFFFF'),
      net: color('#26FF00'),
      density: num(1, 40, 1, 20),
      spin: num(0, 40, 1, 20),
      spinDir: choice(['left', 'right'], 'right'),
      hoverOn: bool(true),
      sizePercent: num(40, 140, 5, 100),
    },
  },
  'dither-globe': {
    supportsMarkers: false,
    renderer: 'canvas2d',
    props: {
      colorA: color('#0B0B12'),
      colorB: color('#E8E8F0'),
      accent: color('#5B8DEF'),
      pixel: num(1, 12, 1, 4),
      levels: num(2, 16, 1, 6),
      land: num(0, 100, 1, 50),
      globeSize: num(40, 140, 5, 100),
      glowEnabled: bool(true),
      glowSize: num(0, 40, 1, 12),
      speed: num(0, 20, 1, 6),
      dragEnabled: bool(true),
    },
  },
} as const satisfies Readonly<Record<GlobeVariant, GlobeVariantSpec>>;

export const GLOBE_VARIANTS = Object.keys(GLOBE_CATALOG) as readonly GlobeVariant[];

/** The variant used when the operator has not chosen, or chose one we lack. */
export const DEFAULT_GLOBE_VARIANT: GlobeVariant = 'globe';

export interface GlobePreferences {
  readonly enabled: boolean;
  readonly variant: GlobeVariant;
  readonly props: Readonly<Record<string, unknown>>;
}

/** Whether this build knows the variant the panel named. */
export function isGlobeVariant(value: unknown): value is GlobeVariant {
  return typeof value === 'string' && Object.hasOwn(GLOBE_CATALOG, value);
}

/** Every prop of a variant at its default. */
export function defaultGlobeProps(
  variant: GlobeVariant,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, spec] of Object.entries(GLOBE_CATALOG[variant].props)) {
    out[name] = spec.default;
  }
  return out;
}

/**
 * Turns whatever the panel stored into props this build can render.
 *
 * Unknown names are dropped, numbers are clamped into the variant's range and
 * snapped to its step, colours must look like colours, and anything missing
 * takes its default — so the result is always complete and always in range,
 * whatever arrived. A panel one version ahead cannot black out this screen.
 */
export function resolveGlobeProps(
  variant: GlobeVariant,
  stored: unknown,
): Record<string, string | number | boolean> {
  const out = defaultGlobeProps(variant);
  if (stored === null || typeof stored !== 'object') return out;

  const specs = GLOBE_CATALOG[variant].props as Readonly<Record<string, GlobePropSpec>>;
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!Object.hasOwn(specs, name)) continue;
    const spec = specs[name];
    if (spec.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const snapped = Math.round(value / spec.step) * spec.step;
      out[name] = Math.min(spec.max, Math.max(spec.min, snapped));
    } else if (spec.kind === 'boolean') {
      if (typeof value === 'boolean') out[name] = value;
    } else if (spec.kind === 'color') {
      // `{3,8}` also admitted 5- and 7-digit hex, which are not CSS
      // colours: the renderer's own parser handles 3/4/6/8 and falls through
      // to opaque black for the other two. A newer panel storing `#12345`
      // produced a black globe — the exact "renders black on somebody's phone"
      // outcome this catalogue exists to prevent.
      if (typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim())) {
        out[name] = value.trim();
      }
    } else if (typeof value === 'string' && spec.values.includes(value)) {
      out[name] = String(value);
    }
  }
  return out;
}

/**
 * Reads the operator's whole choice out of the branding payload.
 *
 * `enabled` defaults to true: an operator who has never opened the new tab
 * still gets the feature, and one who turns it off gets a card that ignores the
 * double tap entirely.
 */
export function resolveGlobePreferences(stored: unknown): GlobePreferences {
  const source =
    stored !== null && typeof stored === 'object'
      ? (stored as Record<string, unknown>)
      : {};
  const variant = isGlobeVariant(source['variant'])
    ? source['variant']
    : DEFAULT_GLOBE_VARIANT;
  return {
    enabled: source['enabled'] !== false,
    variant,
    props: resolveGlobeProps(variant, source['props']),
  };
}

/**
 * Which vendored file draws each variant.
 *
 * Read by the panel's vendoring guard, which otherwise assumes every component
 * in `originkit/` is a card background and flags these as riding along unused.
 * Declared here so that adding a fourth planet updates the guard by itself.
 */
export const GLOBE_COMPONENT_FILE = {
  globe: 'Globe.tsx',
  'globe-mesh': 'GlobeMesh.tsx',
  'dither-globe': 'DitherGlobe.tsx',
} as const satisfies Readonly<Record<GlobeVariant, string>>;

/**
 * Vendored files that serve the globes without being one.
 *
 * The baked land, and this catalog itself.
 */
export const GLOBE_SUPPORT_FILES = [
  'globe-land-110m.ts',
  'globe-preferences.ts',
] as const;

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

/**
 * Font and palette are FLAT — `fontSize`, `paletteCount`, `color1`…`color5` as
 * top-level props rather than the two nested objects the upstream component
 * used.
 *
 * The configurator writes one control to one prop: `getCardEffectDefaults`
 * assigns `props[control.prop]`, and the preview spreads that record straight
 * onto the component. Nothing can reach a field inside an object, so a nested
 * palette is an unreachable picker — the operator moves a swatch and the glyphs
 * stay white. Font size matters for a second reason: it sets the tile pitch, so
 * while it was nested the grid's density could not be tuned at all.
 */
export interface TextWaveProps {
  gridText?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  letterSpacing?: number;
  paletteCount?: number;
  color1?: string;
  color2?: string;
  color3?: string;
  color4?: string;
  color5?: string;
  backgroundColor?: string;
  speed?: number;
  gap?: number;
  reverse?: boolean;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface GridVars extends CSSProperties {
  '--t': string;
}

interface TileVars extends CSSProperties {
  '--x': string;
  '--y': string;
  '--base-color': string;
}

function parseColor(input?: string): Rgb {
  if (!input) return { r: 255, g: 255, b: 255 };
  const s = input.trim();
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map(c => c + c)
        .join('');
    const n = parseInt(h.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map(v => parseFloat(v));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0 };
  }
  return { r: 255, g: 255, b: 255 };
}

function paletteAt(colors: string[], p: number): string {
  if (colors.length === 0) return 'rgb(255, 255, 255)';
  if (colors.length === 1) return colors[0];
  const scaled = Math.max(0, Math.min(1, p)) * (colors.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = parseColor(colors[i]);
  const b = parseColor(colors[Math.min(i + 1, colors.length - 1)]);
  return `rgb(${Math.round(a.r + (b.r - a.r) * f)}, ${Math.round(a.g + (b.g - a.g) * f)}, ${Math.round(
    a.b + (b.b - a.b) * f
  )})`;
}

function buildPalette(ordered: (string | undefined)[], paletteCount: number): string[] {
  const count = Math.max(1, Math.min(5, paletteCount || 1));
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    const v = ordered[i];
    if (typeof v === 'string' && v.trim().length > 0) entries.push(v.trim());
  }
  return entries.length ? entries : ['#FFFFFF'];
}

function toFontStyle(font: {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  letterSpacing: number;
}): CSSProperties {
  return {
    fontFamily: font.fontFamily,
    fontWeight: font.fontWeight,
    fontSize: typeof font.fontSize === 'number' ? `${font.fontSize}px` : font.fontSize,
    lineHeight: 1,
    letterSpacing: typeof font.letterSpacing === 'number' ? `${font.letterSpacing}px` : font.letterSpacing
  };
}

const DEFAULT_GRID_TEXT = 'Text Wave';

export default function TextWave({
  gridText = DEFAULT_GRID_TEXT,
  fontFamily = 'Inter',
  fontWeight = 400,
  fontSize = 14,
  letterSpacing = 0,
  paletteCount = 1,
  color1 = '#FFFFFF',
  color2 = '#FFFFFF',
  color3 = '#FFFFFF',
  color4 = '#FFFFFF',
  color5 = '#FFFFFF',
  backgroundColor = '#000000',
  speed = 61,
  gap = 10,
  reverse = true
}: TextWaveProps) {
  const rawId = useId();
  const instanceId = `text-wave-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // A default only fills in for `undefined`, and the field passes an empty
  // string through the moment the operator clears it to type. At `''` the tile
  // expression below was `''.split('')[i % 1]` — `undefined` in every tile — so
  // the card went blank mid-edit and stayed blank if the value was ever saved.
  // Whitespace-only is the same picture by a different route.
  //
  // The type check is not redundant here. A stored props record is free-form
  // JSON that the backend validates with `@IsObject()` alone, so a record
  // carrying `gridText: null` reaches this line as `null` — no default fires,
  // and `null.trim()` threw during render, taking the card down rather than
  // showing the fallback. `CharacterWaves` already guards its own text this
  // way; the same coercion runs on `fontSize` and `gap` a few lines below.
  const raw = typeof gridText === 'string' ? gridText : '';
  const text = raw.trim().length > 0 ? raw : DEFAULT_GRID_TEXT;
  // Code POINTS, not UTF-16 code units. `split('')` cut an astral character —
  // any emoji — into its two surrogates, so the grid drew a pair of blank tiles
  // where one glyph belonged AND counted the cycle one longer per emoji, which
  // slid the text out of step from row to row. `DotMatrix` was fixed the same
  // way, for the same reason.
  //
  // This is not grapheme segmentation and does not pretend to be: `Array.from`
  // splits code points, so a combining accent still occupies a cell of its own
  // and a ZWJ sequence — a family emoji, a flag, a skin-tone modifier — is still
  // spread over several cells. One tile holds one code point.
  const glyphs = Array.from(text);
  const palette = buildPalette([color1, color2, color3, color4, color5], paletteCount);
  const font = { fontFamily, fontWeight, fontSize, letterSpacing };
  // Both terms are coerced, not just `fontSize`. `tileSize` is interpolated raw
  // into the `<style>` block this component emits, and `number + string` in JS
  // concatenates — so a `gap` that arrived as text would carry whatever followed
  // it straight into a document-wide CSS rule. The props reaching here come from
  // an operator's saved JSON, which is shape-checked but not typed per field.
  const size = Number(fontSize);
  const spacing = Number(gap);
  const tileSize =
    Math.max(Number.isFinite(size) ? size : 14, 10) +
    (Number.isFinite(spacing) ? spacing : 0);

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const apply = (width: number, height: number) => {
      setDimensions(prev =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5 ? prev : { width, height }
      );
    };

    const rect = container.getBoundingClientRect();
    apply(rect.width, rect.height);

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const box = entry.contentRect;
        apply(box.width, box.height);
      }
    });
    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { threshold: 0 }
    );
    intersectionObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!inView) return;
    let animationFrame = 0;
    let time = 0;
    let lastFrameTime = 0;
    const frameInterval = 1e3 / 30;
    const updateTime = (timestamp: number) => {
      if (!lastFrameTime || timestamp - lastFrameTime >= frameInterval) {
        const direction = reverse ? -1 : 1;
        time = (time + 10 * direction) % 864e5;
        const grid = gridRef.current;
        if (grid) {
          grid.style.setProperty('--t', String(time));
          grid.style.setProperty('--speed-factor', String(speed / 25));
        }
        lastFrameTime = timestamp;
      }
      animationFrame = requestAnimationFrame(updateTime);
    };
    animationFrame = requestAnimationFrame(updateTime);
    return () => cancelAnimationFrame(animationFrame);
  }, [speed, reverse, inView]);

  const rawCols = Math.ceil(dimensions.width / tileSize);
  const cols = Math.max(1, rawCols) + (rawCols % 2 === 1 ? 1 : 0);
  const rows = Math.max(1, Math.ceil(dimensions.height / tileSize));
  const tileCount = dimensions.width > 0 && dimensions.height > 0 ? cols * rows : 0;

  const styleContent = `
@property --t {
  syntax: "<integer>";
  initial-value: 0;
  inherits: true
}

@property --speed-factor {
  syntax: "<number>";
  initial-value: 1;
  inherits: true
}

div.${instanceId}-c {
  position: relative;
  width: fit-content;
  height: fit-content;
  margin: 0 auto;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

div.${instanceId}-l {
  position: absolute;
  --offset-x: calc(var(--x) - 0.5);
  --abs-x: calc(max(var(--offset-x), -1 * var(--offset-x)));
  --offset-y: calc(var(--y) - 0.5);
  --abs-y: calc(max(var(--offset-y), -1 * var(--offset-y)));
  will-change: transform, opacity;

  --l: calc(
      sin(var(--abs-x) / cos(sin(var(--abs-y) * 2 + 60) * 2.5) * 3 - (var(--t) * var(--speed-factor)) / 350)
    );
  color: var(--base-color);
  opacity: max(var(--l), 0.05);

  text-align: center;
  display: flex;
  justify-content: center;
  align-items: center;
  width: ${tileSize}px;
  height: ${tileSize}px;
}`;

  const gridVars: GridVars = {
    '--t': '0',
    width: `${cols * tileSize}px`,
    height: `${rows * tileSize}px`,
    pointerEvents: 'none'
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 h-full w-full overflow-hidden"
      style={{ backgroundColor, ...toFontStyle(font) }}
    >
      <style>{styleContent}</style>
      <div ref={gridRef} className={`${instanceId}-c`} style={gridVars}>
        {Array.from({ length: tileCount }).map((_, i) => {
          const x = (i % cols) * tileSize;
          const y = Math.floor(i / cols) * tileSize;
          const xRatio = ((i + 1) % cols) / (cols + 1);
          const yRatio = (rows - Math.floor(i / cols)) / rows;
          const col = i % cols;
          const t = cols > 1 ? col / (cols - 1) : 0;
          const tileVars: TileVars = {
            '--x': String(xRatio),
            '--y': String(yRatio),
            '--base-color': paletteAt(palette, t),
            left: x,
            top: y
          };
          return (
            <div className={`${instanceId}-l`} style={tileVars} key={i}>
              {glyphs[i % Math.max(1, glyphs.length)]}
            </div>
          );
        })}
      </div>
    </div>
  );
}

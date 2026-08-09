import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

/**
 * The palette is FLAT — `paletteCount` plus `color1`…`color5` as top-level
 * props, not the nested `colors` object the upstream component used.
 *
 * The configurator writes one control to one prop: `getCardEffectDefaults`
 * assigns `props[control.prop]`, and the preview spreads that record straight
 * onto the component. There is no path from a control to a field inside an
 * object, so a nested palette can only ever be an unreachable picker — the
 * operator moves a swatch and the artwork stays white. Flattening is what makes
 * these colours settable at all.
 */

export interface PulseLinesProps {
  shape?: 'line' | 'circle' | 'square';
  cornerRadius?: number;
  type?: 'vertical' | 'horizontal';
  paletteCount?: number;
  color1?: string;
  color2?: string;
  color3?: string;
  color4?: string;
  color5?: string;
  lineColor?: string;
  backgroundColor?: string;
  speed?: number;
  lineWidth?: number;
  gap?: number;
  scale?: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface LineVars extends CSSProperties {
  '--delay': string;
  '--pulse': string;
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

export default function PulseLines({
  shape = 'line',
  cornerRadius = 0,
  type = 'vertical',
  paletteCount = 1,
  color1 = '#FFFFFF',
  color2 = '#FFFFFF',
  color3 = '#FFFFFF',
  color4 = '#FFFFFF',
  color5 = '#FFFFFF',
  lineColor = '#222222',
  backgroundColor = '#000000',
  speed = 99,
  lineWidth = 2,
  gap = 30,
  scale = 2.5
}: PulseLinesProps) {
  const rawId = useId();
  const instanceId = `pulse-lines-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const horizontal = type === 'horizontal';

  const maxRadius = lineWidth / 2;
  const r = shape === 'square' ? Math.max(0, Math.min(cornerRadius, maxRadius)) : 0;
  const strokeLinecap = shape === 'circle' || (shape === 'square' && r > 0) ? 'round' : 'butt';
  const dashWidth =
    shape === 'line' ? 10 * scale : shape === 'circle' ? 0.01 : Math.max(0.01, lineWidth - 2 * r);

  const palette = buildPalette([color1, color2, color3, color4, color5], paletteCount);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

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

    return () => resizeObserver.disconnect();
  }, []);

  const styleContent = `
.${instanceId}-l {
\t--dash-width: ${dashWidth};
\t--gap-width: ${100 * scale};

\tstroke-linecap: ${strokeLinecap};
\tstroke-dasharray: var(--dash-width) var(--gap-width);
\tstroke-dashoffset: var(--dash-width);
\twill-change: stroke, stroke-dashoffset;
\tanimation: ${instanceId}-pulse 2s cubic-bezier(0.65, 0, 0.35, 1) infinite alternate-reverse;
\tanimation-delay: var(--delay);
}

@keyframes ${instanceId}-pulse {
\t0% { stroke-dashoffset: var(--dash-width); }
\t50% { stroke: var(--pulse); }
\t100% { stroke-dashoffset: calc(var(--gap-width) * -8px + 40px); }
}`;

  const span = horizontal ? dimensions.height : dimensions.width;
  const ready = dimensions.width > 0 && dimensions.height > 0;
  const rawLines = Math.ceil(span / (gap + lineWidth));
  const numLines = Math.max(1, rawLines) + (rawLines % 2 === 1 ? 1 : 0);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" style={{ backgroundColor }}>
      <style>{styleContent}</style>
      <svg
        className="pointer-events-none absolute inset-0 block h-full w-full"
        viewBox={`0 0 ${Math.max(1, dimensions.width)} ${Math.max(1, dimensions.height)}`}
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        key={`pulse-lines-${numLines}`}
      >
        {ready &&
          Array.from({ length: numLines }).map((_, i) => {
            const pos = numLines > 1 ? (i / (numLines - 1)) * span : 0;
            const delayFactor = 1 - Math.abs((i - numLines / 2) / numLines);
            const t = numLines > 1 ? i / (numLines - 1) : 0;
            const dash = paletteAt(palette, t);
            const pulse = paletteAt(palette, (t + 0.5) % 1);
            const coords = horizontal
              ? { x1: 0, y1: pos, x2: dimensions.width, y2: pos }
              : { x1: pos, y1: 0, x2: pos, y2: dimensions.height };
            const vars: LineVars = {
              '--delay': `${(delayFactor * speed) / 50}s`,
              '--pulse': pulse
            };
            return (
              <g style={vars} key={i}>
                <line {...coords} stroke={lineColor} strokeWidth={lineWidth} />
                <line {...coords} stroke={dash} strokeWidth={lineWidth} className={`${instanceId}-l`} />
              </g>
            );
          })}
      </svg>
    </div>
  );
}

import { useEffect, useRef, type CSSProperties } from 'react';

import { resolveBufferRatio } from '../render-scale';

interface ParticleTunnelProps {
  x?: number; // percent of width
  y?: number; // percent of height
  radius?: number; // px radius of the central void
  density?: number; // number of radial spokes
  gap?: number; // depth spacing between particles along a spoke
  particleSize?: number;
  colors?: string[];
  direction?: 'inside' | 'outside';
  speed?: number;
  voidColor?: string;
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

interface ProjectedParticle {
  x: number;
  y: number;
  size: number;
  alpha: number;
  z: number;
  color: string;
}

/**
 * ParticleTunnel - a 3D particle tunnel flowing along radial spokes toward a
 * central circular void, with mathematically consistent gaps. Wall-clock
 * driven, so it plays on its own with no pointer input.
 *
 * The defaults below must match the catalog's control defaults. Nothing merges
 * the catalog in on the render path — a stored props record that is empty or
 * missing a key falls through to this signature — so a default that disagrees
 * with the catalog is what an unedited card actually renders. `radius` was 100
 * against the catalog's 10: past the card's own width, so the void disc covered
 * the whole thing in `voidColor`.
 */
export default function ParticleTunnel({
  x = 50,
  y = 50,
  radius = 10,
  density = 30,
  gap = 40,
  particleSize = 4,
  colors = ['#ffffff'],
  direction = 'inside',
  speed = 2,
  voidColor = '#000000',
  backgroundColor = 'transparent',
  className = '',
  style = {}
}: ParticleTunnelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  // Mathematical flow offset along Z depth.
  const offsetRef = useRef(0);
  // Array identity changes each render; the effect keys on contents instead.
  const colorsRef = useRef<string[]>(colors);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    colorsRef.current = colors;
  });
  const colorsKey = colors.join(',');

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const palette = colorsRef.current.length ? colorsRef.current : ['#ffffff'];

    // Direction + speed -> signed flow rate along Z. "inside" pulls particles
    // toward the void, "outside" pushes them away.
    const speedAmt = Math.max(0, speed) / 2;
    const flowSpeed = direction === 'inside' ? -speedAmt : speedAmt;

    const perspective = 200;
    const tunnelSpread = 1;
    const maxDepth = 600;

    const measure = (entry?: ResizeObserverEntry) => {
      const cr = entry?.contentRect;
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(cr?.width || container.clientWidth || rect.width));
      const h = Math.max(1, Math.floor(cr?.height || container.clientHeight || rect.height));
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context transform
      // still maps CSS units into it — so every feature this effect draws keeps
      // the size the operator configured, at a lower sampling density. See
      // `render-scale.ts`.
      const dpr = resolveBufferRatio(w, h, Math.min(window.devicePixelRatio || 1, 2));
      const prev = sizeRef.current;
      if (prev.w === w && prev.h === h && prev.dpr === dpr) return;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    };

    measure();
    const ro = new ResizeObserver(entries => measure(entries[0]));
    ro.observe(container);

    let lastTime = performance.now();

    const wrap = (val: number, max: number) => ((val % max) + max) % max;

    const draw = (now: number) => {
      const dt = Math.min((now - lastTime) / 16.667, 3); // normalize to ~60fps
      lastTime = now;

      const { w, h, dpr } = sizeRef.current;

      // Update the depth offset for continuous Z movement.
      offsetRef.current = wrap(offsetRef.current - flowSpeed * dt, maxDepth);

      // Transparent canvas - cleared each frame so the card behind shows through.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;

      // Void position: 0% = left/top edge, 50 = centre, 100 = right/bottom.
      const centreCx = (x / 100) * w;
      const centreCy = (y / 100) * h;

      // Offset from the centre drives the tunnel parallax skew with depth.
      const oxPx = centreCx - cx;
      const oyPx = centreCy - cy;

      const scaleVoid = perspective / (perspective + maxDepth);

      // Base 3D radius that projects exactly to `radius` at maxDepth.
      const rCentre3d = radius / scaleVoid;

      // 1. Generate and project the particles.
      const activeDensity = Math.max(density, 1); // number of spokes
      const activeGap = Math.max(gap, 10); // depth spacing
      // Tile the depth cycle with a whole number of evenly spaced slots so the
      // wrap is seamless - an inclusive loop puts an extra particle on the seam,
      // overlapping another into a doubled (~2x brighter) ring.
      const particlesPerSpoke = Math.max(1, Math.round(maxDepth / activeGap));
      const effGap = maxDepth / particlesPerSpoke;

      const projected: ProjectedParticle[] = [];

      for (let i = 0; i < activeDensity; i++) {
        const baseAngle = (i / activeDensity) * Math.PI * 2;

        for (let k = 0; k < particlesPerSpoke; k++) {
          const z = wrap(offsetRef.current + k * effGap, maxDepth);
          const depthFactor = z / maxDepth;
          const scale = perspective / (perspective + z);

          // Projected tunnel centre at this particle's depth.
          const projCx = cx + oxPx * depthFactor;
          const projCy = cy + oyPx * depthFactor;

          // 3D radius, scaled down as it goes deeper.
          const r3d = rCentre3d + (1 - depthFactor) * tunnelSpread * (w / 2);
          const rProj = r3d * scale;

          const px = projCx + rProj * Math.cos(baseAngle);
          const py = projCy + rProj * Math.sin(baseAngle);

          // Clip off-screen particles.
          if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;

          // Size scales with 3D perspective.
          const size = Math.max(0.4, particleSize * scale);

          // Depth fade: opacity drops as particles approach the void.
          const alpha = Math.max(0.05, 1 - depthFactor * 0.9);

          // Colour cycles down both spokes and depth for visual harmony.
          const colorIdx = (i + k) % palette.length;

          projected.push({
            x: px,
            y: py,
            size,
            alpha,
            z,
            color: palette[colorIdx]
          });
        }
      }

      // Sort back-to-front (Z-buffer simulation) so overlaps layer correctly.
      projected.sort((a, b) => b.z - a.z);

      for (let i = 0; i < projected.length; i++) {
        const pt = projected[i];
        ctx.globalAlpha = pt.alpha;
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1.0;

      // 2. The central void, drawn over the particles.
      ctx.fillStyle = voidColor;
      ctx.beginPath();
      ctx.arc(centreCx, centreCy, radius, 0, Math.PI * 2);
      ctx.fill();

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    return () => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
      ro.disconnect();
    };
  }, [x, y, radius, density, gap, particleSize, colorsKey, direction, speed, voidColor]);

  return (
    <div
      ref={containerRef}
      style={{ backgroundColor, ...style }}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

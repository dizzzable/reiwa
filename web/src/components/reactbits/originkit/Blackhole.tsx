import { useEffect, useRef } from 'react';

import { resolveBufferRatio } from '../render-scale';

/**
 * Blackhole — accretion disk with true depth occlusion.
 *
 * Ported from Originkit `blackhole` (preset `base`). Canvas 2D on two stacked
 * canvases: particles behind the event horizon are drawn on the lower canvas,
 * the horizon sphere on top of them, and particles in front on the upper one.
 * The "3D" is hand-rolled perspective projection plus a per-frame depth sort.
 *
 * The source ships `particleCount: 1000`, which is 1000 integrations plus two
 * array sorts every frame on the CPU. See the `particleCount` prop for the
 * default chosen here.
 */

interface Particle {
  /** Orbit angle, radians. */
  angle: number;
  /** Orbital radius from the core, world px. */
  radius: number;
  /** Vertical displacement from the disk plane. */
  height: number;
  /** Per-particle velocity variance, 0.75..1.25. */
  speedOffset: number;
  /** Index into the `colors` array. */
  colorIdx: number;
}

export interface BlackholeProps {
  /** Draws the central event-horizon sphere. */
  showCenter?: boolean;
  /** Radius of the event horizon, world px. */
  voidRadius?: number;
  /** Horizontal position of the core, 0..100 % of the card. */
  voidX?: number;
  /** Vertical position of the core, 0..100 % of the card. */
  voidY?: number;
  /** Colours assigned at random across the orbiting particles. */
  colors?: string[];
  /** Stage colour. Also fills the event horizon, per the source's intent. */
  background?: string;
  /** Outward reach of the disk, 0..100 % of half the card width. */
  outerRadius?: number;
  /** Particles in the disk. See note above about the default. */
  particleCount?: number;
  /** Particle diameter slider, 1..50. */
  particleSize?: number;
  /** Orbital speed. */
  orbitSpeed?: number;
  /** Motion-trail length, 0..50. 0 clears every frame. */
  trail?: number;
  /** Inclination of the disk plane toward the viewer, degrees. */
  tilt?: number;
  /** Sideways roll of the disk around its axis, degrees. */
  tiltSideway?: number;
  /** Inward spiral rate, 0..20. 0 keeps stable orbits. */
  pullSpeed?: number;
}

/** Fixed 3D projection depth. Not a control in the source either. */
const PERSPECTIVE = 1300;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb` / `rgb()` / `rgba()` into 0..255 channels. */
function parseRgb(input: string): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  const value = (input || '').trim();
  if (!value) return { r, g, b };

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else if (value.startsWith('rgb')) {
    const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      r = parseInt(match[1], 10);
      g = parseInt(match[2], 10);
      b = parseInt(match[3], 10);
    }
  }
  return {
    r: Number.isFinite(r) ? r : 0,
    g: Number.isFinite(g) ? g : 0,
    b: Number.isFinite(b) ? b : 0
  };
}

export default function Blackhole({
  showCenter = true,
  voidRadius = 40,
  voidX = 50,
  voidY = 50,
  colors = ['#ffffff'],
  background = '#000000',
  outerRadius = 70,
  particleCount = 260,
  particleSize = 4,
  orbitSpeed = 4,
  trail = 50,
  tilt = 20,
  tiltSideway = 160,
  pullSpeed = 0
}: BlackholeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const fgCanvasRef = useRef<HTMLCanvasElement>(null);

  // Live config bag, rebuilt every render. The animation effect reads it and
  // never re-runs, so tweaking a control cannot restart the loop.
  const cfgRef = useRef({
    showCenter,
    voidRadius,
    voidX,
    voidY,
    colors,
    background,
    outerRadius,
    particleCount,
    particleSize,
    orbitSpeed,
    trail,
    tilt,
    tiltSideway,
    pullSpeed
  });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    cfgRef.current = {
      showCenter,
      voidRadius,
      voidX,
      voidY,
      colors,
      background,
      outerRadius,
      particleCount,
      particleSize,
      orbitSpeed,
      trail,
      tilt,
      tiltSideway,
      pullSpeed
    };
  });

  useEffect(() => {
    const container = containerRef.current;
    const bgCanvas = bgCanvasRef.current;
    const fgCanvas = fgCanvasRef.current;
    if (!container || !bgCanvas || !fgCanvas) return;

    const ctx = bgCanvas.getContext('2d');
    const fgCtx = fgCanvas.getContext('2d');
    if (!ctx || !fgCtx) return;

    let particles: Particle[] = [];
    // Seeding is keyed on the particle *count* alone. It used to also key on
    // the rounded outer radius, which is derived from the container width — so
    // an animated width (the address bar collapsing, a card transition) tore
    // the disk down and re-scattered it on every frame of the resize, and the
    // particles visibly teleported. Geometry changes now rescale the existing
    // orbits instead; only a change in how many particles exist re-seeds.
    let seededCount = -1;
    let seededColorCount = -1;
    let seededHorizon = 0;
    let seededOuter = 0;
    let size = { w: 1, h: 1 };
    let dpr = 1;
    let rafId = 0;

    // Projected points, one slot per particle, reused every frame. The frame
    // used to allocate a `{x,y,size,alpha,z,color}` object per particle — up to
    // 600 short-lived objects at 60 fps. The two draw orders are index lists
    // into these buffers.
    let projX = new Float32Array(0);
    let projY = new Float32Array(0);
    let projSize = new Float32Array(0);
    let projAlpha = new Float32Array(0);
    let projZ = new Float32Array(0);
    let projColorIdx = new Int32Array(0);
    const backOrder: number[] = [];
    const frontOrder: number[] = [];
    const byDepth = (a: number, b: number) => projZ[b] - projZ[a];

    const ensureProjection = (count: number) => {
      if (projX.length === count) return;
      projX = new Float32Array(count);
      projY = new Float32Array(count);
      projSize = new Float32Array(count);
      projAlpha = new Float32Array(count);
      projZ = new Float32Array(count);
      projColorIdx = new Int32Array(count);
    };

    // The event horizon's two gradients depend only on the core's position,
    // radius and colour. Rebuilding them per frame cost two gradient objects
    // and ten interpolated strings for a picture that almost never changes.
    let sphereGrad: CanvasGradient | null = null;
    let rimGrad: CanvasGradient | null = null;
    let gradCx = NaN;
    let gradCy = NaN;
    let gradHorizon = NaN;
    let gradBackground = '';
    let trailFill = '';
    let trailFillAlpha = NaN;

    const applySize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      // The area is passed DOUBLED: this effect keeps two full-size bitmaps —
      // a background and a foreground — and clears and redraws both every
      // frame, so its real cost is twice what one canvas of this size implies.
      dpr = resolveBufferRatio(w * 2, h, Math.min(window.devicePixelRatio || 1, 2));
      const bw = Math.max(1, Math.floor(w * dpr));
      const bh = Math.max(1, Math.floor(h * dpr));
      if (bgCanvas.width !== bw || bgCanvas.height !== bh) {
        bgCanvas.width = bw;
        bgCanvas.height = bh;
        fgCanvas.width = bw;
        fgCanvas.height = bh;
      }
      size = { w, h };
    };

    /** 0 % sits on the horizon, 100 % reaches the card edge (full width). */
    const resolveOuterRadius = (horizon: number) => {
      const maxR = size.w / 2;
      const pct = Math.max(0, Math.min(100, cfgRef.current.outerRadius)) / 100;
      // Half the card can land inside the horizon - a card measured at 0x0
      // before layout puts it at 0.5px against a 40px core. Interpolating
      // across that negative gap returned an outer radius *smaller* than the
      // horizon, and an inverted annulus is not a disk anyone can rescale.
      // Clamped, the degenerate case comes out as outer === horizon, which is
      // the one shape the re-seed below is built to recognise.
      return horizon + pct * Math.max(0, maxR - horizon);
    };

    const seedParticles = (count: number, horizon: number, outer: number, colorCount: number) => {
      const next: Particle[] = [];
      for (let i = 0; i < count; i++) {
        // Squared distribution so density rises toward the event horizon.
        const radius = horizon + Math.pow(Math.random(), 2) * (outer - horizon);
        next.push({
          angle: Math.random() * Math.PI * 2,
          radius,
          height: (Math.random() - 0.5) * 16,
          speedOffset: 0.75 + Math.random() * 0.5,
          colorIdx: Math.floor(Math.random() * Math.max(1, colorCount))
        });
      }
      particles = next;
      ensureProjection(count);
    };

    /**
     * The disk geometry moved — the card was resized, the core resized, or the
     * horizon was toggled. Rescale every orbit into the new annulus rather than
     * re-scattering, so a width animation reads as the disk growing instead of
     * the particles jumping to new places sixty times a second.
     */
    const rescaleParticles = (horizon: number, outer: number) => {
      const oldSpan = seededOuter - seededHorizon;
      const newSpan = outer - horizon;
      for (let i = 0; i < particles.length; i++) {
        const pt = particles[i];
        const t = oldSpan > 0 ? (pt.radius - seededHorizon) / oldSpan : 0;
        pt.radius = horizon + t * newSpan;
      }
    };

    applySize();
    const resizeObserver = new ResizeObserver(applySize);
    resizeObserver.observe(container);

    let lastTime = performance.now();

    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw);

      const cfg = cfgRef.current;
      const { w, h } = size;

      const horizon = cfg.showCenter !== false ? cfg.voidRadius : 1;
      const outerRad = resolveOuterRadius(horizon);
      const count = Math.max(0, Math.round(cfg.particleCount));
      const colorList = cfg.colors.length > 0 ? cfg.colors : ['#ffffff'];

      if (count !== seededCount) {
        // A different number of particles is a different disk; nothing to carry.
        seedParticles(count, horizon, outerRad, colorList.length);
        seededCount = count;
        seededColorCount = colorList.length;
        // Seeded at the current geometry, so the rescale below must not fire.
        seededHorizon = horizon;
        seededOuter = outerRad;
      } else if (colorList.length !== seededColorCount) {
        // Only the palette changed. Reassign colours in place — the layout of
        // the disk has nothing to do with how many colours it uses.
        for (let i = 0; i < particles.length; i++) {
          particles[i].colorIdx = Math.floor(Math.random() * Math.max(1, colorList.length));
        }
        seededColorCount = colorList.length;
      }
      if (horizon !== seededHorizon || outerRad !== seededOuter) {
        if (!(seededOuter > seededHorizon)) {
          // The seeded annulus has no width to preserve. This used to test for
          // equality alone, which only caught the exactly-degenerate case; a
          // card measured at 0x0 produced an *inverted* one (at width 1 the
          // resolved outer radius was 12.35 against a horizon of 40), the test
          // missed it, and `rescaleParticles` ran with a negative span. Its
          // `oldSpan > 0` fallback then put every single orbit at t = 0, i.e.
          // exactly on the horizon — where the respawn test `radius < horizon`
          // is false and the default `pullSpeed` of 0 never moves it again. The
          // disk stayed a one-pixel ring for the life of the component.
          seedParticles(count, horizon, outerRad, colorList.length);
        } else {
          rescaleParticles(horizon, outerRad);
        }
      }
      seededHorizon = horizon;
      seededOuter = outerRad;

      const dt = Math.min((now - lastTime) / 16.667, 3);
      lastTime = now;

      // Slider 1..50 → 0.5..4.5 px.
      const dotSize = 0.5 + (Math.max(1, Math.min(50, cfg.particleSize)) - 1) * (4 / 49);
      const pull = Math.max(0, cfg.pullSpeed) / 2;
      const trailAlpha = Math.max(0.02, 1 - (Math.max(0, cfg.trail) / 50) * 0.98);
      if (trailAlpha !== trailFillAlpha) {
        trailFillAlpha = trailAlpha;
        trailFill = `rgba(0, 0, 0, ${trailAlpha})`;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      fgCtx.globalAlpha = 1;

      // Fade the trails with destination-out so both canvases stay transparent
      // and the container background shows through.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = trailFill;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';

      fgCtx.globalCompositeOperation = 'destination-out';
      fgCtx.fillStyle = trailFill;
      fgCtx.fillRect(0, 0, w, h);
      fgCtx.globalCompositeOperation = 'source-over';

      const voidCx = (cfg.voidX / 100) * w;
      const voidCy = (cfg.voidY / 100) * h;
      const tiltRad = (cfg.tilt * Math.PI) / 180;
      const tiltSidewayRad = (cfg.tiltSideway * Math.PI) / 180;
      const cosTilt = Math.cos(tiltRad);
      const sinTilt = Math.sin(tiltRad);
      const cosRoll = Math.cos(tiltSidewayRad);
      const sinRoll = Math.sin(tiltSidewayRad);

      backOrder.length = 0;
      frontOrder.length = 0;

      for (let i = 0; i < particles.length; i++) {
        const pt = particles[i];

        // Orbital velocity rises near the core (v ~ 1/sqrt(r)).
        const speedFactor = Math.sqrt(horizon / Math.max(pt.radius, 10));
        pt.angle += cfg.orbitSpeed * speedFactor * pt.speedOffset * 0.012 * dt;
        pt.radius -= pull * speedFactor * pt.speedOffset * dt;

        // Consumed by the core — respawn near the outer rim.
        if (pt.radius < horizon) {
          pt.radius = horizon + 0.7 * (outerRad - horizon) + Math.random() * 0.3 * (outerRad - horizon);
          pt.angle = Math.random() * Math.PI * 2;
          pt.height = (Math.random() - 0.5) * 16;
          continue;
        }

        const xBase = pt.radius * Math.cos(pt.angle);
        const yBase = pt.height;
        const zBase = pt.radius * Math.sin(pt.angle);

        // Inclination about X, then roll about Z.
        const y1 = yBase * cosTilt + zBase * sinTilt;
        const z1 = -yBase * sinTilt + zBase * cosTilt;
        const x3d = xBase * cosRoll - y1 * sinRoll;
        const y3d = xBase * sinRoll + y1 * cosRoll;
        const z3d = z1;

        const scale = PERSPECTIVE / (PERSPECTIVE + z3d);
        const px = voidCx + x3d * scale;
        const py = voidCy + y3d * scale;
        if (px < -30 || px > w + 30 || py < -30 || py > h + 30) continue;

        projX[i] = px;
        projY[i] = py;
        projSize[i] = Math.max(0.3, dotSize * scale);
        projAlpha[i] = Math.max(0.35, 1 - ((z3d + outerRad) / (2 * outerRad)) * 0.45);
        projZ[i] = z3d;
        projColorIdx[i] = pt.colorIdx % colorList.length;

        if (z3d >= 0) backOrder.push(i);
        else frontOrder.push(i);
      }

      // Back-to-front, so the horizon can occlude what is behind it.
      backOrder.sort(byDepth);
      frontOrder.sort(byDepth);

      for (let k = 0; k < backOrder.length; k++) {
        const i = backOrder[k];
        ctx.globalAlpha = projAlpha[i];
        ctx.fillStyle = colorList[projColorIdx[i]];
        ctx.beginPath();
        ctx.arc(projX[i], projY[i], projSize[i], 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (cfg.showCenter !== false) {
        if (
          !sphereGrad ||
          !rimGrad ||
          voidCx !== gradCx ||
          voidCy !== gradCy ||
          horizon !== gradHorizon ||
          cfg.background !== gradBackground
        ) {
          const voidRgb = parseRgb(cfg.background);
          const edgeR = Math.min(255, voidRgb.r + 18);
          const edgeG = Math.min(255, voidRgb.g + 18);
          const edgeB = Math.min(255, voidRgb.b + 18);

          sphereGrad = ctx.createRadialGradient(
            voidCx - horizon * 0.25,
            voidCy - horizon * 0.3,
            horizon * 0.05,
            voidCx,
            voidCy,
            horizon
          );
          sphereGrad.addColorStop(
            0,
            `rgba(${Math.min(255, voidRgb.r + 8)}, ${Math.min(255, voidRgb.g + 8)}, ${Math.min(255, voidRgb.b + 8)}, 1)`
          );
          sphereGrad.addColorStop(0.65, `rgba(${voidRgb.r}, ${voidRgb.g}, ${voidRgb.b}, 1)`);
          sphereGrad.addColorStop(0.92, `rgba(${edgeR}, ${edgeG}, ${edgeB}, 1)`);
          sphereGrad.addColorStop(1, `rgba(${edgeR}, ${edgeG}, ${edgeB}, 0.9)`);

          // Rim light, so the sphere reads as a sphere and not a hole.
          rimGrad = ctx.createRadialGradient(voidCx, voidCy, horizon * 0.88, voidCx, voidCy, horizon * 1.02);
          rimGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
          rimGrad.addColorStop(0.6, 'rgba(180, 180, 200, 0.06)');
          rimGrad.addColorStop(0.85, 'rgba(180, 180, 200, 0.12)');
          rimGrad.addColorStop(1, 'rgba(180, 180, 200, 0)');

          gradCx = voidCx;
          gradCy = voidCy;
          gradHorizon = horizon;
          gradBackground = cfg.background;
        }

        ctx.fillStyle = sphereGrad;
        ctx.beginPath();
        ctx.arc(voidCx, voidCy, horizon, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = rimGrad;
        ctx.beginPath();
        ctx.arc(voidCx, voidCy, horizon * 1.02, 0, Math.PI * 2);
        ctx.fill();
      }

      for (let k = 0; k < frontOrder.length; k++) {
        const i = frontOrder[k];
        fgCtx.globalAlpha = projAlpha[i];
        fgCtx.fillStyle = colorList[projColorIdx[i]];
        fgCtx.beginPath();
        fgCtx.arc(projX[i], projY[i], projSize[i], 0, Math.PI * 2);
        fgCtx.fill();
      }
      fgCtx.globalAlpha = 1;
    };

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      particles = [];
      backOrder.length = 0;
      frontOrder.length = 0;
    };
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" style={{ background }}>
      <canvas ref={bgCanvasRef} className="absolute inset-0 block h-full w-full" />
      <canvas ref={fgCanvasRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
    </div>
  );
}

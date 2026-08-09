import { useEffect, useRef, type CSSProperties } from 'react';

import { resolveBufferRatio } from '../render-scale';

/** Parse hex/rgb to [r, g, b] 0-255 - done once per prop change, never per frame. */
function parseColor(input: string): [number, number, number] {
  if (!input) return [255, 255, 255];
  const s = input.trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map(c => c + c)
        .join('');
    }
    const num = parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map(p => parseFloat(p.trim()));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }
  return [255, 255, 255];
}

interface StarBurstProps {
  speed?: number;
  starCount?: number;
  color?: string;
  centerX?: number; // percent of width
  centerY?: number; // percent of height
  starSize?: number;
  opacity?: number; // 0-100
  flowerIntensity?: number;
  twinkleSpeed?: number;
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * StarBurst - a radial explosion of light emanating from a focal point.
 * `starCount` evenly spaced spokes radiate outward; along each spoke a column
 * of small bright pulses travels from the centre outward, twinkling as it
 * goes. A soft "flower" radial bloom sits at the centre, layered behind the
 * pulses for a glowing core.
 *
 * Particle spawn phases are seeded (Mulberry32, seed 0xBADF00D) so the burst
 * pattern is stable across reloads; motion is rAF-driven and time-based.
 */
export default function StarBurst({
  speed = 10,
  starCount = 100,
  color = '#FFFFFF',
  centerX = 50,
  centerY = 100,
  starSize = 12,
  opacity = 50,
  flowerIntensity = 10,
  twinkleSpeed = 4,
  backgroundColor = '#000000',
  className = '',
  style = {}
}: StarBurstProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cStar = parseColor(color);

    // Controls are authored as whole-number sliders (step 1); divide back to
    // the fractional working ranges the visuals expect.
    const safeSpeed = Math.max(0, speed / 10);
    const safeCenterX = Math.max(0, Math.min(1, centerX / 100));
    const safeCenterY = Math.max(0, Math.min(1, centerY / 100));
    const safeStarSize = Math.max(0.01, starSize / 20);
    const safeOpacity = Math.max(0, Math.min(1, opacity / 100));
    const safeFlowerIntensity = Math.max(0, flowerIntensity / 20);
    const safeTwinkleSpeed = Math.max(0, twinkleSpeed / 20);

    // Seeded PRNG (Mulberry32). A fixed seed makes the per-spoke phase offsets
    // and per-pulse phase seeds identical across reloads, so the burst reads
    // the same on every refresh. Motion advances with real-time dt.
    const makeRng = (seed: number) => {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const rng = makeRng(0xbadf00d);

    // Clamp star count; pulses per spoke is fixed at 15, and the total is
    // capped for perf safety. Dense per-spoke counts let overlapping streaks
    // form continuous-looking rays.
    const sCount = Math.max(0, Math.floor(starCount));
    const pulsesPerSpoke = 15;
    const MAX_TOTAL = 5000;
    const nSpokes = sCount;
    let perSpoke = pulsesPerSpoke;
    if (nSpokes * perSpoke > MAX_TOTAL) {
      // Prefer keeping the spoke count (the burst's shape) and trim the
      // pulses per spoke instead.
      perSpoke = Math.max(1, Math.floor(MAX_TOTAL / Math.max(1, nSpokes)));
    }
    const particleCount = nSpokes * perSpoke;

    // Spoke angles, with small phase jitter so spokes don't twinkle in lockstep.
    const spokeAngle = new Float32Array(nSpokes);
    const spokeCos = new Float32Array(nSpokes);
    const spokeSin = new Float32Array(nSpokes);
    for (let i = 0; i < nSpokes; i++) {
      const baseAngle = (i / Math.max(1, nSpokes)) * Math.PI * 2;
      const jitter = (rng() - 0.5) * 0.02;
      spokeAngle[i] = baseAngle + jitter;
      spokeCos[i] = Math.cos(spokeAngle[i]);
      spokeSin[i] = Math.sin(spokeAngle[i]);
    }

    // Particle SoA buffers. Each pulse travels along one spoke from t=0
    // (centre) outward.
    const pSpokeIdx = new Uint16Array(particleCount);
    const pT = new Float32Array(particleCount); // distance along spoke, 0..~1.1
    const pSpeed = new Float32Array(particleCount); // dt-rate of pT growth
    const pSize = new Float32Array(particleCount); // size factor
    const pPhase = new Float32Array(particleCount); // twinkle phase (rad)

    for (let i = 0; i < particleCount; i++) {
      pSpokeIdx[i] = i % nSpokes;
      // Spread the initial pT across [-0.05, 1.05] so the first frame already
      // populates the full spoke length.
      pT[i] = -0.05 + rng() * 1.1;
      // Per-pulse speed variation prevents uniform-looking streaks.
      pSpeed[i] = (0.5 + rng() * 1.0) * 0.25;
      pSize[i] = 0.7 + rng() * 0.8;
      pPhase[i] = rng() * Math.PI * 2;
    }

    // Streak sprite. Bake the trailing->leading gradient ONCE into a tiny
    // offscreen canvas, then drawImage it per particle. This removes the
    // per-particle createLinearGradient + rgba() string allocations, whose GC
    // churn was the main source of stutter. Per-particle brightness is applied
    // via globalAlpha; the sprite holds the relative profile.
    const SPRITE_LEN = 64;
    const streak = document.createElement('canvas');
    streak.width = SPRITE_LEN;
    streak.height = 2;
    const sctx = streak.getContext('2d');
    if (sctx) {
      const g = sctx.createLinearGradient(0, 0, SPRITE_LEN, 0);
      g.addColorStop(0, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},0)`);
      g.addColorStop(0.7, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},0.6)`);
      g.addColorStop(1, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},1)`);
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SPRITE_LEN, 2);
    }

    const resize = (entry?: ResizeObserverEntry) => {
      // Prefer the observer's contentRect, then the layout box, then the
      // bounding rect - the first measurement can land before layout.
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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const ro = new ResizeObserver(entries => resize(entries[0]));
    ro.observe(container);

    // Accumulated time for the twinkle sin() - independent of dt clamping so
    // twinkles stay smooth even on dropped frames.
    let timeSec = 0;

    const drawFrame = (deltaSec: number) => {
      const { w, h, dpr } = sizeRef.current;
      const dt = Math.max(0.001, Math.min(0.05, deltaSec));
      timeSec += dt;

      if (w < 2 || h < 2) return;

      const cx = safeCenterX * w;
      const cy = safeCenterY * h;
      // Max spoke length - the diagonal, so spokes reach the far corner even
      // when the focal point sits in one corner.
      const R = Math.sqrt(w * w + h * h);

      // (1) Clear. The canvas itself stays transparent so the card behind
      // shows through; the backgroundColor prop paints the base instead.
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);

      // Switch to additive for all glow layers.
      ctx.globalCompositeOperation = 'lighter';

      // (2) Centre flower bloom - a small concentrated radial gradient, drawn
      // BEHIND the pulses so the spokes appear to emerge from it. Sized as a
      // fraction of the smaller dimension so it stays a contained glow.
      const bloomAlpha = safeFlowerIntensity * safeOpacity;
      if (bloomAlpha > 0.001) {
        const minDim = Math.min(w, h);
        const bloomR = Math.max(8, minDim * 0.18 * (safeFlowerIntensity * 0.5 + 0.5) * (0.6 + safeStarSize * 0.4));
        const a = Math.min(1, bloomAlpha);
        const fGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloomR);
        fGrad.addColorStop(0, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},${a})`);
        fGrad.addColorStop(0.3, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},${a * 0.5})`);
        fGrad.addColorStop(0.7, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},${a * 0.15})`);
        fGrad.addColorStop(1, `rgba(${cStar[0]},${cStar[1]},${cStar[2]},0)`);
        ctx.fillStyle = fGrad;
        ctx.fillRect(cx - bloomR, cy - bloomR, bloomR * 2, bloomR * 2);
      }

      // (3) Per-spoke pulse particles, drawn as thin streaks oriented along
      // their spoke. The trailing end (toward the centre) fades to
      // transparent; the leading end is bright. Overlapping streaks at high
      // density form continuous-looking rays.
      for (let i = 0; i < particleCount; i++) {
        // Update the along-spoke position. When a pulse passes the outer edge
        // it respawns just past centre so emission looks continuous.
        pT[i] += pSpeed[i] * safeSpeed * dt;
        if (pT[i] > 1.1) {
          pT[i] = -0.05 - rng() * 0.05;
          pSize[i] = 0.7 + rng() * 0.8;
          pPhase[i] = rng() * Math.PI * 2;
        }

        const t = pT[i];
        if (t < 0) continue; // not yet emerged this cycle
        if (t >= 1.0) continue;

        // Twinkle: 0.7..1.0 - subtle, so pulses never vanish at the trough.
        const twinkle = 0.7 + 0.3 * Math.sin(timeSec * safeTwinkleSpeed * 6 + pPhase[i]);

        // Alpha curve along the spoke: quick fade-in, full brightness across
        // the body, fast fade-out, so rays stay vivid nearly to the edge.
        let fade: number;
        if (t < 0.06) {
          fade = t / 0.06;
        } else if (t < 0.85) {
          fade = 1;
        } else {
          fade = 1 - (t - 0.85) / 0.15;
        }

        const a = Math.min(1, twinkle * fade * (1 + 0.5 * t) * safeOpacity);
        if (a < 0.005) continue;

        const dist = t * R;
        const sIdx = pSpokeIdx[i];
        const cosA = spokeCos[sIdx];
        const sinA = spokeSin[sIdx];

        // The head sits on the spoke at `dist`; the sprite extends back toward
        // the centre over `lineLen`.
        const px = cx + cosA * dist;
        const py = cy + sinA * dist;
        const speedFactor = pSpeed[i] / 0.25;
        const lineLen = (8 + 12 * speedFactor) * (0.7 + 0.6 * pSize[i] * safeStarSize);

        // Draw the pre-baked streak sprite oriented along the spoke via a
        // direct transform - no save/restore, no per-particle gradient.
        ctx.setTransform(dpr * cosA, dpr * sinA, -dpr * sinA, dpr * cosA, dpr * px, dpr * py);
        ctx.globalAlpha = a;
        ctx.drawImage(streak, -lineLen, -0.5, lineLen, 1);
      }

      // Restore the base transform / alpha for the next frame's bloom.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
    };

    let lastT = performance.now();
    const loop = (t: number) => {
      const deltaSec = (t - lastT) / 1000;
      lastT = t;
      drawFrame(deltaSec);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      // Drop the sprite's backing store rather than waiting for GC.
      streak.width = 0;
      streak.height = 0;
    };
  }, [speed, starCount, color, centerX, centerY, starSize, opacity, flowerIntensity, twinkleSpeed]);

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

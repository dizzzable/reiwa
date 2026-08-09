import { useEffect, useRef, type CSSProperties } from 'react';

import { resolveBufferRatio } from '../render-scale';

/** Colours arrive as #rgb, #rrggbb or rgb/rgba; fold any of them to [r, g, b, a]. */
function parseColor(input: string): [number, number, number, number] {
  if (!input) return [255, 255, 255, 1];
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
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map(p => parseFloat(p.trim()));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] == null ? 1 : parts[3]];
  }
  return [255, 255, 255, 1];
}

interface GlitterWrapProps {
  particleCount?: number;
  color1?: string;
  color2?: string;
  color3?: string;
  speed?: number;
  density?: number;
  starSize?: number;
  focalDepth?: number;
  turbulence?: number;
  brightness?: number;
  glitterIntensity?: number;
  trailAmount?: number;
  reverse?: boolean;
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * GlitterWrap - a perspective starfield warp tunnel with sparkle flashes.
 * Wall-clock driven, so it plays on its own with no pointer input.
 */
export default function GlitterWrap({
  particleCount = 500,
  color1 = '#ffffff',
  color2 = '#ffffff',
  color3 = '#ffffff',
  speed = 5,
  density = 100,
  starSize = 20,
  focalDepth = 8,
  turbulence = 0,
  brightness = 100,
  glitterIntensity = 3,
  trailAmount = 0,
  reverse = false,
  backgroundColor = 'transparent',
  className = '',
  style = {}
}: GlitterWrapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  // Latest props, read fresh each frame so control tweaks don't tear down and
  // rebuild the whole animation (which would re-init every star + the RAF).
  const propsRef = useRef({
    particleCount,
    color1,
    color2,
    color3,
    speed,
    density,
    starSize,
    focalDepth,
    turbulence,
    brightness,
    glitterIntensity,
    trailAmount,
    reverse
  });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    propsRef.current = {
      particleCount,
      color1,
      color2,
      color3,
      speed,
      density,
      starSize,
      focalDepth,
      turbulence,
      brightness,
      glitterIntensity,
      trailAmount,
      reverse
    };
  });

  // Cached parsed colours - only recomputed when the string value changes, so
  // the hot loop never runs a regex.
  const colorCacheRef = useRef({
    color1: '',
    color2: '',
    color3: '',
    parsed1: [255, 255, 255, 1] as [number, number, number, number],
    parsed2: [177, 158, 239, 1] as [number, number, number, number],
    parsed3: [205, 217, 255, 1] as [number, number, number, number]
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const getCachedColors = () => {
      const p = propsRef.current;
      const c = colorCacheRef.current;
      if (p.color1 !== c.color1) {
        c.color1 = p.color1;
        c.parsed1 = parseColor(p.color1);
      }
      if (p.color2 !== c.color2) {
        c.color2 = p.color2;
        c.parsed2 = parseColor(p.color2);
      }
      if (p.color3 !== c.color3) {
        c.color3 = p.color3;
        c.parsed3 = parseColor(p.color3);
      }
      return c;
    };

    interface Star {
      // Position in normalized space relative to centre
      x: number;
      y: number;
      z: number; // depth: 1 = far, ~0 = near
      // Previous projected screen position (for streaks)
      px: number;
      py: number;
      seed: number; // unique phase for turbulence + glitter
      vmul: number; // per-star speed multiplier (breaks up cohorts)
      colorIdx: number;
      flashUntil: number; // elapsed seconds until which it's flashing
      nextFlash: number; // elapsed seconds at which it can flash again
    }

    const stars: Star[] = [];
    // Elapsed wall-clock seconds. Turbulence + glitter cadence key off this
    // instead of a frame counter, so motion stays constant under variable
    // frame timing rather than jittering with each hitch.
    let elapsed = 0;
    let lastT = performance.now();

    // Map the integer UI controls to their internal working ranges in one
    // place, so the physics/render code stays in convenient units.
    const cfg = () => {
      const p = propsRef.current;
      return {
        reverse: p.reverse,
        density: p.density, //                1-100, used raw
        stepZ: p.speed * 0.0008, //           speed 1-10
        focalDepth: p.focalDepth / 100, //    1-30  -> 0.01-0.30
        starScale: p.starSize * 0.15, //      0-20  -> 0-3.0
        turbulence: p.turbulence * 0.2, //    0-10  -> 0-2
        glitter: p.glitterIntensity * 0.1, // 0-10  -> 0-1
        brightness: Math.min(1, p.brightness / 100), // 0-100%
        trail: p.trailAmount / 100 //         0-100%
      };
    };

    const resetStar = (s: Star, initial = false) => {
      const { density: spread, reverse: rev, focalDepth: focal, glitter } = cfg();
      // Spawn at a random angle around centre, at near-far depth.
      const angle = Math.random() * Math.PI * 2;
      const radius = (0.2 + Math.random() * 0.8) * (spread / 15);
      s.x = Math.cos(angle) * radius;
      s.y = Math.sin(angle) * radius;
      // Forward: spawn far (z=1), travel toward the focal point and outward.
      // Reverse is the exact time-reverse: same spawn, z runs the other way.
      if (rev) {
        s.z = initial ? focal + Math.random() * (1 - focal) : focal;
      } else {
        s.z = initial ? Math.random() : 1.0;
      }
      s.px = NaN;
      s.py = NaN;
      s.seed = Math.random() * 1000;
      // Varied per-star speed so synchronized respawns disperse instead of
      // travelling as one cohort (which reads as a pulsing wave).
      s.vmul = 0.6 + Math.random() * 0.8;
      s.colorIdx = Math.floor(Math.random() * 3);
      s.flashUntil = 0;
      // Seconds-based: ~1s minimum gap + up to ~4s scaled by glitter.
      s.nextFlash = elapsed + 1 + Math.random() * 4 * (1 / Math.max(0.0001, glitter));
    };

    const makeStar = (): Star => ({
      x: 0,
      y: 0,
      z: 0,
      px: NaN,
      py: NaN,
      seed: 0,
      vmul: 1,
      colorIdx: 0,
      flashUntil: 0,
      nextFlash: 0
    });

    // Grow or shrink the star pool to match the requested count without
    // rebuilding the whole array, so changing the count stays smooth.
    const syncCount = () => {
      const count = Math.max(1, Math.floor(propsRef.current.particleCount));
      if (stars.length === count) return;
      if (stars.length > count) {
        stars.length = count;
      } else {
        while (stars.length < count) {
          const s = makeStar();
          resetStar(s, true);
          stars.push(s);
        }
      }
    };

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

      // Bail when nothing changed. ResizeObserver fires spuriously (initial
      // observe, sub-pixel jitter, DPR shifts, parent relayout); each call
      // here would set canvas.width - which WIPES the canvas + trail buffer -
      // making the animation visibly break. Only clear on a real size change.
      const prev = sizeRef.current;
      if (prev.w === w && prev.h === h && prev.dpr === dpr) return;

      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Canvas stays transparent so the card behind shows through.
      ctx.clearRect(0, 0, w, h);
    };

    syncCount();
    resize();

    const ro = new ResizeObserver(entries => resize(entries[0]));
    ro.observe(container);

    const drawFrame = (deltaSec: number) => {
      const {
        reverse: rev,
        stepZ,
        focalDepth: focal,
        starScale,
        turbulence: wobble,
        glitter,
        brightness: bright,
        trail
      } = cfg();

      // Keep the pool sized to the live count, then read the palette fresh so
      // colour edits apply without an effect rebuild.
      syncCount();
      const colors = getCachedColors();
      const palette: Array<[number, number, number, number]> = [colors.parsed1, colors.parsed2, colors.parsed3];
      // Solid colour strings, built once per frame instead of per-star.
      // Per-star alpha rides on ctx.globalAlpha, so the hot loop allocates
      // nothing - the rgba()-per-star approach churned enough short-lived
      // strings for GC pauses to be the main source of stutter.
      const rgbStrs = [
        `rgb(${palette[0][0]}, ${palette[0][1]}, ${palette[0][2]})`,
        `rgb(${palette[1][0]}, ${palette[1][1]}, ${palette[1][2]})`,
        `rgb(${palette[2][0]}, ${palette[2][1]}, ${palette[2][2]})`
      ];

      const { w, h } = sizeRef.current;
      const cx = w / 2;
      const cy = h / 2;
      // Projection scale is tied to the smaller dimension so it adapts.
      const projScale = Math.min(w, h) * 0.9;

      // Cap deltaSec so a backgrounded tab doesn't jump on resume.
      const dt = Math.max(0.001, Math.min(0.1, deltaSec)) * 60; // "frames at 60fps"

      // Soft trails - fade prior pixels toward transparent so the card behind
      // shows through. destination-out subtracts alpha from existing pixels.
      // Decay is framerate-independent: `trail` is the fraction of the previous
      // frame kept per 1/60s, raised to dt, so trail length stays constant at
      // 60Hz, 120Hz or a stuttering variable rate. The floor keeps a little
      // erase even at trail=100 so the canvas never smears into a solid field.
      const keep = Math.pow(Math.min(0.98, Math.max(0, trail)), dt);
      const trailAlpha = Math.max(0.02, 1 - keep);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0, 0, 0, ${trailAlpha})`;
      ctx.fillRect(0, 0, w, h);

      // Switch to additive for the stars.
      ctx.globalCompositeOperation = 'lighter';

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];

        // Forward: z decreases toward focalDepth (stars fly outward).
        // Reverse: z increases toward 1 (stars recede into the centre).
        const vz = stepZ * s.vmul * dt;
        if (rev) {
          s.z += vz;
          if (s.z >= 1.0) {
            resetStar(s);
            continue;
          }
        } else {
          s.z -= vz;
          if (s.z <= focal) {
            resetStar(s);
            continue;
          }
        }

        // Turbulence: gentle sinusoidal wobble that grows as a star approaches.
        let tx = s.x;
        let ty = s.y;
        if (wobble > 0) {
          const t = elapsed * 1.2 + s.seed;
          const amp = wobble * (1 - s.z) * 0.25;
          tx += Math.sin(t + s.seed) * amp;
          ty += Math.cos(t * 1.13 + s.seed * 0.7) * amp;
        }

        // Project: as z -> 0 the star expands outward from centre.
        const persp = focal / Math.max(s.z, 0.0001);
        const sx = cx + tx * persp * projScale;
        const sy = cy + ty * persp * projScale;

        // Off-screen? Respawn - forward only. A reverse star is born at
        // z=focalDepth where persp=1, which can place it past the edge; it
        // then travels inward ONTO the screen, so culling on sight would kill
        // it before it appears.
        if (!rev && (sx < -20 || sx > w + 20 || sy < -20 || sy > h + 20)) {
          resetStar(s);
          continue;
        }

        // Glitter flash logic.
        let flashMult = 1;
        if (glitter > 0) {
          if (elapsed >= s.nextFlash && s.flashUntil < elapsed) {
            // Flash for ~40-110ms, then schedule the next one.
            s.flashUntil = elapsed + 0.04 + Math.random() * 0.07;
            s.nextFlash = elapsed + 1 + Math.random() * 4 * (1 / Math.max(0.0001, glitter));
          }
          if (elapsed <= s.flashUntil) {
            flashMult = 1 + 2.5 * glitter;
          }
        }

        // Size grows as z -> 0. The cap scales with starScale so the size
        // control stays visibly distinct across its whole range.
        const sizePersp = Math.min(2.5, (focal / Math.max(s.z, 0.0001)) * 0.6);
        const baseR = Math.max(0.25, starScale * (0.4 + sizePersp));
        const maxR = 1 + starScale * 2.5;
        const r = Math.min(baseR * flashMult, maxR);

        // Alpha - brighter as it nears, modulated by brightness. In reverse
        // stars travel from the edge inward and would fade too early on the
        // forward curve, so they stay bright for most of the journey.
        const lifeT = rev ? s.z : 1 - s.z; // 0=spawn, 1=despawn
        // Reverse spawns at the edge already bright, so each respawn pops.
        // Ramp alpha over the first ~12% of the journey so stars fade in.
        const fadeIn = rev ? Math.min(1, (s.z - focal) / (1 - focal) / 0.12) : 1;
        const a =
          Math.min(1, rev ? 0.85 - lifeT * 0.6 : lifeT * 0.9 + 0.05) * fadeIn * bright * (flashMult > 1 ? 1 : 0.85);

        const colStr = rgbStrs[s.colorIdx];

        // Streak from the previous projected position to the current one.
        if (!Number.isNaN(s.px) && !Number.isNaN(s.py)) {
          ctx.globalAlpha = a * 0.5;
          ctx.strokeStyle = colStr;
          ctx.lineWidth = Math.max(0.4, r * 0.4);
          ctx.beginPath();
          ctx.moveTo(s.px, s.py);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }

        // Tiny dot head - fillRect instead of arc(): at sub-pixel radii a
        // square reads identically but skips per-star path tessellation.
        ctx.globalAlpha = a;
        ctx.fillStyle = colStr;
        ctx.fillRect(sx - r, sy - r, r * 2, r * 2);

        // The flash adds a fainter, slightly larger square so it reads as a
        // sparkle rather than a halo.
        if (flashMult > 1) {
          const rf = Math.min(r * 1.4, maxR * 1.4);
          ctx.globalAlpha = a * 0.5;
          ctx.fillRect(sx - rf, sy - rf, rf * 2, rf * 2);
        }

        s.px = sx;
        s.py = sy;
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // Cap like the motion dt so a backgrounded-tab jump doesn't snap the
      // turbulence phase or fire every glitter flash at once on resume.
      elapsed += Math.min(0.1, Math.max(0, deltaSec));
    };

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
    };
    // Single setup. Every animated value is read from propsRef each frame, so
    // control changes apply live without rebuilding the stars and the RAF.
  }, []);

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

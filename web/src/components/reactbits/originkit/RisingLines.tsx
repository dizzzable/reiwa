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

interface RisingLinesProps {
  particles?: number; // spark count at the 800x400 reference frame
  color?: string;
  riseSpeed?: number; // 0-60  -> /100 -> 0-0.6
  opacity?: number; // 0-100 -> /100 -> 0-1
  scale?: number; // 1-20  -> /2   -> 0.5-10
  direction?: 'up' | 'down';
  showHorizon?: boolean;
  horizonColor?: string;
  horizonOpacity?: number; // 0-100 -> /100 -> 0-1
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * RisingLines - a flat horizontal blob of light emitting two layers of rising
 * particles: thin pixel-line "trail" sparks and softer circular glowing blobs.
 *
 * Layered back-to-front each frame:
 *   1. (additive) Horizon blob - a horizontally stretched radial gradient
 *      anchored to the horizon line
 *   2. (additive) Circular glow blobs rising from the horizon
 *   3. (additive) Pixel-line trail sparks rising from the blob
 *
 * Spawn positions are seeded (Mulberry32, seed 0xC0FFEE) so the layout is
 * stable across reloads; motion is rAF-driven and time-based.
 */
export default function RisingLines({
  particles = 500,
  color = '#FFFFFF',
  riseSpeed: riseSpeedRaw = 25,
  opacity: opacityRaw = 100,
  scale: scaleRaw = 7,
  direction = 'up',
  showHorizon = true,
  horizonColor = '#C918F8',
  horizonOpacity: horizonOpacityRaw = 85,
  backgroundColor = '#000000',
  className = '',
  style = {}
}: RisingLinesProps) {
  // Whole-number panel inputs scaled back to the float ranges the render logic
  // works against, so the controls stay at integer steps.
  const riseSpeed = riseSpeedRaw / 100;
  const opacity = opacityRaw / 100;
  const horizonOpacity = horizonOpacityRaw / 100;
  const scale = scaleRaw / 2;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Effect-local, and that is the whole point. The cached size is a claim
    // about the particle buffers below, and those are rebuilt from scratch on
    // every run of this effect. Held in a ref it outlived them: a change to
    // `color` or `particles` re-ran the effect, `resize()` measured the same
    // box it had measured before, took the early return above `initParticles()`
    // — and left every buffer at length zero. Nothing but the horizon blob
    // drew again until the card happened to be resized, and `direction` stopped
    // doing anything at all because `applyTransform()` sits behind the same
    // return. A cache must not outlive the state it describes.
    let size = { w: 0, h: 0, dpr: 0 };

    const cParticle = parseColor(color);
    const cHorizon = parseColor(horizonColor);

    // World-scale multiplier - `scale` zooms element sizes. `defaultScale` is
    // 3.5 so the user-facing default reads as "1x".
    const defaultScale = 3.5;
    const worldScale = Math.max(0.1, scale) / defaultScale;

    // Seeded PRNG (Mulberry32) - a fixed seed makes the spawn pattern
    // identical across reloads.
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
    const rng = makeRng(0xc0ffee);

    // Particle SoA buffers. Each spark is a tiny vertical pixel-line trail
    // rising from the horizon blob; SoA keeps the per-frame loop cache-friendly.
    let particleCount = 0;
    let pX = new Float32Array(0);
    let pY = new Float32Array(0);
    let pVY = new Float32Array(0); // upward velocity (pixels/sec)
    let pHeight = new Float32Array(0); // spark height in pixels

    // Secondary layer: small circular glowing blobs rising alongside the line
    // sparks. Independent SoA buffers, same seeded rng().
    let blobCount = 0;
    let bX = new Float32Array(0);
    let bY = new Float32Array(0);
    let bVY = new Float32Array(0);
    let bR = new Float32Array(0); // radius in pixels

    // Center-biased x sampling: the average of 3 uniforms yields a smooth
    // dome-shaped (Irwin-Hall) distribution centred at w/2 - matching the
    // horizontal falloff of the horizon blob.
    const sampleCenterX = (w: number) => {
      const r = (rng() + rng() + rng()) / 3;
      return r * w;
    };

    // Sample a spark trail height. Most cluster around 30-50px with a minority
    // (~12%) stretching to 70-100px so the trails read as long streams of
    // light rather than stubby ticks.
    const sampleSparkHeight = () => {
      let tall: number;
      if (rng() < 0.12) {
        tall = 70 + rng() * 30; // tall outlier
      } else {
        tall = 20 + Math.pow(rng(), 0.7) * 35; // main cluster
      }
      return Math.max(1, Math.floor(tall * worldScale));
    };

    // Horizon Y position - flush to the bottom edge in the drawing space. The
    // sparks and blobs all rise from this line; `direction: "down"` mirrors the
    // whole scene through the canvas transform instead of inverting the maths.
    const getHorizonY = (h: number) => h - 1;

    // ---- Baked sprites -----------------------------------------------------
    //
    // Every blob used to build its own `createRadialGradient` + 3 colour stops,
    // and every spark its own `createLinearGradient` + 3, each stop taking a
    // freshly interpolated `rgba()` string: roughly 400 gradient objects and
    // 1200 strings per frame at the default spark count. StarBurst next door
    // already solved this by baking the profile once and applying per-particle
    // brightness through `globalAlpha`; the same trick applies here, and under
    // `lighter` scaling a premultiplied source by alpha is exactly what the
    // per-particle gradients were doing.
    //
    // Both sprites are baked close to the largest size they will ever be drawn
    // at, so the blit is a mild rescale of a smooth ramp rather than a heavy
    // downsample of a 64px one.
    const maxBlobRadius = Math.max(1, 5 * worldScale);
    const blobSpriteSize = Math.max(8, Math.min(128, Math.ceil(maxBlobRadius * 2) * 2));
    const blobSprite = document.createElement('canvas');
    blobSprite.width = blobSpriteSize;
    blobSprite.height = blobSpriteSize;
    const blobCtx = blobSprite.getContext('2d');
    if (blobCtx) {
      const mid = blobSpriteSize / 2;
      const g = blobCtx.createRadialGradient(mid, mid, 0, mid, mid, mid);
      g.addColorStop(0, `rgba(${cParticle[0]},${cParticle[1]},${cParticle[2]},1)`);
      g.addColorStop(0.4, `rgba(${cParticle[0]},${cParticle[1]},${cParticle[2]},0.45)`);
      g.addColorStop(1, `rgba(${cParticle[0]},${cParticle[1]},${cParticle[2]},0)`);
      blobCtx.fillStyle = g;
      blobCtx.fillRect(0, 0, blobSpriteSize, blobSpriteSize);
    }

    // Vertical trail profile: transparent at the top, full alpha across the
    // lower 30% nearest the horizon blob.
    const sparkSpriteHeight = Math.max(16, Math.min(256, Math.ceil(100 * worldScale)));
    const sparkSprite = document.createElement('canvas');
    sparkSprite.width = 1;
    sparkSprite.height = sparkSpriteHeight;
    const sparkCtx = sparkSprite.getContext('2d');
    if (sparkCtx) {
      const g = sparkCtx.createLinearGradient(0, 0, 0, sparkSpriteHeight);
      g.addColorStop(0, `rgba(${cParticle[0]},${cParticle[1]},${cParticle[2]},0)`);
      g.addColorStop(0.7, `rgba(${cParticle[0]},${cParticle[1]},${cParticle[2]},1)`);
      g.addColorStop(1, `rgba(${cParticle[0]},${cParticle[1]},${cParticle[2]},1)`);
      sparkCtx.fillStyle = g;
      sparkCtx.fillRect(0, 0, 1, sparkSpriteHeight);
    }

    // The horizon blob's gradient is anchored at the local origin and its
    // radius never changes, so the one object serves every frame - the draw
    // transform is what moves it. Identical output, one allocation instead of
    // one per frame.
    const horizonRadius = 40 * worldScale;
    const horizonAlpha = Math.max(0, Math.min(1, horizonOpacity));
    const horizonGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, horizonRadius);
    horizonGradient.addColorStop(0, `rgba(${cHorizon[0]},${cHorizon[1]},${cHorizon[2]},${horizonAlpha})`);
    horizonGradient.addColorStop(0.35, `rgba(${cHorizon[0]},${cHorizon[1]},${cHorizon[2]},${horizonAlpha * 0.65})`);
    horizonGradient.addColorStop(0.7, `rgba(${cHorizon[0]},${cHorizon[1]},${cHorizon[2]},${horizonAlpha * 0.2})`);
    horizonGradient.addColorStop(1, `rgba(${cHorizon[0]},${cHorizon[1]},${cHorizon[2]},0)`);

    const initParticles = () => {
      const { w, h } = size;
      // `particles` is the spark count at the reference 800x400 frame, scaled
      // by the actual area so density stays consistent at any size.
      const area = w * h;
      const refArea = 800 * 400;
      const target = Math.max(0, Math.floor((particles * area) / refArea));
      particleCount = Math.min(target, 4000);
      pX = new Float32Array(particleCount);
      pY = new Float32Array(particleCount);
      pVY = new Float32Array(particleCount);
      pHeight = new Float32Array(particleCount);

      const horizonY = getHorizonY(h);
      for (let i = 0; i < particleCount; i++) {
        pX[i] = sampleCenterX(w);
        // Distribute the initial Y across the area above the horizon.
        pY[i] = horizonY - rng() * horizonY * 0.95;
        // Velocity is scale-independent - `scale` must not change speed.
        pVY[i] = 10 + rng() * 40;
        pHeight[i] = sampleSparkHeight();
      }

      // Secondary blob layer - ~30% of the spark count, scaled the same way.
      const blobTarget = Math.max(0, Math.floor(target * 0.3));
      blobCount = Math.min(blobTarget, 1200);
      bX = new Float32Array(blobCount);
      bY = new Float32Array(blobCount);
      bVY = new Float32Array(blobCount);
      bR = new Float32Array(blobCount);

      for (let i = 0; i < blobCount; i++) {
        bX[i] = sampleCenterX(w);
        bY[i] = horizonY - rng() * horizonY * 0.95;
        // Slightly slower than the line sparks so the layers separate.
        bVY[i] = 8 + rng() * 28;
        // Power-distributed radius: mostly small with a few larger.
        bR[i] = (1.5 + Math.pow(rng(), 1.8) * 3.5) * worldScale;
      }
    };

    /**
     * Base transform. "down" mirrors the Y axis, so the same rising-from-the-
     * bottom simulation reads as sparks falling from the top.
     */
    const applyTransform = () => {
      const { h, dpr } = size;
      if (direction === 'down') {
        ctx.setTransform(dpr, 0, 0, -dpr, 0, h * dpr);
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    // One measurement rule for both callers. The first call used to read
    // `container.clientWidth`, which is rounded, while the observer read
    // `Math.floor(contentRect.width)`: on a container 400.6px wide the two
    // disagreed by a pixel, so the guard below flapped between 401 and 400 and
    // the size cache never settled. The bounding rect is fractional in both
    // paths and it is the same read the old code was already doing.
    const measure = () => {
      const rect = container.getBoundingClientRect();
      return {
        w: Math.max(1, Math.floor(rect.width || container.clientWidth)),
        h: Math.max(1, Math.floor(rect.height || container.clientHeight))
      };
    };

    const resize = () => {
      // A card can be measured at 0x0 - a hidden tab, a collapsed panel, a
      // mount before layout. `measure()` floors that to 1x1, which yields zero
      // particles and paints nothing; the observer's first real measurement
      // then differs and seeds the scene properly.
      const { w, h } = measure();
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      const dpr = resolveBufferRatio(w, h, Math.min(window.devicePixelRatio || 1, 2));
      if (size.w === w && size.h === h && size.dpr === dpr) return;
      size = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      applyTransform();

      initParticles();
    };

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(container);

    const drawFrame = (deltaSec: number) => {
      const { w, h } = size;
      const dt = Math.max(0.001, Math.min(0.05, deltaSec));

      const horizonY = getHorizonY(h);

      // (1) Clear. The canvas itself stays transparent so the card behind
      // shows through; the backgroundColor prop paints the base instead.
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);

      // Switch to additive for all glow layers.
      ctx.globalCompositeOperation = 'lighter';

      // (2) Horizon blob - a single horizontally stretched radial gradient.
      if (showHorizon && horizonAlpha > 0.001) {
        const rx = w * 0.5;
        const ry = horizonRadius;
        ctx.save();
        ctx.translate(w / 2, horizonY);
        ctx.scale(rx / ry, 1);
        ctx.fillStyle = horizonGradient;
        ctx.fillRect(-ry - 2, -ry - 2, (ry + 2) * 2, (ry + 2) * 2);
        ctx.restore();
      }

      const riseSpeedMul = Math.max(0, riseSpeed) * 10; // 0-0.6 -> 0-6x
      // Respawn is driven purely by POSITION (a particle reaching the top),
      // never by elapsed time, so every particle always travels the full
      // horizon->top distance regardless of speed or scale. Alpha fades by
      // travel progress, not by a lifetime clock.
      const denom = Math.max(1, horizonY);

      // (3) Circular glow blobs - update + draw. `fillStyle` is the crisp core
      // for the larger blobs only; the halo comes from the baked sprite, which
      // ignores it. Both are modulated by `globalAlpha`.
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < blobCount; i++) {
        const effVy = bVY[i] * (1.0 + riseSpeedMul);
        bY[i] -= effVy * dt;
        // Respawn only once fully off the top - guarantees full travel.
        if (bY[i] < -bR[i] * 2) {
          bX[i] = sampleCenterX(w);
          bY[i] = horizonY - rng() * 10;
          bVY[i] = 8 + rng() * 28;
          bR[i] = (1.5 + Math.pow(rng(), 1.8) * 3.5) * worldScale;
        }
        // Travel progress 0 (horizon) -> 1 (top); fade in then out.
        const t = Math.max(0, Math.min(1, (horizonY - bY[i]) / denom));
        const fade = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
        const a = fade * opacity;
        if (a < 0.01) continue;

        const cx = bX[i];
        const cy = bY[i];
        const r = bR[i];
        // Tight radial halo - the 0.4 mid-stop baked into the sprite pulls the
        // falloff in so this does not turn into a heavy bloom.
        const aClamped = Math.min(1, a);
        ctx.globalAlpha = aClamped;
        ctx.drawImage(blobSprite, cx - r, cy - r, r * 2, r * 2);
        // Crisp 1px white core for the larger blobs only.
        if (r > 2.5) {
          ctx.fillRect(Math.floor(cx), Math.floor(cy), 1, 1);
        }
      }
      ctx.globalAlpha = 1;

      // (4) Pixel-line trail sparks - update + draw.
      for (let i = 0; i < particleCount; i++) {
        const effVy = pVY[i] * (1.0 + riseSpeedMul);
        pY[i] -= effVy * dt;
        // Respawn only once fully off the top - guarantees full travel.
        if (pY[i] < -pHeight[i]) {
          pX[i] = sampleCenterX(w);
          pY[i] = horizonY - rng() * 10;
          pVY[i] = 10 + rng() * 40;
          pHeight[i] = sampleSparkHeight();
        }
        // Travel progress 0 (horizon) -> 1 (top); triangular fade.
        const t = Math.max(0, Math.min(1, (horizonY - pY[i]) / denom));
        const fade = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
        const a = fade * opacity;
        if (a < 0.01) continue;

        const px = Math.floor(pX[i]);
        const py = Math.floor(pY[i]);
        const lineHeight = pHeight[i];
        // Vertical alpha gradient - top transparent, the lower ~30% at full
        // alpha near the blob, fading out over the upper 70%. Baked once into
        // `sparkSprite`; brightness rides on globalAlpha.
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sparkSprite, px, py, 1, lineHeight);
      }
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
      // Drop the sprites' backing stores rather than waiting for GC.
      blobSprite.width = 0;
      blobSprite.height = 0;
      sparkSprite.width = 0;
      sparkSprite.height = 0;
    };
  }, [particles, color, showHorizon, horizonColor, riseSpeed, opacity, horizonOpacity, scale, direction]);

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

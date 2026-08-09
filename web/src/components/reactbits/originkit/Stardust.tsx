import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Stardust — a drifting field of flickering sparkle particles.
 *
 * Ported from the Originkit `stardust` capture (exported there as `Sparkles`).
 * Canvas 2D, self-animating: the source starts a `requestAnimationFrame` loop
 * unconditionally and reads no pointer, so no autopilot is required.
 */
export interface StardustProps {
  /** Backdrop painted behind the particles. Pass an rgba() with alpha 0 to keep the card transparent. */
  background?: string;
  /** Colour of the particles. */
  particleColor?: string;
  /** 1..10, mapped internally to 5..60 particles per 10k px². */
  particleDensity?: number;
  /** Smallest particle radius in px. */
  minSize?: number;
  /** Largest particle radius in px. */
  maxSize?: number;
  /** 1..10 flicker rate, mapped internally to 0.5..12. */
  speed?: number;
  /** 0..10 per-particle random drift speed. */
  particleSpeed?: number;
  /** 0..10 strength of the shared directional drift. */
  movement?: number;
  /** Drift direction in degrees clockwise from up. */
  angle?: number;
  className?: string;
  style?: CSSProperties;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  opacityVel: number;
}

function parseColorToRgba(input: string): Rgba {
  if (!input) return { r: 0, g: 0, b: 0, a: 1 };
  const str = input.trim();
  const rgbaMatch = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (rgbaMatch) {
    const r = Math.max(0, Math.min(255, parseFloat(rgbaMatch[1]))) / 255;
    const g = Math.max(0, Math.min(255, parseFloat(rgbaMatch[2]))) / 255;
    const b = Math.max(0, Math.min(255, parseFloat(rgbaMatch[3]))) / 255;
    const a = rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4]))) : 1;
    return { r, g, b, a };
  }
  const hex = str.replace(/^#/, "");
  if (hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: parseInt(hex.slice(6, 8), 16) / 255,
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: 1,
    };
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
      a: parseInt(hex[3] + hex[3], 16) / 255,
    };
  }
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
      a: 1,
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function rgbaToCanvasColor(rgba: Rgba): string {
  const r = Math.round(rgba.r * 255);
  const g = Math.round(rgba.g * 255);
  const b = Math.round(rgba.b * 255);
  if (rgba.a === 1) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${rgba.a})`;
}

/** UI 1..10 → internal 0.5..12 (flicker rate). */
function mapFlickerUiToInternal(ui: number): number {
  const clamped = Math.max(1, Math.min(10, ui));
  return 0.5 + ((clamped - 1) / 9) * 11.5;
}

/** UI 1..10 → internal 5..60 (density). */
function mapDensityUiToInternal(ui: number): number {
  const clamped = Math.max(1, Math.min(10, ui));
  return 5 + ((clamped - 1) / 9) * 55;
}

/** Angle (deg) → unit drift vector. 0° up, 90° right, 180° down, 270° left. */
function angleToDrift(angleDeg: number): { vx: number; vy: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { vx: Math.cos(rad), vy: Math.sin(rad) };
}

export default function Stardust({
  background = "#000000",
  particleColor = "#FFFFFF",
  particleDensity = 4,
  minSize = 1.5,
  maxSize = 1,
  speed = 10,
  particleSpeed = 1,
  movement = 6,
  angle = 180,
  className = "",
  style,
}: StardustProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const cv: HTMLCanvasElement = canvas;
    const box: HTMLDivElement = container;
    const g: CanvasRenderingContext2D = context;

    let raf = 0;
    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const mappedSpeed = mapFlickerUiToInternal(speed);
    const density = mapDensityUiToInternal(particleDensity);
    const velocityMultiplier = (particleSpeed / 10) * 0.5;
    const driftMag = movement * 0.1;
    const drift = angleToDrift(angle);
    const driftVx = drift.vx * driftMag;
    const driftVy = drift.vy * driftMag;

    const backgroundRgba = parseColorToRgba(background);
    const backgroundColor = rgbaToCanvasColor(backgroundRgba);
    const particleRgba = parseColorToRgba(particleColor);
    const particleBase = rgbaToCanvasColor({ ...particleRgba, a: 1 });

    function spawn(w: number, h: number): Particle {
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * velocityMultiplier,
        vy: (Math.random() - 0.5) * velocityMultiplier,
        size: minSize + Math.random() * (maxSize - minSize),
        opacity: Math.random(),
        opacityVel: (Math.random() - 0.5) * 0.04,
      };
    }

    function measure(entry?: ResizeObserverEntry) {
      const rect = entry?.contentRect ?? box.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width) || 1);
      const h = Math.max(1, Math.floor(rect.height) || 1);
      const prevW = width;
      const prevH = height;
      width = w;
      height = h;
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Density is per unit area, so a resize changes the target count. Carry
      // the field across the change — scale what is there, then top up or trim —
      // rather than re-seeding, which reads as the sky blinking.
      const target = Math.max(0, Math.floor(((w * h) / 1e4) * density));
      const sx = prevW > 0 ? w / prevW : 1;
      const sy = prevH > 0 ? h / prevH : 1;
      for (let i = 0; i < particles.length; i++) {
        particles[i].x *= sx;
        particles[i].y *= sy;
      }
      if (particles.length > target) particles.length = target;
      else while (particles.length < target) particles.push(spawn(w, h));
    }

    function draw() {
      g.clearRect(0, 0, width, height);
      g.fillStyle = backgroundColor;
      g.fillRect(0, 0, width, height);
      g.fillStyle = particleBase;
      for (const p of particles) {
        g.globalAlpha = particleRgba.a * p.opacity;
        g.beginPath();
        g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    function loop() {
      for (const p of particles) {
        p.x += p.vx + driftVx;
        p.y += p.vy + driftVy;
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;
        p.opacity += p.opacityVel * mappedSpeed * 0.5;
        if (p.opacity <= 0.1 || p.opacity >= 1) p.opacityVel *= -1;
        p.opacity = Math.max(0.1, Math.min(1, p.opacity));
      }
      draw();
      raf = requestAnimationFrame(loop);
    }

    measure();
    draw();
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver((entries) => {
      measure(entries[0]);
      draw();
    });
    ro.observe(box);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [background, particleColor, particleDensity, minSize, maxSize, speed, particleSpeed, movement, angle]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
      style={style}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

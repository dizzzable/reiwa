import { useEffect, useRef, type CSSProperties } from "react";

/**
 * CharacterWaves — a field of ASCII glyphs displaced by layered pseudo-noise.
 *
 * Ported from the Originkit `character-waves` capture (exported there as
 * `ASCIIWaves`, untyped JS). Canvas 2D.
 *
 * The wave motion is time-driven and runs with no pointer at all, so the card
 * is never still. The cursor *ripple* — three of the twelve documented props —
 * is the part that would be dead on a touch device, so `autoplay` walks a
 * synthetic cursor across the box to keep it alive. A real pointer takes over
 * within a few frames and the autopilot fades back in about a second and a half
 * after it leaves.
 */
export interface CharacterWavesProps {
  /** Glyph ramp, lightest to densest. */
  characters?: string;
  /** Size of each character cell in px. */
  elementSize?: number;
  /** Colour of the characters. */
  color?: string;
  /** Direction the waves travel. */
  direction?: "left" | "right" | "top" | "bottom";
  /** Backdrop painted behind the field each frame. */
  background?: string;
  /** Reverse the ramp. */
  invert?: boolean;
  /** Monospace weight of the characters. */
  fontWeight?: "300" | "400" | "500" | "600" | "700" | "800";
  /** Wave speed, 0..100 (internal 0..5). */
  speed?: number;
  /** Churn rate of the noise, 1..20 (internal 0.1..2). */
  waveTension?: number;
  /** Spatial frequency of the noise, 1..50 (internal 0.01..0.5). */
  noiseScale?: number;
  /** Ramp contrast, 1..30 (internal 0.1..3). */
  intensity?: number;
  /** Enable the cursor ripple at all. */
  hasCursorInteraction?: boolean;
  /** Ripple strength, 0..50 (internal 0..5). */
  interactionIntensity?: number;
  /** Ripple radius in px. */
  interactionRadius?: number;
  /**
   * Drive the ripple from a synthetic cursor when no real one is present.
   * Turn off to leave the ripple dormant until someone actually hovers.
   */
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_CHARACTERS = " .:-+*=%@#";

/**
 * Milliseconds of silence after which a pointer counts as gone even though no
 * `pointerleave` ever arrived. It does not always arrive — the webview takes
 * over a swipe, a sheet is dismissed mid-touch — and the latch survives an
 * effect re-run because the flag lives in a ref: turning `hasCursorInteraction`
 * off unbinds the only listener that could ever have cleared it, so the ripple
 * stays pinned to the last touched point for the life of the mount.
 */
const POINTER_IDLE_MS = 3000;

const DRIFT: Record<NonNullable<CharacterWavesProps["direction"]>, readonly [number, number]> = {
  left: [1, 0],
  right: [-1, 0],
  top: [0, 1],
  bottom: [0, -1],
};

function noise(x: number, y: number, t: number): number {
  const a = Math.sin(x * 1.3 + t) * Math.cos(y * 1.1 - t * 0.7);
  const b = Math.sin((x + y) * 0.7 + t * 0.5);
  const c = Math.sin(x * 0.4 - y * 0.6 + t * 0.3);
  return (a + b + c) / 3;
}

export default function CharacterWaves({
  characters = DEFAULT_CHARACTERS,
  elementSize = 16,
  color = "#ffffff",
  direction = "left",
  background = "#000000",
  invert = false,
  fontWeight = "400",
  speed = 20,
  waveTension = 5,
  noiseScale = 12,
  intensity = 10,
  hasCursorInteraction = true,
  interactionIntensity = 15,
  interactionRadius = 160,
  autoplay = true,
  className = "",
  style,
}: CharacterWavesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: -9999, y: -9999, active: false, at: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const box: HTMLDivElement = container;
    const cv: HTMLCanvasElement = canvas;
    const ctx: CanvasRenderingContext2D = context;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Rescaled props divided back to their original fractional ranges.
    const speedVal = speed / 20;
    const tensionVal = waveTension / 10;
    const twistVal = 0.1; // fixed; the former Twist control's default 10 → 0.1
    const scaleVal = noiseScale / 100;
    const intensityVal = intensity / 10;
    const cursorForceVal = interactionIntensity / 10;
    const [driftX, driftY] = DRIFT[direction] ?? DRIFT.left;
    // Translation per second. Dominates the slow in-place morph so the pattern
    // visibly travels in the chosen direction.
    const driftRate = 1.5;

    // `length > 0` was not enough: a ramp of a single space passes it, gives
    // `rampMax = 0`, and then every cell resolves to that one space — which the
    // `ch !== " "` test below skips, so the field draws nothing at all. Test for
    // content, not length. The default's own leading space survives this, since
    // only the emptiness test is trimmed, never the ramp itself.
    const source = characters && characters.trim().length > 0 ? characters : DEFAULT_CHARACTERS;
    const ramp = invert ? [...source].reverse() : [...source];
    const rampMax = ramp.length - 1;

    const cell = Math.max(4, elementSize);
    const colStep = cell * 0.6;

    let raf = 0;
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let last = 0;
    // 0 = synthetic cursor, 1 = the real one.
    let blend = 0;
    const start = performance.now();

    function layout(entry?: ResizeObserverEntry) {
      const rect = entry?.contentRect ?? box.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width) || 1);
      height = Math.max(1, Math.floor(rect.height) || 1);
      cv.width = Math.floor(width * dpr);
      cv.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / colStep) + 1;
      rows = Math.ceil(height / cell) + 1;
      // The transform reset above clears the context state, so restate the font.
      ctx.font = `${fontWeight} ${cell}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
    }

    function draw(now: number, dt: number) {
      const t = ((now - start) / 1000) * speedVal;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = color;

      const pointer = pointerRef.current;
      // A pointer that stopped reporting without ever leaving is treated as
      // gone, so the autopilot always comes back.
      if (pointer.active && now - pointer.at > POINTER_IDLE_MS) pointer.active = false;
      // Ease towards the real cursor quickly and back to the synthetic one over
      // roughly a second and a half, so the two never fight for the ripple.
      const target = pointer.active ? 1 : 0;
      blend += (target - blend) * Math.min(1, dt * (pointer.active ? 6 : 0.7));

      // Two sine terms of incommensurable periods per axis: a smooth path that
      // covers the box without ever quite repeating.
      const seconds = (now - start) / 1000;
      const autoX = (0.5 + 0.34 * Math.sin(seconds * 0.21) + 0.11 * Math.sin(seconds * 0.093)) * width;
      const autoY = (0.5 + 0.3 * Math.cos(seconds * 0.157) + 0.12 * Math.sin(seconds * 0.061)) * height;
      const rippleOn = hasCursorInteraction && (pointer.active || (autoplay && blend < 1));
      const cursorX = autoplay ? autoX + (pointer.x - autoX) * blend : pointer.x;
      const cursorY = autoplay ? autoY + (pointer.y - autoY) * blend : pointer.y;

      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const px = i * colStep;
          const py = j * cell;
          const ox = t * driftRate * driftX;
          const oy = t * driftRate * driftY;
          const nx = i * scaleVal + ox + Math.sin((j + t) * twistVal) * 2;
          const ny = j * scaleVal + oy + Math.cos((i + t) * twistVal) * 2;
          let v = noise(nx, ny, t * tensionVal);

          if (rippleOn) {
            const dx = px - cursorX;
            const dy = py - cursorY;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < interactionRadius) {
              const falloff = 1 - d / interactionRadius;
              v += Math.sin(d * 0.08 - t * 4) * falloff * cursorForceVal;
            }
          }

          const norm = Math.max(0, Math.min(1, (v * intensityVal + 1) / 2));
          const ch = ramp[Math.round(norm * rampMax)];
          if (ch !== " ") ctx.fillText(ch, px, py);
        }
      }
    }

    function loop(now: number) {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
      last = now;
      draw(now, dt);
      raf = requestAnimationFrame(loop);
    }

    function onPointerMove(e: PointerEvent) {
      const rect = box.getBoundingClientRect();
      pointerRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        active: true,
        at: performance.now(),
      };
    }
    function onPointerLeave() {
      pointerRef.current.active = false;
    }

    layout();
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver((entries) => layout(entries[0]));
    ro.observe(box);

    if (hasCursorInteraction) {
      box.addEventListener("pointermove", onPointerMove);
      box.addEventListener("pointerleave", onPointerLeave);
      box.addEventListener("pointercancel", onPointerLeave);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      box.removeEventListener("pointermove", onPointerMove);
      box.removeEventListener("pointerleave", onPointerLeave);
      box.removeEventListener("pointercancel", onPointerLeave);
    };
  }, [
    characters,
    invert,
    elementSize,
    color,
    direction,
    background,
    waveTension,
    speed,
    noiseScale,
    intensity,
    hasCursorInteraction,
    interactionIntensity,
    interactionRadius,
    fontWeight,
    autoplay,
  ]);

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

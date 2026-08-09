import { useEffect, useRef, type CSSProperties } from "react";

/**
 * AsciiRain — Matrix-style falling glyph columns.
 *
 * Ported from the Originkit `ascii-rain` capture (exported there as
 * `DigitalRain`). Canvas 2D, self-animating: the source starts a
 * `requestAnimationFrame` loop unconditionally and reads no pointer, so no
 * autopilot is required.
 */
export interface AsciiRainProps {
  /** Colour of the bright leading glyph. */
  headColor?: string;
  /** Colour of the dimming glyphs behind the head. */
  trailColor?: string;
  /** Font size of each glyph in px. */
  glyphSize?: number;
  /** Fall speed; pixels per second is `speed * glyphSize`. */
  speed?: number;
  /** Tilt of the streams in degrees. */
  angle?: number;
  /** Column packing; 50 puts columns one glyph apart, 1 spreads them out. */
  density?: number;
  /** Number of glyphs carried behind each head. */
  trail?: number;
  /** Character set used when `shuffle` is off. */
  glyphs?: string;
  /** Whether glyphs churn over time or stay frozen at spawn. */
  shuffle?: boolean;
  /** Character set used when `shuffle` is on. */
  shuffleGlyphs?: string;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_GLYPHS = "ｱｲｳｴｵｶｷｸ0123456789ABCDEFｸｿﾝ";

/** A stream either runs the full height or dies somewhere past this much of it. */
const MIN_BURNOUT = 0.75;
/** Share of streams that make it all the way across without fading. */
const CROSSING_SHARE = 0.35;
/** A column releases its next stream once the current one is this far down. */
const MIN_RELEASE = 0.3;
const MAX_RELEASE = 0.8;

interface Stream {
  /** Head position down the column, in px. Negative means still above the top. */
  y: number;
  /** Pixels per second this stream falls. */
  rate: number;
  /** Height fraction at which it starts dying; Infinity means it crosses. */
  burnout: number;
  /** Current opacity, driven down once past burnout. */
  alpha: number;
  /** The glyphs it is carrying, head first. */
  chars: string[];
}

interface Column {
  /** Streams currently in flight here, oldest first. */
  streams: Stream[];
  /** How far the newest stream must fall before the next one is released. */
  releaseAt: number;
}

export default function AsciiRain({
  headColor = "#FFFFFF",
  trailColor = "#F7FF00",
  glyphSize = 20,
  speed = 6,
  angle = 0,
  density = 50,
  trail = 23,
  glyphs = DEFAULT_GLYPHS,
  shuffle = true,
  shuffleGlyphs = DEFAULT_GLYPHS,
  className = "",
  style,
}: AsciiRainProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const box: HTMLDivElement = container;
    const cv: HTMLCanvasElement = canvas;
    const ctx: CanvasRenderingContext2D = context;

    // Shuffle on: draw from the shuffle set and churn between them over time.
    // Shuffle off: fill from the plain set once and hold it.
    const source = shuffle ? shuffleGlyphs || DEFAULT_GLYPHS : glyphs || DEFAULT_GLYPHS;
    const chars = [...source];
    const pick = () => chars[Math.floor(Math.random() * chars.length)];
    const rad = (angle * Math.PI) / 180;
    const rate = speed * glyphSize;
    // Density 50 packs the columns one glyph apart; 1 spreads them right out.
    // Clamped at 1px so an out-of-range density cannot collapse the layout.
    const gap = Math.max(1, glyphSize * (1 + (50 - density) / 12));
    const tailLength = Math.max(1, Math.round(trail));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let raf = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    let span = 0;
    let cols = 0;
    let columns: Column[] = [];

    function spawn(y: number): Stream {
      return {
        y,
        // A little rate scatter so the field never falls in lockstep.
        rate: rate * (0.75 + Math.random() * 0.5),
        burnout:
          Math.random() < CROSSING_SHARE ? Infinity : MIN_BURNOUT + Math.random() * (1 - MIN_BURNOUT),
        alpha: 1,
        chars: Array.from({ length: tailLength }, pick),
      };
    }

    function nextRelease(): number {
      return span * (MIN_RELEASE + Math.random() * (MAX_RELEASE - MIN_RELEASE));
    }

    function layout(entry?: ResizeObserverEntry) {
      const rect = entry?.contentRect ?? box.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width) || 1);
      height = Math.max(1, Math.floor(rect.height) || 1);
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Tilting the field means drawing past the corners, so lay the columns
      // out across the diagonal. Anything less and the angle bares the edges.
      span = Math.hypot(width, height);
      const next = Math.max(1, Math.ceil(span / gap));
      // Keep the columns already in flight across a resize and only build the
      // ones that are new — re-seeding the whole field restarts the rain every
      // time the card changes size.
      const previous = columns;
      cols = next;
      columns = new Array(cols);
      for (let i = 0; i < cols; i++) {
        // Seed each new column mid-flight so the frame is already raining on
        // the very first paint instead of waiting for streams to arrive.
        columns[i] = previous[i] ?? {
          streams: [spawn(Math.random() * span)],
          releaseAt: nextRelease(),
        };
      }
    }

    function draw(dt: number) {
      // Wipe outright. Fading the previous frame is what smears the glyphs into
      // an illegible trail; every frame is painted from scratch.
      ctx.clearRect(0, 0, width, height);

      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(rad);
      ctx.font = `${glyphSize}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const lead = tailLength * glyphSize;

      for (let i = 0; i < cols; i++) {
        const column = columns[i];
        const x = -span / 2 + i * gap + gap / 2;

        for (const stream of column.streams) {
          stream.y += stream.rate * dt;

          const travelled = stream.y / span;
          if (stream.burnout !== Infinity && travelled > stream.burnout) {
            stream.alpha -= dt * 1.5;
          }

          // Churn one glyph per frame so the stream flickers without the whole
          // line rewriting itself and turning to mush. Only when shuffle is on.
          if (shuffle && Math.random() < 0.25) {
            stream.chars[Math.floor(Math.random() * stream.chars.length)] = pick();
          }

          const headY = -span / 2 + stream.y;
          const columnAlpha = Math.max(0, Math.min(1, stream.alpha));

          for (let j = 0; j < tailLength; j++) {
            const y = headY - j * glyphSize;
            if (y < -span / 2 - glyphSize || y > span / 2 + glyphSize) continue;
            // Head is bright; the tail ramps down behind it.
            const taper = j === 0 ? 1 : 1 - j / tailLength;
            ctx.globalAlpha = columnAlpha * taper;
            ctx.fillStyle = j === 0 ? headColor : trailColor;
            ctx.fillText(stream.chars[j], x, y);
          }
        }

        // Retire whatever has dimmed out or dropped clean off the bottom.
        column.streams = column.streams.filter((stream) => stream.alpha > 0 && stream.y - lead <= span);

        // Release the next stream once the newest one is far enough down, so
        // the rain keeps coming without gaps.
        const newest = column.streams[column.streams.length - 1];
        if (!newest || newest.y >= column.releaseAt) {
          column.streams.push(spawn(-lead));
          column.releaseAt = nextRelease();
        }
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function loop(time: number) {
      const dt = last ? Math.min((time - last) / 1000, 0.05) : 1 / 60;
      last = time;
      draw(dt);
      raf = requestAnimationFrame(loop);
    }

    layout();
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver((entries) => layout(entries[0]));
    ro.observe(box);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [headColor, trailColor, glyphSize, speed, angle, density, trail, glyphs, shuffle, shuffleGlyphs]);

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

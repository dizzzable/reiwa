import { useEffect, useRef, type CSSProperties } from "react";

/**
 * AsciiFlame — a heat-buffer fire simulation rendered as coloured ASCII text.
 *
 * Ported from the Originkit `ascii-flame` capture (exported there as
 * `AsciiFire`). Despite the capture's "Canvas 2D" label the effect draws into a
 * `<pre>`; the only `getContext("2d")` in the source is an offscreen canvas
 * used to measure glyph width. It still classifies as `canvas2d` — no GPU
 * context is ever created — but the painted element is a `<pre>`, not a
 * `<canvas>`. The capture rewrote that `<pre>` through `innerHTML` every frame;
 * this port keeps a reused pool of `<span>`s instead. See `renderFire`.
 *
 * Self-animating: the `requestAnimationFrame` loop runs unconditionally once the
 * reduced-motion branch is removed, and no pointer is read, so no autopilot is
 * required.
 */
export interface AsciiFlameProps {
  /** Overall fuel/heat level, 0..100. */
  intensity?: number;
  /** Direction the flame leans. */
  windDirection?: "left" | "right";
  /** Sideways push, clamped internally to 10..100. */
  windForce?: number;
  /** How quickly heat cools as it rises; higher is a shorter flame. */
  decay?: number;
  /** Random drift in the propagation step, 0..100. */
  turbulence?: number;
  /** Number of fuel rows seeded at the base. */
  thickness?: number;
  /** Slow drifting ember particles. */
  embers?: boolean;
  /** Fast upward spark particles. */
  sparks?: boolean;
  /** Slow breathing pulse in overall intensity. */
  pulse?: boolean;
  /** Which colour ramp to use. */
  palette?: "mono" | "color" | "custom";
  /** Custom ramp, coolest first, used when `palette` is `"custom"`. */
  shades?: string[];
  /** Colour of spark glyphs when the custom palette is active. */
  sparkColor?: string;
  /** Character ramp used to render flame density. */
  charset?: "classic" | "dense" | "blocks" | "minimal";
  /** Backdrop behind the glyphs. */
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

type PaletteMode = NonNullable<AsciiFlameProps["palette"]>;
type WindDirection = NonNullable<AsciiFlameProps["windDirection"]>;
type FireCharset = NonNullable<AsciiFlameProps["charset"]>;

interface FireParticle {
  kind: "ember" | "spark";
  glyph: string;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  heat: number;
  life: number;
  maxLife: number;
}

interface FireConfig {
  intensity: number;
  wind: number;
  decay: number;
  turbulence: number;
  thickness: number;
  embers: boolean;
  sparks: boolean;
  pulse: boolean;
}

const FONT_SIZE = 10;
const FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const FPS = 30;

const CHARSETS: Record<FireCharset, string> = {
  classic: " .:-=+*#%@",
  dense: " `.^,:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks: " ░▒▓█",
  minimal: " .:*#",
};

const DEFAULT_CHARSET_KEY: FireCharset = "classic";

const COLOR_PALETTE = ["#411205", "#7c2105", "#b93608", "#e85b0c", "#ff8b18", "#ffc247", "#fff1aa"] as const;
const MONO_PALETTE = ["#181818", "#303030", "#505050", "#787878", "#a8a8a8", "#d8d8d8", "#ffffff"] as const;

/**
 * Every colour that reaches the frame has to be a colour and nothing else.
 * Anything that does not match falls back.
 *
 * The frame used to be assembled as an HTML string and handed to `innerHTML`,
 * where an operator-supplied shade could have closed the style attribute and
 * injected markup. It is now written through `style.color` on reused elements,
 * so that route is gone — but the guard stays: it is what keeps a malformed
 * shade from silently dropping a colour instead of falling back to the ramp.
 */
const CSS_COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%/]+\)|hsla?\([\d.,\s%/adeg]+\)|var\(--[a-z0-9_-]+\)|[a-z]+)$/i;

function sanitizeCssColor(input: string | undefined, fallback: string): string {
  const value = typeof input === "string" ? input.trim() : "";
  return CSS_COLOR_PATTERN.test(value) ? value : fallback;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

const resolveWind = (direction: WindDirection, force: number): number => {
  const amount = clamp(force, 10, 100);
  return direction === "left" ? -amount : amount;
};

const resolveCharacters = (charsetName: FireCharset): string =>
  CHARSETS[charsetName] || CHARSETS[DEFAULT_CHARSET_KEY];

const resolvePalette = (palette: PaletteMode, shades: readonly string[] | undefined): readonly string[] => {
  if (palette === "color") return COLOR_PALETTE;
  if (palette === "custom") return shades && shades.length > 0 ? shades : COLOR_PALETTE;
  return MONO_PALETTE;
};

const seedFuel = (
  heat: Float32Array,
  columns: number,
  rows: number,
  config: FireConfig,
  elapsedSeconds: number,
): void => {
  const pulseMultiplier = config.pulse ? 0.88 + Math.sin(elapsedSeconds * 2.2) * 0.12 : 1;
  const fuelRows = clamp(Math.round(config.thickness), 1, Math.max(1, rows - 1));
  const baseHeat = clamp(config.intensity / 100, 0.05, 1) * pulseMultiplier;

  for (let rowOffset = 0; rowOffset < fuelRows; rowOffset += 1) {
    const row = rows - 1 - rowOffset;
    const rowStrength = 1 - rowOffset / Math.max(fuelRows * 2, 1);

    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const flicker = 0.58 + Math.random() * 0.42;
      heat[index] = clamp(baseHeat * rowStrength * flicker, 0, 1);
    }
  }
};

const propagateFire = (
  heat: Float32Array,
  nextHeat: Float32Array,
  columns: number,
  rows: number,
  config: FireConfig,
): void => {
  nextHeat.fill(0);
  const windOffset = config.wind / 50;
  const turbulence = config.turbulence / 100;
  const cooling = config.decay / 1000;

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const randomDrift = (Math.random() - 0.5) * (1.5 + turbulence * 5);
      const sourceColumn = clamp(Math.round(column - windOffset + randomDrift), 0, columns - 1);
      const rowBelow = (row + 1) * columns;
      const rowTwoBelow = Math.min(row + 2, rows - 1) * columns;
      const sideDirection = Math.random() < 0.5 ? -1 : 1;
      const side = rowBelow + clamp(sourceColumn + sideDirection, 0, columns - 1);
      const center = rowBelow + sourceColumn;
      const deep = rowTwoBelow + sourceColumn;
      let carriedHeat = heat[center] * 0.58 + heat[side] * 0.16 + heat[deep] * 0.26;
      const randomCooling = cooling * (0.2 + Math.random() * (1.3 + turbulence * 2));

      if (Math.random() < turbulence * 0.08) {
        carriedHeat *= 0.45 + Math.random() * 0.35;
      }

      nextHeat[row * columns + column] = clamp(carriedHeat - randomCooling, 0, 1);
    }
  }

  const fuelStart = Math.max(0, rows - Math.round(config.thickness));
  nextHeat.set(heat.subarray(fuelStart * columns), fuelStart * columns);
};

/**
 * Advances every particle in place and compacts the survivors to the front of
 * the same array. The previous version rebuilt the list with `.map().filter()`
 * and then `.slice()`, which allocated one fresh object per particle per frame
 * plus three arrays — at 30 fps that is the bulk of this component's garbage.
 *
 * The arithmetic is unchanged, including the order it reads fields in: `x`
 * advances by the *old* `velocityX` before `velocityX` itself is perturbed.
 */
const updateParticles = (particles: FireParticle[], columns: number, rows: number, config: FireConfig): void => {
  let write = 0;
  for (let read = 0; read < particles.length; read += 1) {
    const particle = particles[read];
    particle.x += particle.velocityX + config.wind / 500;
    particle.y += particle.velocityY;
    particle.velocityX += (Math.random() - 0.5) * (config.turbulence / 300);
    particle.heat *= particle.kind === "spark" ? 0.985 : 0.94;
    particle.life -= 1;
    if (particle.life > 0 && particle.y >= 0 && particle.x >= 0 && particle.x < columns) {
      particles[write] = particle;
      write += 1;
    }
  }
  particles.length = write;

  const spawnParticle = (isSpark: boolean): void => {
    const sourceColumn = Math.floor(Math.random() * columns);
    const life = isSpark ? 20 + Math.random() * 24 : 22 + Math.random() * 28;
    particles.push({
      kind: isSpark ? "spark" : "ember",
      glyph: isSpark ? (Math.random() < 0.5 ? "'" : "|") : ".",
      x: sourceColumn + (Math.random() - 0.5) * 2,
      y: rows - Math.max(2, config.thickness),
      velocityX: (Math.random() - 0.5) * (isSpark ? 0.45 : 0.16),
      velocityY: isSpark ? -(0.8 + Math.random() * 0.8) : -(0.16 + Math.random() * 0.24),
      heat: isSpark ? 1.2 : 0.76,
      life,
      maxLife: life,
    });
  };

  if (config.embers && Math.random() < 0.2 * 2.4) spawnParticle(false);
  if (config.sparks && Math.random() < 0.07 * 2.4) spawnParticle(true);

  // Same cap the old `.slice(-n)` applied: keep the newest, drop from the front.
  const cap = Math.max(40, Math.round(columns * 1.5));
  if (particles.length > cap) particles.splice(0, particles.length - cap);
};

/**
 * Everything the renderer keeps between frames.
 *
 * The frame used to be built as one multi-kilobyte HTML string and assigned to
 * `innerHTML`, which made the browser parse it, destroy every existing node,
 * build a few hundred new `<span>`s, resolve styles for all of them and lay the
 * text out again — thirty times a second, on the main thread, behind a card
 * nobody is looking at that hard.
 *
 * The `<pre>` now owns a pool of `<span>`s that live for the lifetime of the
 * effect. A frame walks the same runs it always did and writes `textContent`
 * and `style.color` only where they actually changed. The markup, the CSS and
 * therefore the rendered result are identical; the parse and the node churn are
 * gone. The scratch buffers below replace the `Float32Array` copy and the `Map`
 * that used to be allocated per frame.
 */
interface FireRenderState {
  /** Reused copy of the heat field with particle heat folded in. */
  display: Float32Array;
  /** Frame number that last wrote a particle glyph into each cell. */
  glyphStamp: Int32Array;
  glyphColor: string[];
  glyphChar: string[];
  stamp: number;
  spans: HTMLSpanElement[];
  spanText: string[];
  spanColor: string[];
}

const createRenderState = (): FireRenderState => ({
  display: new Float32Array(0),
  glyphStamp: new Int32Array(0),
  glyphColor: [],
  glyphChar: [],
  stamp: 0,
  spans: [],
  spanText: [],
  spanColor: [],
});

const resizeRenderState = (state: FireRenderState, cells: number): void => {
  state.display = new Float32Array(cells);
  state.glyphStamp = new Int32Array(cells);
  state.glyphColor = new Array<string>(cells).fill("");
  state.glyphChar = new Array<string>(cells).fill("");
  state.stamp = 0;
};

const renderFire = (
  element: HTMLPreElement,
  state: FireRenderState,
  heat: Float32Array,
  particles: FireParticle[],
  columns: number,
  rows: number,
  charsetName: FireCharset,
  palette: readonly string[],
  sparkColor: string,
): void => {
  const displayHeat = state.display;
  displayHeat.set(heat);

  // A monotonic stamp stands in for clearing the per-cell glyph map: a cell
  // counts as carrying a particle only if it was written this frame.
  state.stamp += 1;
  const stamp = state.stamp;
  const glyphStamp = state.glyphStamp;
  const glyphColor = state.glyphColor;
  const glyphChar = state.glyphChar;

  const safePalette = palette.length > 0 ? palette : MONO_PALETTE;
  const resolvedSparkColor = sparkColor || safePalette[safePalette.length - 1];
  const emberColor = safePalette[Math.max(0, safePalette.length - 3)];

  for (const particle of particles) {
    const column = clamp(Math.round(particle.x), 0, columns - 1);
    const row = clamp(Math.round(particle.y), 0, rows - 1);
    const fade = particle.life / particle.maxLife;
    const index = row * columns + column;
    displayHeat[index] = Math.max(displayHeat[index], particle.heat * fade);
    if (particle.kind === "spark" || glyphStamp[index] !== stamp) {
      glyphStamp[index] = stamp;
      glyphColor[index] = particle.kind === "spark" ? resolvedSparkColor : emberColor;
      glyphChar[index] = particle.glyph;
    }
  }

  const characters = resolveCharacters(charsetName);
  const spans = state.spans;
  const spanText = state.spanText;
  const spanColor = state.spanColor;
  let used = 0;

  const emitRun = (text: string, color: string): void => {
    let span = spans[used];
    if (!span) {
      span = document.createElement("span");
      spans[used] = span;
      spanText[used] = "";
      spanColor[used] = "";
      element.appendChild(span);
    }
    if (spanText[used] !== text) {
      span.textContent = text;
      spanText[used] = text;
    }
    if (spanColor[used] !== color) {
      span.style.color = color;
      spanColor[used] = color;
    }
    used += 1;
  };

  for (let row = 0; row < rows; row += 1) {
    let activeColor = "";
    let run = "";

    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const value = displayHeat[index];
      const hasGlyph = glyphStamp[index] === stamp;
      const characterIndex = clamp(Math.floor(value * (characters.length - 1)), 0, characters.length - 1);
      const paletteIndex = clamp(
        Math.floor(Math.pow(value, 0.72) * (safePalette.length - 1)),
        0,
        safePalette.length - 1,
      );
      const color = hasGlyph ? glyphColor[index] : value < 0.025 ? "" : safePalette[paletteIndex];
      const character = hasGlyph ? glyphChar[index] : value < 0.025 ? " " : characters[characterIndex];

      if (color !== activeColor) {
        if (run) emitRun(run, activeColor);
        run = "";
        activeColor = color;
      }
      run += character;
    }

    // The row separator rides along inside the last run of the row, which is
    // what `lines.join("\n")` produced. Carrying it here also guarantees a run
    // exists for an otherwise empty row, so blank rows keep their line break.
    if (row < rows - 1) run += "\n";
    if (run) emitRun(run, activeColor);
  }

  for (let i = used; i < spans.length; i += 1) {
    if (spanText[i] !== "") {
      spans[i].textContent = "";
      spanText[i] = "";
    }
  }
};

export default function AsciiFlame({
  intensity = 100,
  windDirection = "right",
  windForce = 10,
  decay = 13,
  turbulence = 30,
  thickness = 1,
  embers = true,
  sparks = true,
  pulse = false,
  palette = "custom",
  shades,
  sparkColor = "#FF3030",
  charset = "dense",
  backgroundColor = "#000000",
  className = "",
  style,
}: AsciiFlameProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);

  // The ramp is read through a ref and the effect keys off its contents, so a
  // parent that rebuilds the array every render does not restart the fire.
  const shadesRef = useRef<string[] | undefined>(shades);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    shadesRef.current = shades;
  });
  const shadesKey = shades ? shades.join("|") : "";

  useEffect(() => {
    const container = containerRef.current;
    const output = outputRef.current;
    if (!container || !output) return;
    const box: HTMLDivElement = container;
    const pre: HTMLPreElement = output;
    // A prop change re-runs this effect with a fresh, empty span pool, so drop
    // the pool the previous run left behind rather than appending after it.
    pre.textContent = "";

    const measurementContext = document.createElement("canvas").getContext("2d");
    const activePalette = resolvePalette(palette, shadesRef.current).map((shade, index) =>
      sanitizeCssColor(shade, COLOR_PALETTE[Math.min(index, COLOR_PALETTE.length - 1)]),
    );
    const activeSparkColor =
      palette === "custom"
        ? sanitizeCssColor(sparkColor, "#FF3030")
        : activePalette[activePalette.length - 1];

    let animationFrameId = 0;
    // Zero, not one. `handleResize` returns early when the measurement produces
    // the grid it already built, on the understanding that every buffer below
    // already matches that grid — but 1x1 was a grid nothing had been built
    // for. A container measuring 0 (a hidden tab, a collapsed panel, any prop
    // change while either is true) floors to exactly 1x1, the guard fired,
    // `resizeRenderState` never ran, and the first `drawFrame` hit
    // `displayHeat.set(heat)` with a zero-length target and threw
    // `RangeError: offset is out of bounds`. The re-arming
    // `requestAnimationFrame` sits after that line, so the loop did not come
    // back: the observer's later measurement painted one static frame and the
    // fire stayed frozen for good. A measured grid is never smaller than 1x1,
    // so 0x0 cannot be mistaken for one, and the guard's premise holds again.
    let columns = 0;
    let rows = 0;
    let heat = new Float32Array(0);
    let nextHeat = new Float32Array(0);
    const particles: FireParticle[] = [];
    const renderState = createRenderState();
    let previousFrameTime = 0;
    const startTime = performance.now();

    const config: FireConfig = {
      intensity,
      wind: resolveWind(windDirection, windForce),
      decay,
      turbulence,
      thickness,
      embers,
      sparks,
      pulse,
    };

    const handleResize = (entry?: ResizeObserverEntry): void => {
      const rect = entry?.contentRect ?? box.getBoundingClientRect();
      const width = Math.max(1, rect.width || box.clientWidth || 1);
      const height = Math.max(1, rect.height || box.clientHeight || 1);

      const lineHeight = FONT_SIZE * 1.05;
      if (measurementContext) measurementContext.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
      const characterWidth = measurementContext?.measureText("M").width || FONT_SIZE * 0.6;
      const nextColumns = Math.max(1, Math.floor(width / characterWidth));
      const nextRows = Math.max(1, Math.floor(height / lineHeight));
      if (nextColumns === columns && nextRows === rows) return;

      columns = nextColumns;
      rows = nextRows;
      heat = new Float32Array(columns * rows);
      nextHeat = new Float32Array(columns * rows);
      particles.length = 0;
      resizeRenderState(renderState, columns * rows);

      // Burn a few dozen frames up front so the card opens on a lit fire
      // instead of on an empty grid filling in.
      for (let warmUpStep = 0; warmUpStep < Math.min(rows, 48); warmUpStep += 1) {
        seedFuel(heat, columns, rows, config, warmUpStep / FPS);
        propagateFire(heat, nextHeat, columns, rows, config);
        [heat, nextHeat] = [nextHeat, heat];
      }

      renderFire(pre, renderState, heat, particles, columns, rows, charset, activePalette, activeSparkColor);
    };

    const drawFrame = (timestamp: number): void => {
      const frameInterval = 1000 / FPS;
      const elapsedSinceFrame = timestamp - previousFrameTime;

      if (elapsedSinceFrame >= frameInterval || previousFrameTime === 0) {
        const elapsedSeconds = (timestamp - startTime) / 1000;
        seedFuel(heat, columns, rows, config, elapsedSeconds);
        propagateFire(heat, nextHeat, columns, rows, config);
        [heat, nextHeat] = [nextHeat, heat];
        updateParticles(particles, columns, rows, config);
        renderFire(pre, renderState, heat, particles, columns, rows, charset, activePalette, activeSparkColor);
        previousFrameTime = timestamp - (elapsedSinceFrame % frameInterval);
      }

      animationFrameId = requestAnimationFrame(drawFrame);
    };

    handleResize();
    animationFrameId = requestAnimationFrame(drawFrame);

    const resizeObserver = new ResizeObserver((entries) => handleResize(entries[0]));
    resizeObserver.observe(box);

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, [
    intensity,
    windDirection,
    windForce,
    decay,
    turbulence,
    thickness,
    embers,
    sparks,
    pulse,
    palette,
    shadesKey,
    sparkColor,
    charset,
  ]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
      style={{ backgroundColor, ...style }}
    >
      <pre
        ref={outputRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 block h-full w-full select-none overflow-hidden"
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: FONT_SIZE,
          fontVariantLigatures: "none",
          lineHeight: 1.05,
          whiteSpace: "pre",
          textRendering: "optimizeSpeed",
        }}
      />
    </div>
  );
}

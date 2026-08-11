import { useRef, useEffect, useState } from 'react';

import { resolveRenderScale } from './render-scale';

export interface LetterGlitchProps {
  glitchColors?: string[];
  glitchSpeed?: number;
  centerVignette?: boolean;
  outerVignette?: boolean;
  smooth?: boolean;
  characters?: string;
  /**
   * Painted under the glyphs. Defaults to nothing at all: this effect is
   * mounted OVER an operator's surface — a card, a gradient, a themed page —
   * and a hardcoded `bg-black` wrapper (which is what stood here) paints that
   * surface out on every theme.
   */
  backgroundColor?: string;
  className?: string;
}

const DEFAULT_GLITCH_COLORS = ['#2b4539', '#61dca3', '#61b3dc'];
const DEFAULT_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$&*()-_+=/[]{};:<>.,0123456789';

const LetterGlitch = ({
  glitchColors = DEFAULT_GLITCH_COLORS,
  glitchSpeed = 50,
  centerVignette = false,
  // Defaults OFF. It is a black radial overlay, so leaving it on by default
  // makes every mount darken whatever is beneath it whether the operator asked
  // for that or not.
  outerVignette = false,
  smooth = true,
  characters = DEFAULT_CHARACTERS,
  backgroundColor,
  className = ''
}: LetterGlitchProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const letters = useRef<
    {
      char: string;
      color: string;
      targetColor: string;
      colorProgress: number;
    }[]
  >([]);
  const grid = useRef({ columns: 0, rows: 0 });
  const context = useRef<CanvasRenderingContext2D | null>(null);
  const lastGlitchTime = useRef(Date.now());
  /**
   * Bumped by `contextrestored` to re-run the mount effect, exactly as the GL
   * effects in this directory bump theirs on `webglcontextrestored`.
   *
   * THE EVENT NAMES DIFFER BECAUSE THE CONTEXT DOES. This canvas is 2D, and
   * `webglcontextlost` is dispatched only at a canvas holding a WebGL context —
   * a listener for it here could never fire once, which is worse than no
   * handler at all because it reads like one. The 2D contract is HTML's
   * `contextlost`/`contextrestored`, and its `preventDefault()` means the
   * OPPOSITE of WebGL's: on `webglcontextlost` it asks the user agent to
   * restore, on 2D `contextlost` it sets "context restoration disabled" and
   * makes the loss permanent. So this handler deliberately does NOT call it.
   *
   * The rebuild is needed for the same reason as over there: a lost 2D context
   * is reset to its defaults, which drops the device-pixel transform and the
   * font `resizeCanvas` installed, so the grid would come back at the wrong
   * scale in the wrong face over a cleared bitmap.
   */
  const [glGeneration, setGlGeneration] = useState(0);
  /**
   * A ref rather than a local in the effect, because `animate` below is
   * component-scope and re-schedules itself: a local would be invisible to the
   * one function that has to stop. Cleared on every effect setup, so the loop
   * the rebuild starts is not stopped by the loss that caused it.
   */
  const contextLostRef = useRef(false);

  /**
   * The alphabet and the palette live in refs because the render loop is
   * started ONCE from the mount effect and re-schedules itself, so it keeps the
   * closure it was created with for its whole life. Reading these two from that
   * closure made them dead controls: `glitchColors` and `characters` are not in
   * the effect's dependency array, so changing either used to change nothing at
   * all until something unrelated happened to remount the component.
   *
   * Assigning during render is what keeps them current — an effect would land a
   * frame late, and a frame late here is a visibly stale palette on the first
   * repaint after a colour change.
   */
  const charactersRef = useRef<string[]>(Array.from(characters));
  charactersRef.current = Array.from(characters);
  const glitchColorsRef = useRef<string[]>(glitchColors);
  glitchColorsRef.current = glitchColors.length > 0 ? glitchColors : DEFAULT_GLITCH_COLORS;
  const smoothRef = useRef(smooth);
  smoothRef.current = smooth;
  const glitchSpeedRef = useRef(glitchSpeed);
  glitchSpeedRef.current = glitchSpeed;

  const fontSize = 16;
  const charWidth = 10;
  const charHeight = 20;

  const getRandomChar = () => {
    const pool = charactersRef.current;
    return pool[Math.floor(Math.random() * pool.length)] ?? ' ';
  };

  const getRandomColor = () => {
    const pool = glitchColorsRef.current;
    return pool[Math.floor(Math.random() * pool.length)] ?? '#ffffff';
  };

  const hexToRgb = (hex: string) => {
    const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    hex = hex.replace(shorthandRegex, (_m, r, g, b) => {
      return r + r + g + g + b + b;
    });

    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16)
        }
      : null;
  };

  const interpolateColor = (
    start: { r: number; g: number; b: number },
    end: { r: number; g: number; b: number },
    factor: number
  ) => {
    const result = {
      r: Math.round(start.r + (end.r - start.r) * factor),
      g: Math.round(start.g + (end.g - start.g) * factor),
      b: Math.round(start.b + (end.b - start.b) * factor)
    };
    return `rgb(${result.r}, ${result.g}, ${result.b})`;
  };

  const calculateGrid = (width: number, height: number) => {
    const columns = Math.ceil(width / charWidth);
    const rows = Math.ceil(height / charHeight);
    return { columns, rows };
  };

  const initializeLetters = (columns: number, rows: number) => {
    grid.current = { columns, rows };
    const totalLetters = columns * rows;
    letters.current = Array.from({ length: totalLetters }, () => ({
      char: getRandomChar(),
      color: getRandomColor(),
      targetColor: getRandomColor(),
      colorProgress: 1
    }));
  };

  /** The CSS box, in CSS pixels — what the glyph lattice is laid out in. */
  const cssSize = useRef({ width: 0, height: 0 });

  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    cssSize.current = { width, height };

    // Cap the BITMAP, never the CSS box. This effect clears and fills text on
    // the MAIN THREAD every frame, so a full-viewport bitmap is felt as input
    // latency rather than as dropped shader frames. The glyph lattice below
    // stays in CSS pixels — `charWidth`/`charHeight` and therefore the COUNT of
    // letters are computed from `rect`, not from the bitmap — and the context
    // transform maps them into it, so the type is the same size on screen at
    // every ratio. The canvas element itself is `w-full h-full`; nothing here
    // touches its presentation size. See `render-scale.ts`.
    const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = resolveRenderScale(width, height, baseDpr) * baseDpr;

    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    if (context.current) {
      // After the assignments above, which reset every context property.
      context.current.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    const { columns, rows } = calculateGrid(width, height);
    initializeLetters(columns, rows);
    drawLetters();
  };

  const drawLetters = () => {
    if (!context.current || letters.current.length === 0) return;
    const ctx = context.current;
    const { width, height } = cssSize.current;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `${fontSize}px monospace`;
    ctx.textBaseline = 'top';

    letters.current.forEach((letter, index) => {
      const x = (index % grid.current.columns) * charWidth;
      const y = Math.floor(index / grid.current.columns) * charHeight;
      ctx.fillStyle = letter.color;
      ctx.fillText(letter.char, x, y);
    });
  };

  const updateLetters = () => {
    if (!letters.current || letters.current.length === 0) return;

    const updateCount = Math.max(1, Math.floor(letters.current.length * 0.05));

    for (let i = 0; i < updateCount; i++) {
      const index = Math.floor(Math.random() * letters.current.length);
      if (!letters.current[index]) continue;

      letters.current[index].char = getRandomChar();
      letters.current[index].targetColor = getRandomColor();

      if (!smoothRef.current) {
        letters.current[index].color = letters.current[index].targetColor;
        letters.current[index].colorProgress = 1;
      } else {
        letters.current[index].colorProgress = 0;
      }
    }
  };

  const handleSmoothTransitions = () => {
    let needsRedraw = false;
    letters.current.forEach(letter => {
      if (letter.colorProgress < 1) {
        letter.colorProgress += 0.05;
        if (letter.colorProgress > 1) letter.colorProgress = 1;

        const startRgb = hexToRgb(letter.color);
        const endRgb = hexToRgb(letter.targetColor);
        if (startRgb && endRgb) {
          letter.color = interpolateColor(startRgb, endRgb, letter.colorProgress);
          needsRedraw = true;
        }
      }
    });

    if (needsRedraw) {
      drawLetters();
    }
  };

  const animate = () => {
    if (contextLostRef.current) return;
    const now = Date.now();
    if (now - lastGlitchTime.current >= glitchSpeedRef.current) {
      updateLetters();
      drawLetters();
      lastGlitchTime.current = now;
    }

    if (smoothRef.current) {
      handleSmoothTransitions();
    }

    animationRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    context.current = canvas.getContext('2d');
    contextLostRef.current = false;
    resizeCanvas();
    animate();

    let resizeTimeout: ReturnType<typeof setTimeout>;

    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
        resizeCanvas();
        animate();
      }, 100);
    };

    window.addEventListener('resize', handleResize);
    // A window `resize` alone misses every reason this box actually changes
    // size — a panel opening, a card reflowing — which leaves the letter grid
    // sized for a box that is no longer there.
    const ro = new ResizeObserver(handleResize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    // NO preventDefault here — see the note on `glGeneration`. On a 2D canvas
    // cancelling this event is what makes the loss permanent.
    const handleContextLost = () => {
      contextLostRef.current = true;
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
    // Restarting the loop alone would draw through a context that was reset to
    // its defaults — no device-pixel transform, no font — so the grid would
    // come back at the wrong scale. Re-running the effect re-measures, re-seeds
    // the letters and re-installs both.
    const handleContextRestored = () => {
      setGlGeneration(generation => generation + 1);
    };
    canvas.addEventListener('contextlost', handleContextLost);
    canvas.addEventListener('contextrestored', handleContextRestored);

    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handleResize);
      ro.disconnect();
      canvas.removeEventListener('contextlost', handleContextLost);
      canvas.removeEventListener('contextrestored', handleContextRestored);
      context.current = null;
    };
    // Every prop is read through a ref by the loop above, so nothing but a
    // replaced 2D context restarts this. There is no GL context on this canvas
    // — it is 2D — so nothing is released on teardown and the React-owned
    // `<canvas ref>` below stays inside `reactbits-canvas-ownership.test.ts`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glGeneration]);

  return (
    <div
      className={`relative w-full h-full overflow-hidden ${className}`.trim()}
      style={backgroundColor ? { backgroundColor } : undefined}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
      {outerVignette && (
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none bg-[radial-gradient(circle,_rgba(0,0,0,0)_60%,_rgba(0,0,0,1)_100%)]"></div>
      )}
      {centerVignette && (
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none bg-[radial-gradient(circle,_rgba(0,0,0,0.8)_0%,_rgba(0,0,0,0)_60%)]"></div>
      )}
    </div>
  );
};

export default LetterGlitch;

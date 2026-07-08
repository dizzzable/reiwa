import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { LandingAnimation, LandingBackground } from './landing-schema';

/**
 * LandingBg — a fixed, pointer-transparent CSS background layer behind all
 * sections. Pure CSS (see landing.css); no WebGL. The chosen effect + colors
 * come from the theme; animation is disabled automatically via CSS when the
 * user prefers reduced motion.
 */
export function LandingBg({
  effect,
  colors,
  animate,
}: {
  effect: LandingBackground | undefined;
  colors: readonly string[] | undefined;
  animate: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Spotlight follows the cursor: track pointer and set --lx/--ly (rAF-throttled,
  // no-op unless the spotlight effect is active + motion is allowed). Cursor-
  // following is vestibular motion, so it's also disabled under
  // prefers-reduced-motion.
  useEffect(() => {
    if (effect !== 'spotlight' || !animate) return undefined;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    const node = ref.current;
    if (node === null) return undefined;
    let raf = 0;
    const onMove = (e: PointerEvent): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        node.style.setProperty('--lx', `${(e.clientX / window.innerWidth) * 100}%`);
        node.style.setProperty('--ly', `${(e.clientY / window.innerHeight) * 100}%`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [effect, animate]);

  if (!effect || effect === 'none') return null;
  if (effect === 'network') {
    return <NetworkCanvas color={colors?.[0] ?? '#22c55e'} animate={animate} />;
  }
  const style: CSSProperties = {};
  const [c1, c2, c3] = colors ?? [];
  const vars = style as Record<string, string>;
  if (c1) vars['--ls-c1'] = c1;
  if (c2) vars['--ls-c2'] = c2;
  if (c3) vars['--ls-c3'] = c3;
  return <div ref={ref} className={`ls-bg ls-bg--${effect}`} data-animate={animate ? 'on' : 'off'} style={style} aria-hidden="true" />;
}

/**
 * NetworkCanvas — animated "graph / network" background: drifting nodes joined
 * by lines that fade with distance (the "internet mesh" look). Tiny 2D-canvas
 * loop, no WebGL / no library — light enough for the pre-login bundle. Honors
 * prefers-reduced-motion by rendering a single static frame.
 */
export function NetworkCanvas({ color, animate }: { color: string; animate: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (canvas === null || wrap === null) return undefined;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return undefined;

    const win = canvas.ownerDocument.defaultView ?? window;
    const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let width = 0;
    let height = 0;

    interface Node {
      x: number;
      y: number;
      vx: number;
      vy: number;
    }
    let nodes: Node[] = [];

    const seed = (): void => {
      const count = Math.max(18, Math.min(70, Math.round((width * height) / 20000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
      }));
    };

    const resize = (): void => {
      const dpr = Math.min(win.devicePixelRatio || 1, 2);
      width = wrap.clientWidth || 1;
      height = wrap.clientHeight || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const rgb = hexToRgb(color);
    const linkDist = 130;

    const draw = (): void => {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        if (animate && !reduced) {
          a.x += a.vx;
          a.y += a.vy;
          if (a.x < 0 || a.x > width) a.vx *= -1;
          if (a.y < 0 || a.y > height) a.vy *= -1;
        }
        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < linkDist) {
            const alpha = (1 - dist / linkDist) * 0.5;
            ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.85)`;
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    let raf = 0;
    const loop = (): void => {
      draw();
      raf = win.requestAnimationFrame(loop);
    };

    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    if (animate && !reduced) loop();
    else draw();

    return () => {
      if (raf !== 0) win.cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [color, animate]);

  return (
    <div ref={wrapRef} className="ls-bg" aria-hidden="true">
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 34, g: 197, b: 94 };
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const int = parseInt(h, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * Reveal — wraps a section and fades/slides it in when it scrolls into view
 * (IntersectionObserver, one-shot). `animation === 'none'`/undefined renders
 * the child immediately with no wrapper cost beyond a div.
 */
export function Reveal({
  animation,
  children,
}: {
  animation: LandingAnimation | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (animation === undefined || animation === 'none') return undefined;
    const node = ref.current;
    if (node === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [animation]);

  if (animation === undefined || animation === 'none') return <>{children}</>;
  return (
    <div ref={ref} className={`ls-reveal ls-reveal--${animation}${visible ? ' is-visible' : ''}`}>
      {children}
    </div>
  );
}

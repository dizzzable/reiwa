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
  const style: CSSProperties = {};
  const [c1, c2, c3] = colors ?? [];
  const vars = style as Record<string, string>;
  if (c1) vars['--ls-c1'] = c1;
  if (c2) vars['--ls-c2'] = c2;
  if (c3) vars['--ls-c3'] = c3;
  return <div ref={ref} className={`ls-bg ls-bg--${effect}`} data-animate={animate ? 'on' : 'off'} style={style} aria-hidden="true" />;
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

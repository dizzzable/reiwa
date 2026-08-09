import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

interface FloatingIconsProps {
  text?: string;
  direction?: 'top' | 'bottom';
  amount?: number;
  minSpeed?: number;
  maxSpeed?: number;
  minShake?: number;
  maxShake?: number;
  coverage?: number;
  minSize?: number;
  maxSize?: number;
  loop?: boolean;
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

interface Bubble {
  key: string;
  x: number;
  startOffset: number;
  size: number;
  px: number;
  wobble: Array<{ f: number; phase: number; w: number }>;
  shakeAmp: number;
  riseScale: number;
  emoji: string;
}

/** Split a string into grapheme clusters so multi-codepoint emoji stay whole. */
function splitEmoji(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const parts =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t), s => s.segment)
      : Array.from(t);
  return parts.filter(c => c.trim() !== '');
}

const MAX_START = 0.2;
const RISE = 0.65;
const CYCLE_SCALE = 0.25;

/**
 * FloatingIcons - a batch of text glyphs drifting across the card, each with
 * its own speed, size and side-to-side wander. The batch regenerates every
 * cycle while `loop` is on.
 *
 * Glyphs are absolutely positioned <span>s. Their motion used to run through
 * React: a `setTime()` every rAF callback re-rendered up to 80 spans with fresh
 * inline `left`/`top`/`transform`/`opacity` sixty times a second, and because
 * each span carried `transition: opacity 0.2s, transform 0.2s`, every one of
 * those frames also restarted eighty 200 ms transitions that never got to
 * finish. React now renders a span only when the batch is regenerated - once
 * per cycle, several seconds apart - and the loop writes styles straight onto
 * the elements.
 *
 * Position is carried by `transform: translate(...)` rather than `left`/`top`.
 * The composition is the same (`translate` moves the box, `scale` still works
 * about its centre, so every glyph lands on the same pixel it did before), but
 * an absolutely positioned element changing `left`/`top` forces layout, and one
 * changing only `transform` does not.
 */
export default function FloatingIcons({
  text = '❤️',
  direction = 'bottom',
  amount = 30,
  minSpeed = 20,
  maxSpeed = 23,
  minShake = 32,
  maxShake = 0,
  coverage = 100,
  minSize = 4,
  maxSize = 54,
  loop = true,
  backgroundColor = 'transparent',
  className = '',
  style = {}
}: FloatingIconsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  // Only the whole-cycle index lives in React state; the fractional phase does
  // not, so this changes once per cycle instead of once per frame.
  const [cycleIndex, setCycleIndex] = useState(0);

  const sizeRange = Math.max(0, maxSize - minSize);

  const timeRef = useRef(0);
  const cycleRef = useRef(0);
  const nodesRef = useRef<Array<HTMLSpanElement | null>>([]);
  const bubblesRef = useRef<Bubble[]>(bubbles);

  // The frame loop walks `bubblesRef` and `nodesRef` by the same index, so the
  // two have to change together, and they have to change at a moment no frame
  // can land in the middle of. Committing them here does both: the generator
  // effect below hands the new batch to React and touches nothing the loop
  // reads, and this runs inside the same synchronous commit that inserted the
  // new spans and nulled the removed ones. Between the two the loop keeps
  // animating the old batch against the old nodes - a consistent pair.
  //
  // Truncating `nodesRef` in the generator effect instead left the loop reading
  // the old, longer bubble list through a shortened node array for however many
  // frames the re-render took, and every glyph past the new length simply
  // stopped where it was.
  useLayoutEffect(() => {
    bubblesRef.current = bubbles;
    nodesRef.current.length = bubbles.length;
  }, [bubbles]);

  // Everything the frame loop reads, refreshed on render so the loop itself
  // never has to restart when a control moves.
  const cfgRef = useRef({ direction, coverage, loop, maxSpeed, width: 0, height: 0 });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effects below.
  useEffect(() => {
    cfgRef.current = {
      direction,
      coverage,
      loop,
      maxSpeed,
      width: dimensions.width,
      height: dimensions.height
    };
  });

  // Size from the container. The card layer owns visibility and mount, so
  // there is no IntersectionObserver here - the loop runs whenever mounted.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const rect = container.getBoundingClientRect();
      const w = container.clientWidth || Math.round(rect.width);
      const h = container.clientHeight || Math.round(rect.height);
      if (w > 0 && h > 0) {
        setDimensions(prev => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let running = true;

    const applyFrame = () => {
      const cfg = cfgRef.current;
      const list = bubblesRef.current;
      const nodes = nodesRef.current;
      const t = timeRef.current;
      const index = Math.floor(t);
      const phase = t - index;
      const travel = cfg.height * (cfg.coverage / 100);
      const finished = !cfg.loop && index >= 1;

      for (let i = 0; i < list.length; i++) {
        const node = nodes[i];
        if (!node) continue;
        const b = list[i];

        const p = finished ? -1 : ((phase - b.startOffset) * b.riseScale) / RISE;
        if (p <= 0 || p >= 1) {
          // `visibility`, not `display`. A glyph that has not entered yet or has
          // already left has to disappear, but toggling `display` adds and
          // removes a box from the layout tree, which dirties layout for the
          // container - and every glyph in the batch crosses this line within a
          // frame or two of the cycle boundary. `visibility` is a paint-level
          // property: the box stays where it is, absolutely positioned and
          // sized, and nothing is reflowed.
          if (node.style.visibility !== 'hidden') node.style.visibility = 'hidden';
          continue;
        }

        let scale = 1;
        if (p < 0.15) scale = p / 0.15;
        else if (p > 0.85) scale = (1 - p) / 0.15;
        let opacity = 1;
        if (p < 0.1) opacity = p / 0.1;
        else if (p > 0.6) opacity = (1 - p) / 0.4;
        if (phase > 0.85) opacity *= Math.max(0, (1 - phase) / 0.15);
        if (opacity <= 0 || scale <= 0) {
          if (node.style.visibility !== 'hidden') node.style.visibility = 'hidden';
          continue;
        }

        const zigzagAmplitude = b.shakeAmp * b.size;
        let wander = 0;
        let wsum = 0;
        for (const h of b.wobble) {
          wander += Math.sin(p * h.f * Math.PI + h.phase) * h.w;
          wsum += h.w;
        }
        const zigzag = (wander / wsum) * zigzagAmplitude;
        const left = b.x * (cfg.width - b.px) + zigzag + b.px / 2;
        const top = cfg.direction === 'top' ? p * travel - b.px : cfg.height - p * travel;

        if (node.style.visibility !== 'visible') node.style.visibility = 'visible';
        node.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
        node.style.opacity = String(opacity);
      }
    };

    const animate = (now: number) => {
      if (!running) return;
      const dt = (now - last) / 1e3;
      last = now;
      timeRef.current += dt * (cfgRef.current.maxSpeed / 50) * CYCLE_SCALE;
      const index = Math.floor(timeRef.current);
      if (index !== cycleRef.current) {
        cycleRef.current = index;
        setCycleIndex(index);
      }
      applyFrame();
      frame = requestAnimationFrame(animate);
    };

    applyFrame();
    frame = requestAnimationFrame(animate);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  const regenKey = loop ? cycleIndex : 0;
  const emojis = useMemo(() => splitEmoji(text), [text]);

  useEffect(() => {
    const shakeLo = Math.min(minShake, maxShake);
    const shakeHi = Math.max(minShake, maxShake);
    const spdLo = Math.max(1, Math.min(minSpeed, maxSpeed));
    const spdHi = Math.max(1, Math.max(minSpeed, maxSpeed));
    const arr: Bubble[] = [];
    for (let i = 0; i < amount; i++) {
      const shakeVal = shakeLo + Math.random() * (shakeHi - shakeLo);
      const spdVal = spdLo + Math.random() * (spdHi - spdLo);
      arr.push({
        key: regenKey + '-' + i,
        x: Math.random(),
        startOffset: Math.random() * MAX_START,
        size: 0.7 + Math.random() * 0.6,
        px: minSize + Math.random() * sizeRange,
        shakeAmp: (shakeVal / 100) * 90,
        riseScale: spdVal / spdHi,
        wobble: [
          { f: 2 + Math.random() * 2, phase: Math.random() * 2 * Math.PI, w: 1 },
          { f: 4 + Math.random() * 3, phase: Math.random() * 2 * Math.PI, w: 0.5 },
          { f: 6 + Math.random() * 4, phase: Math.random() * 2 * Math.PI, w: 0.3 }
        ],
        emoji: emojis.length ? emojis[Math.floor(Math.random() * emojis.length)] : text
      });
    }
    setBubbles(arr);
  }, [regenKey, amount, minSize, maxSize, sizeRange, text, emojis, minShake, maxShake, minSpeed, maxSpeed]);

  return (
    <div
      ref={containerRef}
      style={{ backgroundColor, ...style }}
      className={`absolute inset-0 h-full w-full overflow-hidden ${className}`}
    >
      {bubbles.map((b, i) => (
        <span
          key={b.key}
          ref={node => {
            nodesRef.current[i] = node;
          }}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: b.px,
            height: b.px,
            // `flex` centres the glyph in its box and never changes; the loop
            // hides and shows through `visibility` so no frame touches layout.
            display: 'flex',
            // Parked until the loop places it, so a newly mounted batch never
            // flashes at the origin.
            visibility: 'hidden',
            pointerEvents: 'none',
            filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.08))',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: b.px * 0.6
          }}
        >
          {b.emoji || text || 'A'}
        </span>
      ))}
    </div>
  );
}

import { useEffect, useRef } from 'react';

function createNoise2D(seed = 0.5) {
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const G22 = (3 - Math.sqrt(3)) / 3;
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;

  const seededRandom = (index: number) => {
    const x = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 255; i > 0; i--) {
    const n = Math.floor((i + 1) * seededRandom(i));
    const q = p[i];
    p[i] = p[n];
    p[n] = q;
  }

  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  const grad2 = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);
  const fastFloor = (x: number) => Math.floor(x) | 0;

  return function noise2D(x: number, y: number) {
    const s = (x + y) * F2;
    const i = fastFloor(x + s);
    const j = fastFloor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    let i1: number, j1: number;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    } else {
      i1 = 0;
      j1 = 1;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + G22;
    const y2 = y0 - 1 + G22;
    const ii = i & 255;
    const jj = j & 255;
    const gi0 = permMod12[ii + perm[jj]];
    const gi1 = permMod12[ii + i1 + perm[jj + j1]];
    const gi2 = permMod12[ii + 1 + perm[jj + 1]];
    let n0 = 0,
      n1 = 0,
      n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (grad2[gi0 * 2] * x0 + grad2[gi0 * 2 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (grad2[gi1 * 2] * x1 + grad2[gi1 * 2 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (grad2[gi2 * 2] * x2 + grad2[gi2 * 2 + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  };
}

interface Point {
  x: number;
  y: number;
  angle: number;
  cursor: { x: number; y: number; vx: number; vy: number };
}

interface PointerState {
  x: number;
  y: number;
  lx: number;
  ly: number;
  sx: number;
  sy: number;
  vs: number;
  active: boolean;
  set: boolean;
}

export interface LineRippleBackgroundProps {
  strokeColor?: string;
  backgroundColor?: string;
  count?: number;
  movement?: number;
  hover?: boolean;
  force?: number;
  resolution?: number;
}

const BASE_ANGLE = 0;
const CURL = 3;
const SEED = 0.5;
const SVG_NS = 'http://www.w3.org/2000/svg';

export default function LineRippleBackground({
  strokeColor = '#FFFFFF',
  backgroundColor = '#000000',
  count = 57,
  movement = 24,
  hover = true,
  force = 4,
  resolution = 10
}: LineRippleBackgroundProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const pointsRef = useRef<Point[]>([]);
  const noiseRef = useRef<((x: number, y: number) => number) | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const visibleRef = useRef(true);

  const pointerRef = useRef<PointerState>({
    x: 0,
    y: 0,
    lx: 0,
    ly: 0,
    sx: 0,
    sy: 0,
    vs: 0,
    active: false,
    set: false
  });

  const rebuildRef = useRef<(() => void) | null>(null);

  const cfgRef = useRef({ strokeColor, count, movement, hover, force, resolution });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    cfgRef.current = { strokeColor, count, movement, hover, force, resolution };
  });

  useEffect(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg) return;

    noiseRef.current = createNoise2D(SEED);

    const ensurePath = (): SVGPathElement => {
      let path = pathRef.current;
      if (!path) {
        path = document.createElementNS(SVG_NS, 'path');
        svg.appendChild(path);
        pathRef.current = path;
      }
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', cfgRef.current.strokeColor);
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      return path;
    };

    const setLines = () => {
      const { width, height } = sizeRef.current;
      if (width <= 0 || height <= 0) return;
      const c = Math.max(1, Math.min(100, cfgRef.current.count));
      const gap = 90 - ((c - 1) / 99) * 82;
      const cols = Math.ceil((width + gap) / gap);
      const rows = Math.ceil((height + gap) / gap);
      const xStart = (width - gap * (cols - 1)) / 2;
      const yStart = (height - gap * (rows - 1)) / 2;

      const points: Point[] = [];
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          points.push({
            x: xStart + gap * i,
            y: yStart + gap * j,
            angle: 0,
            cursor: { x: 0, y: 0, vx: 0, vy: 0 }
          });
        }
      }
      pointsRef.current = points;
      ensurePath();
    };

    rebuildRef.current = setLines;

    const setSize = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      const prev = sizeRef.current;
      if (Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5) return;
      sizeRef.current = { width, height };
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      setLines();
    };

    const movePoints = (time: number) => {
      const points = pointsRef.current;
      const pointer = pointerRef.current;
      const noiseFn = noiseRef.current;
      if (!noiseFn) return;
      const cfg = cfgRef.current;

      const drift = time * cfg.movement * 8e-6;
      const dirX = Math.cos(BASE_ANGLE) * drift;
      const dirY = Math.sin(BASE_ANGLE) * drift;
      const interactive = cfg.hover && pointer.set && pointer.active;
      const l = Math.max(175, pointer.vs);

      for (const p of points) {
        const n = noiseFn(p.x * 0.004 - dirX, p.y * 0.004 - dirY);
        const target = BASE_ANGLE + n * Math.PI * CURL;

        let bend = 0;
        // Distance to the pointer is only ever read inside this branch, and on
        // a card nobody is touching the branch is never taken - so the sqrt and
        // the two subtractions per point per frame were pure waste.
        if (interactive) {
          const dx = p.x - pointer.sx;
          const dy = p.y - pointer.sy;
          // Math.hypot guards against intermediate overflow that cannot happen
          // at card coordinates, and pays for it with a much slower call.
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < l) {
            const s = 1 - d / l;
            const influence = (cfg.force / 10) * 0.02;
            const angleToPoint = Math.atan2(dy, dx);
            const tangent = angleToPoint + Math.PI / 2;
            bend = (tangent - target) * s * (0.4 + pointer.vs * influence);

            const f = Math.cos(d * 0.001) * s;
            const push = (cfg.force / 10) * 7e-4;
            p.cursor.vx += Math.cos(angleToPoint) * f * l * pointer.vs * push;
            p.cursor.vy += Math.sin(angleToPoint) * f * l * pointer.vs * push;
          }
        }

        let diff = target + bend - p.angle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        p.angle += diff * 0.12;

        p.cursor.vx += (0 - p.cursor.x) * 0.01;
        p.cursor.vy += (0 - p.cursor.y) * 0.01;
        p.cursor.vx *= 0.95;
        p.cursor.vy *= 0.95;
        p.cursor.x += p.cursor.vx;
        p.cursor.y += p.cursor.vy;
        p.cursor.x = Math.min(50, Math.max(-50, p.cursor.x));
        p.cursor.y = Math.min(50, Math.max(-50, p.cursor.y));
      }
    };

    /**
     * Reused across frames. The old version grew one `d` string by repeated
     * `+=` — at the top of the density slider that is 150 template literals and
     * 150 intermediate ropes, thrown away every frame. Writing the pieces into
     * a buffer that keeps its capacity and joining once leaves one allocation.
     */
    const pathParts: string[] = [];

    /**
     * Every segment is the same length and differs only in centre and heading,
     * so the `l dx dy` half of it depends on nothing but the angle. Quantised
     * to 1/1024 of a turn, that is a table of ready-made strings: the largest
     * endpoint error it introduces is well under the 0.1 px the output is
     * rounded to anyway. Halves the number formatting per frame and shortens
     * the attribute the SVG engine has to re-parse.
     */
    const DIR_STEPS = 1024;
    const TWO_PI = Math.PI * 2;
    let dirTable: string[] = [];
    let dirCos = new Float64Array(0);
    let dirSin = new Float64Array(0);
    let dirTableHalf = -1;

    const ensureDirTable = (half: number) => {
      if (half === dirTableHalf) return;
      dirTableHalf = half;
      dirTable = new Array<string>(DIR_STEPS);
      dirCos = new Float64Array(DIR_STEPS);
      dirSin = new Float64Array(DIR_STEPS);
      for (let i = 0; i < DIR_STEPS; i++) {
        const a = (i / DIR_STEPS) * TWO_PI;
        dirCos[i] = Math.cos(a) * half;
        dirSin[i] = Math.sin(a) * half;
        dirTable[i] = ` l ${(dirCos[i] * 2).toFixed(1)} ${(dirSin[i] * 2).toFixed(1)} `;
      }
    };

    const drawLines = () => {
      const path = pathRef.current;
      if (!path) return;
      const half = (6 + (cfgRef.current.resolution / 10) * 20) / 2;
      ensureDirTable(half);

      const points = pointsRef.current;
      let k = 0;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const cx = p.x + p.cursor.x;
        const cy = p.y + p.cursor.y;
        let slot = Math.round((p.angle / TWO_PI) * DIR_STEPS) % DIR_STEPS;
        if (slot < 0) slot += DIR_STEPS;
        const ux = dirCos[slot];
        const uy = dirSin[slot];
        pathParts[k] = `M ${(cx - ux).toFixed(1)} ${(cy - uy).toFixed(1)}`;
        k++;
        pathParts[k] = dirTable[slot];
        k++;
      }
      pathParts.length = k;
      path.setAttribute('d', pathParts.join(''));
    };

    const tick = (time: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (!visibleRef.current) return;

      const pointer = pointerRef.current;
      pointer.sx += (pointer.x - pointer.sx) * 0.1;
      pointer.sy += (pointer.y - pointer.sy) * 0.1;
      const dx = pointer.x - pointer.lx;
      const dy = pointer.y - pointer.ly;
      const d = Math.sqrt(dx * dx + dy * dy);
      pointer.vs += (d - pointer.vs) * 0.1;
      pointer.vs = Math.min(100, pointer.vs);
      pointer.lx = pointer.x;
      pointer.ly = pointer.y;

      movePoints(time);
      drawLines();
    };

    const updatePointer = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      const pointer = pointerRef.current;
      pointer.x = clientX - rect.left;
      pointer.y = clientY - rect.top;
      pointer.active = true;
      if (!pointer.set) {
        pointer.sx = pointer.x;
        pointer.sy = pointer.y;
        pointer.lx = pointer.x;
        pointer.ly = pointer.y;
        pointer.set = true;
      }
    };

    const onMouseMove = (e: MouseEvent) => updatePointer(e.clientX, e.clientY);
    const onMouseLeave = () => {
      pointerRef.current.active = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch) updatePointer(touch.clientX, touch.clientY);
    };
    const onTouchEnd = () => {
      pointerRef.current.active = false;
    };

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mouseleave', onMouseLeave);
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    const rect = container.getBoundingClientRect();
    setSize(rect.width, rect.height);

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const box = entry.contentRect;
        setSize(box.width, box.height);
      }
    });
    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) visibleRef.current = entry.isIntersecting;
      },
      { threshold: 0 }
    );
    intersectionObserver.observe(container);

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mouseleave', onMouseLeave);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      rebuildRef.current = null;
      if (pathRef.current) {
        pathRef.current.remove();
        pathRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    rebuildRef.current?.();
  }, [count]);

  useEffect(() => {
    const path = pathRef.current;
    if (path) path.setAttribute('stroke', strokeColor);
  }, [strokeColor]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 h-full w-full overflow-hidden"
      style={{ backgroundColor: backgroundColor || 'transparent' }}
    >
      <svg
        ref={svgRef}
        className="block h-full w-full"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      />
    </div>
  );
}

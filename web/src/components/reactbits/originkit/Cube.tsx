import { useEffect, useRef } from 'react';
import { animate, type AnimationPlaybackControls, type Transition } from 'motion/react';

import { resolveBufferRatio } from '../render-scale';

/**
 * Cube — a particle Rubik's cube that tumbles and scrambles itself.
 *
 * Ported from Originkit `cube` (preset `base`). Canvas 2D over a Float32Array
 * lattice with a hand-rolled projection and depth sort. Each quarter-turn is
 * interpolated by `animate()` from `motion`.
 *
 * The cube is autonomous: the idle tumble runs whenever nobody is dragging, and
 * `pickMove()` re-schedules itself, so drag is only ever an override.
 */

interface Shell {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  count: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Move {
  axis: number;
  layer: number;
  dir: number;
}

interface CubeConfig {
  color: string;
  cubeGrid: number;
  dotsPerFace: number;
  dotSize: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  transition: Transition;
  sizePercent: number;
  dragSensitivity: number;
}

const HALF_DIAG = Math.sqrt(3);

function latticeCoord(i: number, n: number): number {
  return n <= 1 ? 0 : -1 + (2 * i) / (n - 1);
}

function snapCoord(c: number, n: number): number {
  if (n <= 1) return 0;
  const i = Math.round(((c + 1) / 2) * (n - 1));
  return latticeCoord(Math.max(0, Math.min(n - 1, i)), n);
}

/** Every lattice point on the outer shell of an n-cube; the interior is hollow. */
function buildShell(cubeGrid: number, dotsPerFace: number): Shell {
  const totalPoints = Math.max(2, (cubeGrid - 1) * Math.max(1, dotsPerFace) + 1);

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < totalPoints; i++) {
    for (let j = 0; j < totalPoints; j++) {
      for (let k = 0; k < totalPoints; k++) {
        const onShell =
          i === 0 ||
          i === totalPoints - 1 ||
          j === 0 ||
          j === totalPoints - 1 ||
          k === 0 ||
          k === totalPoints - 1;
        if (!onShell) continue;
        xs.push(latticeCoord(i, totalPoints));
        ys.push(latticeCoord(j, totalPoints));
        zs.push(latticeCoord(k, totalPoints));
      }
    }
  }
  return {
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    z: Float32Array.from(zs),
    count: xs.length
  };
}

function bandOf(c: number, cubeGrid: number): number {
  const norm = (c + 1) / 2;
  const band = Math.floor(norm * cubeGrid);
  return Math.max(0, Math.min(cubeGrid - 1, band));
}

function rotateAxis(x: number, y: number, z: number, axis: number, c: number, s: number, out: Vec3) {
  if (axis === 0) {
    out.x = x;
    out.y = y * c - z * s;
    out.z = y * s + z * c;
  } else if (axis === 1) {
    out.x = x * c + z * s;
    out.y = y;
    out.z = -x * s + z * c;
  } else {
    out.x = x * c - y * s;
    out.y = x * s + y * c;
    out.z = z;
  }
}

function clampSpin(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-12, Math.min(12, v));
}

class RubikCubeScene {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 1;
  private height = 1;

  private cfg: CubeConfig;
  private shell: Shell;

  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;

  private depth: Float32Array;
  private pxp: Float32Array;
  private pyp: Float32Array;

  private turn: Move | null = null;
  private turnTarget = 0;
  private turnProgress = 0;
  private turnControls: AnimationPlaybackControls | null = null;
  private turnMembers: Int32Array;
  private turnMemberCount = 0;
  private memberFlag: Uint8Array;
  private lastMove: Move | null = null;

  private ax = 0.5;
  private ay = 0.6;
  private az = 0;

  private isDragging = false;
  private activePointer = -1;
  private lastMouseX = 0;
  private lastMouseY = 0;

  private frameId = 0;
  private lastT = 0;
  private disposed = false;

  private tmp: Vec3 = { x: 0, y: 0, z: 0 };

  private detachEvents: () => void = () => {};

  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, cfg: CubeConfig) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.cfg = cfg;

    this.shell = buildShell(this.clampGrid(cfg.cubeGrid), this.clampDots(cfg.dotsPerFace));
    this.px = new Float32Array(0);
    this.py = new Float32Array(0);
    this.pz = new Float32Array(0);
    this.depth = new Float32Array(0);
    this.pxp = new Float32Array(0);
    this.pyp = new Float32Array(0);
    this.memberFlag = new Uint8Array(0);
    this.turnMembers = new Int32Array(0);
    this.adoptShell();
    this.bindEvents();
  }

  private clampGrid(n: number): number {
    return Math.max(2, Math.min(8, Math.round(n)));
  }

  private clampDots(n: number): number {
    return Math.max(1, Math.min(8, Math.round(n)));
  }

  private totalPoints(): number {
    return Math.max(2, (this.clampGrid(this.cfg.cubeGrid) - 1) * this.clampDots(this.cfg.dotsPerFace) + 1);
  }

  private adoptShell() {
    this.px = Float32Array.from(this.shell.x);
    this.py = Float32Array.from(this.shell.y);
    this.pz = Float32Array.from(this.shell.z);
    this.depth = new Float32Array(this.shell.count);
    this.pxp = new Float32Array(this.shell.count);
    this.pyp = new Float32Array(this.shell.count);
    this.memberFlag = new Uint8Array(this.shell.count);
    this.turnMembers = new Int32Array(this.shell.count);
    this.turnControls?.stop();
    this.turnControls = null;
    this.turn = null;
    this.turnMemberCount = 0;
    this.turnProgress = 0;
  }

  /**
   * Pointer drag, bound to the canvas only — never `window` or `document`.
   * The pointer is captured on press so a drag that wanders off the card still
   * reports moves and releases; `touch-action` is left alone and nothing calls
   * `preventDefault`, so a swipe that starts here still scrolls the page (the
   * browser then sends `pointercancel` and the drag simply ends).
   */
  private bindEvents() {
    const onPointerDown = (e: PointerEvent) => {
      if (this.cfg.dragSensitivity <= 0) return;
      this.isDragging = true;
      this.activePointer = e.pointerId;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a convenience; a refusal just means moves stop at the edge.
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!this.isDragging || e.pointerId !== this.activePointer) return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      const sens = (this.cfg.dragSensitivity || 1) * 0.008;
      this.ay += dx * sens;
      this.ax += dy * sens;
    };

    const endDrag = (e: PointerEvent) => {
      if (e.pointerId !== this.activePointer) return;
      this.isDragging = false;
      this.activePointer = -1;
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    };

    this.canvas.addEventListener('pointerdown', onPointerDown);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);

    this.detachEvents = () => {
      this.canvas.removeEventListener('pointerdown', onPointerDown);
      this.canvas.removeEventListener('pointermove', onPointerMove);
      this.canvas.removeEventListener('pointerup', endDrag);
      this.canvas.removeEventListener('pointercancel', endDrag);
    };
  }

  start() {
    this.lastT = performance.now();
    const loop = () => {
      this.frameId = requestAnimationFrame(loop);
      this.step();
    };
    loop();
  }

  setSize(width: number, height: number) {
    if (this.disposed || width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
    // moves; the element keeps the size CSS gave it, and the context
    // transform below still maps CSS units into it — so every feature this
    // effect draws keeps the size the operator configured, at a lower
    // sampling density. See `render-scale.ts`.
    this.dpr = resolveBufferRatio(width, height, Math.min(window.devicePixelRatio || 1, 2));
    this.canvas.width = Math.max(1, Math.floor(width * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(height * this.dpr));
  }

  updateConfig(cfg: CubeConfig) {
    if (this.disposed) return;
    const newGrid = this.clampGrid(cfg.cubeGrid);
    const oldGrid = this.clampGrid(this.cfg.cubeGrid);
    const newDots = this.clampDots(cfg.dotsPerFace);
    const oldDots = this.clampDots(this.cfg.dotsPerFace);

    this.cfg = cfg;
    if (newGrid !== oldGrid || newDots !== oldDots) {
      this.shell = buildShell(newGrid, newDots);
      this.adoptShell();
    }
  }

  /** Choose the next quarter-turn, avoiding an immediate undo of the last one. */
  private pickMove() {
    const grid = this.clampGrid(this.cfg.cubeGrid);
    let m: Move;
    let tries = 0;
    do {
      m = {
        axis: Math.floor(Math.random() * 3),
        layer: Math.floor(Math.random() * grid),
        dir: Math.random() < 0.5 ? 1 : -1
      };
      tries++;
    } while (
      tries < 8 &&
      this.lastMove &&
      m.axis === this.lastMove.axis &&
      m.layer === this.lastMove.layer &&
      m.dir === -this.lastMove.dir
    );

    const axisArr = m.axis === 0 ? this.px : m.axis === 1 ? this.py : this.pz;
    this.memberFlag.fill(0);
    let memberCount = 0;
    for (let i = 0; i < this.shell.count; i++) {
      if (bandOf(axisArr[i], grid) === m.layer) {
        this.turnMembers[memberCount] = i;
        memberCount++;
        this.memberFlag[i] = 1;
      }
    }

    this.turn = m;
    this.turnMemberCount = memberCount;
    this.turnProgress = 0;
    this.turnTarget = (m.dir * Math.PI) / 2;
    this.lastMove = m;

    this.turnControls = animate(0, 1, {
      ...this.cfg.transition,
      onUpdate: (v: number) => {
        this.turnProgress = v;
      },
      onComplete: () => {
        this.commitTurn();
        this.turnControls = null;
      }
    });
  }

  /** Bake the finished turn back into the lattice, snapped to grid coordinates. */
  private commitTurn() {
    const m = this.turn;
    if (!m) return;
    const n = this.totalPoints();
    const c = Math.cos(this.turnTarget);
    const s = Math.sin(this.turnTarget);
    const out = this.tmp;
    for (let idx = 0; idx < this.turnMemberCount; idx++) {
      const i = this.turnMembers[idx];
      rotateAxis(this.px[i], this.py[i], this.pz[i], m.axis, c, s, out);
      this.px[i] = snapCoord(out.x, n);
      this.py[i] = snapCoord(out.y, n);
      this.pz[i] = snapCoord(out.z, n);
    }
    this.memberFlag.fill(0);
    this.turn = null;
    this.turnMemberCount = 0;
  }

  private step() {
    if (this.disposed) return;
    const now = performance.now();
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > 0.05) dt = 0.05;

    if (!this.isDragging) {
      const k = 0.06;
      this.ax += clampSpin(this.cfg.rotationX) * k * dt;
      this.ay += clampSpin(this.cfg.rotationY) * k * dt;
      this.az += clampSpin(this.cfg.rotationZ) * k * dt;
    }

    if (!this.turn && !this.turnControls) {
      this.pickMove();
    }

    this.render();
  }

  private render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const sizePct = Math.max(20, Math.min(200, Math.round(this.cfg.sizePercent)));
    const scale = Math.min(w, h) * 0.26 * (sizePct / 100);

    const cax = Math.cos(this.ax);
    const sax = Math.sin(this.ax);
    const cay = Math.cos(this.ay);
    const say = Math.sin(this.ay);
    const caz = Math.cos(this.az);
    const saz = Math.sin(this.az);

    const turn = this.turn;
    const angle = this.turnTarget * this.turnProgress;
    const cs = turn ? Math.cos(angle) : 1;
    const sn = turn ? Math.sin(angle) : 0;
    const turnAxis = turn ? turn.axis : 0;
    const memberFlag = this.memberFlag;

    const count = this.shell.count;
    const tmp = this.tmp;

    for (let i = 0; i < count; i++) {
      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];

      if (turn && memberFlag[i]) {
        rotateAxis(x, y, z, turnAxis, cs, sn, tmp);
        x = tmp.x;
        y = tmp.y;
        z = tmp.z;
      }

      const y1 = y * cax - z * sax;
      const z1 = y * sax + z * cax;
      const x2 = x * cay + z1 * say;
      const z2 = -x * say + z1 * cay;
      const x3 = x2 * caz - y1 * saz;
      const y3 = x2 * saz + y1 * caz;

      this.depth[i] = z2;
      const persp = 1 + z2 * 0.16;
      this.pxp[i] = cx + x3 * scale * persp;
      this.pyp[i] = cy - y3 * scale * persp;
    }

    // No depth sort. Every dot is composited with `lighter`, which is
    // Porter-Duff plus: the frame is the clamped sum of the dots, and addition
    // does not care what order it happens in. The old back-to-front
    // `order.sort()` with a JS comparator ran every frame over the whole shell
    // — ~2,400 dots at the slider maxima, so roughly 27,000 comparator calls
    // per frame — and could not affect a single pixel.
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = this.cfg.color || '#ffffff';
    const dot = Math.max(1, Math.min(6, Math.round(this.cfg.dotSize)));
    let lastAlpha = -1;

    for (let i = 0; i < count; i++) {
      const t = (this.depth[i] + HALF_DIAG) / (2 * HALF_DIAG);
      const tc = t < 0 ? 0 : t > 1 ? 1 : t;
      // The canvas composites alpha at 8 bits, so anything finer than 1/255 is
      // a state change the rasteriser cannot express. Skipping the write when
      // the quantised value repeats keeps consecutive dots batched.
      const alpha = Math.round((0.22 + 0.78 * tc) * 255) / 255;
      if (alpha !== lastAlpha) {
        ctx.globalAlpha = alpha;
        lastAlpha = alpha;
      }
      const r = Math.max(0.4, dot * (0.5 + 0.7 * tc));
      ctx.beginPath();
      ctx.arc(this.pxp[i], this.pyp[i], r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.turnControls?.stop();
    this.turnControls = null;
    this.detachEvents();
    this.px = new Float32Array(0);
    this.py = new Float32Array(0);
    this.pz = new Float32Array(0);
    this.depth = new Float32Array(0);
    this.pxp = new Float32Array(0);
    this.pyp = new Float32Array(0);
    this.memberFlag = new Uint8Array(0);
    this.turnMembers = new Int32Array(0);
    this.turnMemberCount = 0;
  }
}

export interface CubeProps {
  /** Colour of the particles making up the cube's shell. */
  color?: string;
  /** Layers per axis, like a Rubik's cube size. 2..8. */
  cubeGrid?: number;
  /** Particles packed between grid lines on each face. 1..8. */
  dotsPerFace?: number;
  /** Radius of each particle dot. 1..6. */
  dotSize?: number;
  /** Idle tumble speed around X, -12..12. */
  rotationX?: number;
  /** Idle tumble speed around Y, -12..12. */
  rotationY?: number;
  /** Idle tumble speed around Z, -12..12. */
  rotationZ?: number;
  /** Spring stiffness for each quarter-turn scramble. */
  springStiffness?: number;
  /** Spring damping for each quarter-turn scramble. */
  springDamping?: number;
  /** Spring mass for each quarter-turn scramble. */
  springMass?: number;
  /** Cube size within its container, as a percent. 20..200. */
  sizePercent?: number;
  /** Rotation per pixel of drag. 0 disables drag entirely. */
  dragSensitivity?: number;
}

export default function Cube({
  color = '#ffffff',
  cubeGrid = 3,
  dotsPerFace = 5,
  dotSize = 2,
  rotationX = 0,
  rotationY = 11,
  rotationZ = 0,
  springStiffness = 200,
  springDamping = 20,
  springMass = 1,
  sizePercent = 100,
  dragSensitivity = 1
}: CubeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<RubikCubeScene | null>(null);

  const cfg: CubeConfig = {
    color,
    cubeGrid,
    dotsPerFace,
    dotSize,
    rotationX,
    rotationY,
    rotationZ,
    transition: { type: 'spring', stiffness: springStiffness, damping: springDamping, mass: springMass },
    sizePercent,
    dragSensitivity
  };
  const cfgRef = useRef(cfg);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effects below.
  useEffect(() => {
    cfgRef.current = cfg;
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const scene = new RubikCubeScene(canvas, ctx, cfgRef.current);
    sceneRef.current = scene;

    const applySize = () => {
      const rect = container.getBoundingClientRect();
      scene.setSize(rect.width, rect.height);
    };
    applySize();
    const resizeObserver = new ResizeObserver(applySize);
    resizeObserver.observe(container);

    scene.start();

    return () => {
      resizeObserver.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.updateConfig(cfgRef.current);
  }, [
    color,
    cubeGrid,
    dotsPerFace,
    dotSize,
    rotationX,
    rotationY,
    rotationZ,
    springStiffness,
    springDamping,
    springMass,
    sizePercent,
    dragSensitivity
  ]);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

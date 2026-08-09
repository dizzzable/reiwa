import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import { resolveBufferRatio } from '../render-scale';

/**
 * Tornado — a particle vortex on a fixed camera.
 *
 * Ported from Originkit `tornado` (preset `base`). three.js: strands spiral up
 * a pinched hyperboloid, instanced dots ride them and flicker, and comets race
 * along them — a strike flashes a dot out and throws a ripple through the field.
 *
 * The source gated its whole loop on `prefers-reduced-motion` and froze on a
 * single held frame. That branch is gone: card artwork is gated centrally.
 */

/* ============================================================ constants */

const TAU = Math.PI * 2;

/** Panel radii read in screen pixels; the wire wants world units. */
const PX_PER_WORLD = 60;

const CURVE_SAMPLES = 1024;
const STRAND_SEGMENTS = 400;

/** Strand sway, as a share of the local radius. */
const WOBBLE = 0.008;
/** Share of a strand that fades at either end, so it dissolves rather than cuts. */
const FADE_ZONE = 0.15;

/** The form's height in world units. The camera is solved to frame exactly this. */
const FORM_HEIGHT = 10;

const BASE_ZOOM = 67;

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);

/** `zoom` reads as "higher is closer", which is the inverse of FOV. */
const fovForZoom = (zoom: number) => clamp(2 * BASE_ZOOM - zoom, 1, 175);

const LINE_GLOW_MAX = 1;
const DOT_GLOW_MAX = 4.2;
const COMET_SPEED_MAX = 0.15;
const COMET_GLOW_MAX = 1;
const DOT_SIZE_SCALE = 1000;

/** The ripple: a burst shoves nearby dots, each spring-returns to its home. */
const RIPPLE_RADIUS = 2;
const RIPPLE_STRENGTH = 0.5;
const RIPPLE_SPRING = 50;
const RIPPLE_DAMPING = 9;
const SCALE_SPRING = 65;
const SCALE_DAMPING = 11;
const SCALE_PEAK = 1.8;

/** The shockwave a burst throws. It moves the strands; dots have their springs. */
const WAVE_SPEED = 5;
const WAVE_WIDTH = 1.2;
const WAVE_DECAY = 0.8;
const WAVE_LIFE = 2.5;
const WAVE_STRENGTH = 0.04;
const MAX_WAVES = 16;

/** The stretch of a strand a comet runs, and its end fades. */
const RUN_LOW = 0.03;
const RUN_HIGH = 0.95;
const RUN_FADE = 0.1;

/** A comet hitting a dot. */
const HIT_RADIUS = 0.8;
const HIT_BOOST = 1.6;
const HIT_BOOST_TIME = 0.4;
const HIT_FLASH = 6;
const HIT_FADE = 0.6;
const HIT_POP = 1.3;
const HIT_RESPAWN = 8;

/** Strands are relaid at this rate, not every frame. */
const STRAND_HZ = 1 / 30;

/** The layers do not all arrive at once. Seconds from the first frame. */
const ENTRANCE = {
  strandStart: 0,
  strandEnd: 2,
  dotStart: 1.2,
  dotEnd: 3,
  cometStart: 3,
  cometEnd: 5
};

/** What repel strength 100 % comes to in NDC. */
const REPEL_MAX_NDC = 0.45;

/** Seconds after a real pointer leaves before the autopilot takes back over. */
const AUTOPILOT_BLEND = 1.5;

/**
 * Seconds of silence after which a pointer counts as gone even though no
 * `pointerleave` ever arrived. It does not always arrive — the webview takes
 * over a swipe, a sheet is dismissed mid-touch — and without this `since` stays
 * pinned at 0, `blend` at 0, and the repel field never leaves the last touched
 * point for the life of the mount.
 */
const POINTER_STALE_S = 3;

/* ============================================================ maths */

/** Ease used by the entrance fades — quick off the mark, long tail. */
function ramp(now: number, from: number, to: number) {
  if (now <= from) return 0;
  if (now >= to) return 1;
  const t = (now - from) / (to - from);
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

/**
 * Monotone cubic interpolation. Monotone specifically: the radius profile has a
 * hard pinch at the waist and a plain spline overshoots either side of it, which
 * would bulge the strands back out just before the neck and cross them.
 */
function monotone(points: [number, number][]) {
  const n = points.length;
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    slope[i] = (points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]);
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  m[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(slope[i]) < 1e-12) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m[i] = k * a * slope[i];
      m[i + 1] = k * b * slope[i];
    }
  }
  return (x: number) => {
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[n - 1][0]) return points[n - 1][1];
    let i = 0;
    while (i < n - 2 && points[i + 1][0] < x) i++;
    const h = points[i + 1][0] - points[i][0];
    const t = (x - points[i][0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * points[i][1] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * points[i + 1][1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

/** Bake a curve to a lookup table — it is read millions of times a second. */
function bake(fn: (x: number) => number) {
  const table = new Float32Array(CURVE_SAMPLES);
  for (let i = 0; i < CURVE_SAMPLES; i++) table[i] = fn(i / (CURVE_SAMPLES - 1));
  return table;
}

function sampleCurve(table: Float32Array, t: number) {
  if (t <= 0) return table[0];
  const last = table.length - 1;
  if (t >= 1) return table[last];
  const x = t * last;
  const i = x | 0;
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

/* ============================================================ config */

interface VortexConfig {
  floorRadius: number;
  waistRadius: number;
  crownRadius: number;
  waistAt: number;
  twist: number;
  zoom: number;
  flowDir: number;
  flowSpeed: number;
  lineCount: number;
  lineColor: string;
  lineGlow: number;
  showDots: boolean;
  dotCount: number;
  dotSize: number;
  dotColor: string;
  dotGlow: number;
  dotFlicker: number;
  showComets: boolean;
  cometCount: number;
  cometSpeed: number;
  cometColor: string;
  cometGlow: number;
  cometTail: number;
  cometDelay: number;
  collideForce: number;
  hoverRepel: boolean;
  repelRadius: number;
  repelStrength: number;
  autoplay: boolean;
}

/* ============================================================ shape */

type Shape = ReturnType<typeof makeShape>;

/** The vortex as three baked curves against distance along a strand. */
function makeShape(cfg: VortexConfig) {
  const w = clamp(cfg.waistAt, 0.08, 0.92);
  const floor = cfg.floorRadius;
  const crown = cfg.crownRadius;
  const turn = cfg.twist * TAU;

  const radius = bake(
    monotone([
      [0, floor],
      [0.24 * w, floor * 0.667],
      [0.5 * w, floor * 0.3],
      [0.76 * w, floor * 0.08],
      [w, cfg.waistRadius],
      [w + 0.3 * (1 - w), crown * 0.2],
      [w + 0.6 * (1 - w), crown * 0.44],
      [1, crown]
    ])
  );
  const height = bake(
    monotone([
      [0, 0],
      [0.1, 0.2],
      [0.2, 0.8],
      [0.35, 2],
      [0.5, FORM_HEIGHT * 0.38],
      [0.75, FORM_HEIGHT * 0.7],
      [1, FORM_HEIGHT]
    ])
  );
  const angle = bake(
    monotone([
      [0, 0],
      [0.15, 0.15 * turn],
      [0.25, 0.25 * turn],
      [0.45, 0.55 * turn],
      [0.6, 0.7 * turn],
      [0.8, 0.88 * turn],
      [1, turn]
    ])
  );

  return {
    /** Write one point of a strand into `out` at `at`. */
    writePoint(
      out: Float32Array,
      at: number,
      s: number,
      lane: number,
      flow: number,
      wobble: number,
      phase: number,
      time: number
    ) {
      const r = sampleCurve(radius, s);
      const y = sampleCurve(height, s);
      const a = sampleCurve(angle, s) + lane + flow;
      // The sway is a share of the local radius: a fixed one is nothing
      // against the floor plate and violent at the waist.
      const rr = r + Math.sin(s * 25 + phase + time * 0.3) * wobble * r;
      out[at] = Math.cos(a) * rr;
      out[at + 1] = y;
      out[at + 2] = Math.sin(a) * rr;
    },
    lane: (i: number, total: number) => (i / total) * TAU
  };
}

/* ============================================================ engine */

interface VortexApi {
  rebuild: () => void;
  dispose: () => void;
}

interface Strand {
  lane: number;
  speed: number;
  pulse: number;
  wobblePhase: number;
  from: number;
  to: number;
  bright: number;
  offset: number;
  pts: Float32Array;
  cols: Float32Array;
}

interface Dot {
  s: number;
  lane: number;
  strand: number;
  pulse: number;
  flickerRate: number;
  bright: number;
}

interface Comet {
  bright: number;
  lane: number;
  speed: number;
  pulse: number;
  wobblePhase: number;
  base: number;
  boost: number;
  boostMul: number;
  racing: boolean;
  s: number;
  idle: number;
  idleFor: number;
  trail: Float32Array;
  trailCol: Float32Array;
  geo: THREE.BufferGeometry;
  line: THREE.Line;
  head: THREE.Sprite;
}

interface Wave {
  active: boolean;
  x: number;
  y: number;
  z: number;
  at: number;
  amp: number;
}

/**
 * The engine holds the GL context for as long as the component is mounted and
 * reads settings from a ref rather than a snapshot. Anything deciding how many
 * things there are gets `rebuild()` — inside the context that is already open,
 * never by opening another one.
 */
function createVortex(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  cfgRef: { current: VortexConfig }
): VortexApi {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fovForZoom(cfgRef.current.zoom), 1, 0.1, 500);
  const group = new THREE.Group();
  scene.add(group);

  /* ---------------------------------------- repulsion uniforms */
  // One set shared by every material, so the pointer moves the whole form as
  // one field. Stock three materials, patched at compile time.
  const repelUniforms = {
    uMouse: { value: new THREE.Vector2(0, 0) },
    uAspect: { value: 1 },
    uRadius: { value: 0.2 },
    uStrength: { value: 0 }
  };
  const withRepel = <T extends THREE.Material>(material: T): T => {
    material.onBeforeCompile = shader => {
      shader.uniforms.uMouse = repelUniforms.uMouse;
      shader.uniforms.uAspect = repelUniforms.uAspect;
      shader.uniforms.uRadius = repelUniforms.uRadius;
      shader.uniforms.uStrength = repelUniforms.uStrength;
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          `
          uniform vec2 uMouse;
          uniform float uAspect;
          uniform float uRadius;
          uniform float uStrength;
          void main() {
          `
        )
        // The shove is in clip space, so it is a fixed number of screen
        // pixels whatever the depth and wherever the spin has carried it.
        .replace(
          '#include <fog_vertex>',
          `
          #include <fog_vertex>
          if (uStrength > 0.0 && uRadius > 0.0 && gl_Position.w > 0.0) {
            vec2 ndc = gl_Position.xy / gl_Position.w;
            vec2 off = ndc - uMouse;
            float dist = length(off * vec2(uAspect, 1.0));
            float f = uStrength * exp(-(dist * dist) / (2.0 * uRadius * uRadius));
            float m = length(off);
            if (m > 1e-4) {
              ndc += (off / m) * f;
              gl_Position.xy = ndc * gl_Position.w;
            }
          }
          `
        );
    };
    return material;
  };

  /* ---------------------------------------- per-build state */
  let shape: Shape = makeShape(cfgRef.current);
  let disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  let strands: Strand[] = [];
  let strandPos = new Float32Array(0);
  let strandCol = new Float32Array(0);
  let strandGeo: THREE.BufferGeometry | null = null;

  let dotList: Dot[] = [];
  let dotCount = 0;
  let dotMesh: THREE.InstancedMesh | null = null;
  let dotColors = new Float32Array(0);
  let dotHome = new Float32Array(0);
  let dotShift = new Float32Array(0);
  let dotVel = new Float32Array(0);
  let dotScale = new Float32Array(0);
  let dotScaleVel = new Float32Array(0);
  let dotHitAt = new Float32Array(0);
  let dotFlash = new Float32Array(0);
  let dotAlive = new Float32Array(0);
  let rippleAwake = false;

  let cometList: Comet[] = [];

  let waves: Wave[] = [];
  let wavesAwake = false;

  const dummy = new THREE.Matrix4();
  const tint = {
    strand: new THREE.Color(),
    dot: new THREE.Color(),
    comet: new THREE.Color()
  };
  let lastColors = { line: '', dot: '', comet: '' };

  /* ---------------------------------------- loop state */
  let frame = 0;
  let born = 0;
  let elapsed = 0;
  let flow = 0;
  let strandClock = 0;
  let tick = 0;
  let lastTime = performance.now();
  let viewHeight = 1;

  /** Re-tint from the config, but only when a colour string actually changed. */
  function syncColors(cfg: VortexConfig) {
    if (cfg.lineColor !== lastColors.line) {
      tint.strand.set(cfg.lineColor);
      lastColors.line = cfg.lineColor;
    }
    if (cfg.dotColor !== lastColors.dot) {
      tint.dot.set(cfg.dotColor);
      lastColors.dot = cfg.dotColor;
    }
    if (cfg.cometColor !== lastColors.comet) {
      tint.comet.set(cfg.cometColor);
      lastColors.comet = cfg.cometColor;
      for (const comet of cometList) {
        (comet.head.material as THREE.SpriteMaterial).color.setRGB(
          tint.comet.r * 1.2,
          tint.comet.g * 1.2,
          tint.comet.b * 1.2
        );
      }
    }
  }

  /** A soft round blob on a canvas, for the comet head sprites. */
  function blob(size: number, stops: [number, string][]) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx2d = c.getContext('2d');
    if (ctx2d) {
      const g = ctx2d.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (const [at, color] of stops) g.addColorStop(at, color);
      ctx2d.fillStyle = g;
      ctx2d.fillRect(0, 0, size, size);
    }
    const tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Drop everything the previous build allocated. Called before each rebuild
   * and on unmount — this is what keeps a remounting card from leaking
   * geometries, materials and textures into a context we still hold open.
   */
  function teardownBuild() {
    for (let i = group.children.length - 1; i >= 0; i--) {
      group.remove(group.children[i]);
    }
    if (dotMesh) {
      // Frees the instance matrix / colour buffers as well.
      dotMesh.dispose();
      dotMesh = null;
    }
    for (const d of disposables) d.dispose();
    disposables = [];
    strandGeo = null;
    cometList = [];
    strands = [];
    dotList = [];
  }

  /* ---------------------------------------- build */
  function build() {
    const cfg = cfgRef.current;

    teardownBuild();

    shape = makeShape(cfg);
    camera.fov = fovForZoom(cfg.zoom);
    camera.updateProjectionMatrix();

    syncColors(cfg);

    /* -------------------------------- strands */
    const count = Math.max(3, Math.round(cfg.lineCount));
    const segs = STRAND_SEGMENTS - 1;
    const verts = count * segs * 2;
    strandPos = new Float32Array(verts * 3);
    strandCol = new Float32Array(verts * 3);
    strandGeo = track(new THREE.BufferGeometry());
    strandGeo.setAttribute('position', new THREE.BufferAttribute(strandPos, 3).setUsage(THREE.DynamicDrawUsage));
    strandGeo.setAttribute('color', new THREE.BufferAttribute(strandCol, 3).setUsage(THREE.DynamicDrawUsage));
    const strandMat = track(
      withRepel(
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      )
    );
    const strandLines = new THREE.LineSegments(strandGeo, strandMat);
    strandLines.frustumCulled = false;
    group.add(strandLines);

    strands = [];
    for (let i = 0; i < count; i++) {
      strands.push({
        lane: shape.lane(i, count),
        speed: 0.95 + Math.random() * 0.1,
        pulse: Math.random() * TAU,
        wobblePhase: Math.random() * TAU,
        from: 0,
        to: 1,
        bright: 0.5,
        offset: i * segs * 2 * 3,
        pts: new Float32Array(STRAND_SEGMENTS * 3),
        cols: new Float32Array(STRAND_SEGMENTS * 3)
      });
    }

    /* -------------------------------- dots */
    dotCount = cfg.showDots ? Math.max(0, Math.round(cfg.dotCount)) : 0;
    dotList = [];
    for (let i = 0; i < dotCount; i++) {
      // Half crowd the middle of a strand, the rest spread over nearly all of it.
      const s = Math.random() < 0.5 ? 0.2 + Math.random() * 0.4 : 0.05 + Math.random() * 0.9;
      const strand = Math.floor(Math.random() * strands.length);
      dotList.push({
        s,
        lane: strands[strand].lane,
        strand,
        pulse: Math.random() * TAU,
        flickerRate: 0.15 + Math.random() * 4.5,
        bright: 0.04 + Math.random() ** 1.5 * 0.96
      });
    }

    dotHome = new Float32Array(dotCount * 3);
    dotShift = new Float32Array(dotCount * 3);
    dotVel = new Float32Array(dotCount * 3);
    dotScale = new Float32Array(dotCount).fill(1);
    dotScaleVel = new Float32Array(dotCount);
    dotHitAt = new Float32Array(dotCount);
    dotFlash = new Float32Array(dotCount);
    dotAlive = new Float32Array(dotCount).fill(1);
    dotColors = new Float32Array(dotCount * 3);
    rippleAwake = false;

    if (dotCount > 0) {
      const dotGeo = track(new THREE.PlaneGeometry(1, 1));
      const dotMat = track(
        withRepel(
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false
          })
        )
      );
      dotMesh = new THREE.InstancedMesh(dotGeo, dotMat, dotCount);
      dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      dotMesh.instanceColor = new THREE.InstancedBufferAttribute(dotColors, 3);
      dotMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      dotMesh.frustumCulled = false;
      group.add(dotMesh);
    }

    /* -------------------------------- waves */
    waves = [];
    for (let i = 0; i < MAX_WAVES; i++) {
      waves.push({ active: false, x: 0, y: 0, z: 0, at: 0, amp: 1 });
    }
    wavesAwake = false;

    /* -------------------------------- comets */
    const cometTotal = cfg.showComets ? Math.max(0, Math.round(cfg.cometCount)) : 0;
    cometList = [];
    if (cometTotal > 0) {
      const cometTex = track(
        blob(32, [
          [0, 'rgba(255,255,255,0.9)'],
          [0.3, 'rgba(255,120,255,0.4)'],
          [0.7, 'rgba(200,50,200,0.08)'],
          [1, 'rgba(0,0,0,0)']
        ])
      );
      const tailLen = Math.max(2, Math.round(cfg.cometTail));
      for (let i = 0; i < cometTotal; i++) {
        const trail = new Float32Array(tailLen * 3);
        const trailCol = new Float32Array(tailLen * 3);
        const geo = track(new THREE.BufferGeometry());
        geo.setAttribute('position', new THREE.BufferAttribute(trail, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3).setUsage(THREE.DynamicDrawUsage));
        const lineMat = track(
          withRepel(
            new THREE.LineBasicMaterial({
              vertexColors: true,
              transparent: true,
              opacity: 0.9,
              blending: THREE.AdditiveBlending,
              depthWrite: false
            })
          )
        );
        const line = new THREE.Line(geo, lineMat);
        line.frustumCulled = false;

        const headMat = track(
          new THREE.SpriteMaterial({
            map: cometTex,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            color: new THREE.Color(tint.comet.r * 1.2, tint.comet.g * 1.2, tint.comet.b * 1.2)
          })
        );
        const head = new THREE.Sprite(headMat);
        head.scale.set(0.35, 0.35, 1);

        group.add(line);
        group.add(head);

        const home = strands[Math.floor(Math.random() * strands.length)];
        const speed = cfg.cometSpeed * (0.7 + Math.random() * 0.6);
        cometList.push({
          bright: 0.7 + Math.random() * 0.3,
          lane: home.lane,
          speed,
          pulse: home.speed,
          wobblePhase: home.wobblePhase,
          base: speed,
          boost: 0,
          boostMul: 1,
          racing: false,
          s: 0,
          idle: 0,
          // Spread across one delay, so the first flight reads like every one after.
          idleFor: 0.4 + (i / cometTotal) * cfg.cometDelay,
          trail,
          trailCol,
          geo,
          line,
          head
        });
      }
    }

    born = 0;
    resize();
  }

  /* ---------------------------------------- camera */
  const distance = FORM_HEIGHT / 2 / Math.tan((BASE_ZOOM * Math.PI) / 180 / 2);
  const viewDir = new THREE.Vector3(3.4, -0.6, 10).normalize();
  const lookTarget = new THREE.Vector3(0, FORM_HEIGHT / 2, 0);
  camera.position.copy(lookTarget).addScaledVector(viewDir, distance);
  camera.lookAt(lookTarget);

  /* ---------------------------------------- resize */
  function resize() {
    const cfg = cfgRef.current;
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    viewHeight = h;
    // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
    // moves; the element keeps the size CSS gave it, and the context
    // transform below still maps CSS units into it — so every feature this
    // effect draws keeps the size the operator configured, at a lower
    // sampling density. See `render-scale.ts`.
    // three.js `setPixelRatio` multiplies the buffer only, and `setSize(w, h,
    // false)` is already told not to write the canvas style at all.
    renderer.setPixelRatio(resolveBufferRatio(w, h, Math.min(window.devicePixelRatio || 1, 2)));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    repelUniforms.uAspect.value = w / h;
    repelUniforms.uRadius.value = clamp(cfg.repelRadius / (h / 2), 0.01, 3);
  }
  const observer = new ResizeObserver(resize);

  /* ---------------------------------------- pointer */
  // Container-scoped, never `document`. No preventDefault, no passive:false —
  // `pointermove` on a card must not interfere with scrolling it.
  const pointerNdc = new THREE.Vector2(0, 0);
  let pointerInside = false;
  let pointerAt = -1e9;
  const onPointerMove = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    );
    pointerInside = true;
    pointerAt = elapsed;
  };
  const onPointerLeave = () => {
    pointerInside = false;
  };
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerleave', onPointerLeave);
  container.addEventListener('pointercancel', onPointerLeave);

  /* ---------------------------------------- ripple */

  /** A shockwave, thrown from a dot that has just been hit. */
  function addWave(x: number, y: number, z: number, at: number, amp: number) {
    wavesAwake = true;
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < MAX_WAVES; i++) {
      if (!waves[i].active) {
        slot = i;
        break;
      }
      if (waves[i].at < oldest) {
        oldest = waves[i].at;
        slot = i;
      }
    }
    waves[slot] = { active: true, x, y, z, at, amp };
  }

  /** The ring's push on one strand vertex, added in place. */
  function waveAt(x: number, y: number, z: number, now: number, out: Float32Array, at: number, radius: number) {
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let any = false;
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = waves[i];
      if (!w.active) continue;
      const age = now - w.at;
      if (age > WAVE_LIFE) {
        w.active = false;
        continue;
      }
      any = true;
      const dx = x - w.x;
      const dy = y - w.y;
      const dz = z - w.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 0.001 || d > radius * 1.5) continue;
      // Only the shell of the ring moves anything.
      const front = Math.abs(d - WAVE_SPEED * age);
      if (front > WAVE_WIDTH) continue;
      const shell = Math.cos(((front / WAVE_WIDTH) * Math.PI) / 2);
      const fade = Math.exp(-age / WAVE_DECAY);
      const near = 1 / Math.max(d, 0.3);
      const push = RIPPLE_STRENGTH * w.amp * WAVE_STRENGTH * shell * fade * near;
      ox += (dx / d) * push;
      oy += (dy / d) * push;
      oz += (dz / d) * push;
    }
    if (!any) wavesAwake = false;
    out[at] += ox;
    out[at + 1] += oy;
    out[at + 2] += oz;
  }

  /** Shove every dot around one that has gone off, and swell it. */
  function burstAt(i: number, now: number, force: number) {
    rippleAwake = true;
    const x = dotHome[i * 3];
    const y = dotHome[i * 3 + 1];
    const z = dotHome[i * 3 + 2];
    addWave(x, y, z, now, force);
    const radius = RIPPLE_RADIUS;
    const maxSq = radius * radius;
    for (let j = 0; j < dotCount; j++) {
      const dx = dotHome[j * 3] - x;
      const dy = dotHome[j * 3 + 1] - y;
      const dz = dotHome[j * 3 + 2] - z;
      const sq = dx * dx + dy * dy + dz * dz;
      if (sq > maxSq || sq < 1e-4) continue;
      const d = Math.sqrt(sq);
      const f = 1 - d / radius;
      const push = (RIPPLE_STRENGTH * force * f * f) / Math.max(d, 0.1);
      dotVel[j * 3] += dx * push;
      dotVel[j * 3 + 1] += dy * push;
      dotVel[j * 3 + 2] += dz * push;
      const swell = 1 + (SCALE_PEAK - 1) * force * f * f;
      if (swell > dotScale[j]) {
        dotScale[j] = swell;
        dotScaleVel[j] = 0;
      }
    }
  }

  /** Every dot on its own spring, back toward where the flow put it. */
  function settle(dt: number) {
    let moving = false;
    for (let i = 0; i < dotCount; i++) {
      const at = i * 3;
      for (let k = 0; k < 3; k++) {
        const a = -RIPPLE_SPRING * dotShift[at + k] - RIPPLE_DAMPING * dotVel[at + k];
        dotVel[at + k] += a * dt;
        dotShift[at + k] += dotVel[at + k] * dt;
      }
      const restSq = dotShift[at] ** 2 + dotShift[at + 1] ** 2 + dotShift[at + 2] ** 2;
      const velSq = dotVel[at] ** 2 + dotVel[at + 1] ** 2 + dotVel[at + 2] ** 2;
      if (restSq < 1e-8 && velSq < 1e-8) {
        dotShift[at] = dotShift[at + 1] = dotShift[at + 2] = 0;
        dotVel[at] = dotVel[at + 1] = dotVel[at + 2] = 0;
      } else {
        moving = true;
      }
      const sa = -SCALE_SPRING * (dotScale[i] - 1) - SCALE_DAMPING * dotScaleVel[i];
      dotScaleVel[i] += sa * dt;
      dotScale[i] += dotScaleVel[i] * dt;
      if (Math.abs(dotScale[i] - 1) < 0.001 && Math.abs(dotScaleVel[i]) < 0.001) {
        dotScale[i] = 1;
        dotScaleVel[i] = 0;
      } else {
        moving = true;
      }
    }
    if (!moving) rippleAwake = false;
  }

  /* ---------------------------------------- loop */

  function drawStrand(strand: Strand, now: number, entrance: number) {
    const cfg = cfgRef.current;
    const spin = flow * strand.speed;
    const bright = strand.bright * cfg.lineGlow;
    const lift = 0.15 + bright * 1.5;
    const alpha =
      Math.min(bright * 0.5 * (0.9 + 0.1 * Math.sin(now * 0.18 + strand.pulse)), 0.7) * Math.min(entrance * 3, 1);
    const reach = strand.from + entrance * (strand.to - strand.from);
    const tipFade = 0.15 * (strand.to - strand.from);
    const { pts, cols } = strand;

    for (let i = 0; i < STRAND_SEGMENTS; i++) {
      const u = i / (STRAND_SEGMENTS - 1);
      const s = strand.from + u * (strand.to - strand.from);
      const at = i * 3;
      shape.writePoint(pts, at, s, strand.lane, spin, WOBBLE, strand.wobblePhase, now);
      if (wavesAwake) {
        waveAt(pts[at], pts[at + 1], pts[at + 2], now, pts, at, RIPPLE_RADIUS);
      }
      let edge = 1;
      if (u < FADE_ZONE) {
        const k = u / FADE_ZONE;
        edge = k * k;
      } else if (u > 1 - FADE_ZONE) {
        const k = (1 - u) / FADE_ZONE;
        edge = k * k;
      }
      let tip = 1;
      if (s > reach) tip = 0;
      else if (s > reach - tipFade) {
        tip = (reach - s) / tipFade;
        tip *= tip;
      }
      const v = edge * lift * tip * alpha;
      cols[at] = tint.strand.r * v;
      cols[at + 1] = tint.strand.g * v;
      cols[at + 2] = tint.strand.b * v;
    }

    // One point per segment becomes two vertices: a line list, so a strand can
    // go dark in the middle without the whole thing going.
    let w = strand.offset;
    for (let i = 0; i < STRAND_SEGMENTS - 1; i++) {
      const a = i * 3;
      const b = (i + 1) * 3;
      strandPos[w] = pts[a];
      strandPos[w + 1] = pts[a + 1];
      strandPos[w + 2] = pts[a + 2];
      strandCol[w] = cols[a];
      strandCol[w + 1] = cols[a + 1];
      strandCol[w + 2] = cols[a + 2];
      w += 3;
      strandPos[w] = pts[b];
      strandPos[w + 1] = pts[b + 1];
      strandPos[w + 2] = pts[b + 2];
      strandCol[w] = cols[b];
      strandCol[w + 1] = cols[b + 1];
      strandCol[w + 2] = cols[b + 2];
      w += 3;
    }
  }

  function driveComet(comet: Comet, now: number, dt: number, entrance: number) {
    const cfg = cfgRef.current;
    const tailLen = comet.trail.length / 3;

    if (!comet.racing) {
      (comet.head.material as THREE.SpriteMaterial).opacity = 0;
      if (entrance < 0.3) return;
      comet.idle += dt;
      if (comet.idle > comet.idleFor) {
        comet.racing = true;
        // Turning left, a comet sets off at the crown and runs down.
        comet.s = cfg.flowDir < 0 ? RUN_HIGH : RUN_LOW;
        comet.base = cfg.cometSpeed * (0.7 + Math.random() * 0.6);
        comet.speed = comet.base;
        comet.boost = 0;
        comet.boostMul = 1;
        const home = strands[Math.floor(Math.random() * strands.length)];
        comet.lane = home.lane;
        comet.pulse = home.speed;
        comet.wobblePhase = home.wobblePhase;
      }
      return;
    }

    if (comet.boost > 0) {
      comet.boost -= dt;
      if (comet.boost <= 0) {
        comet.boost = 0;
        comet.boostMul = 1;
      } else {
        comet.boostMul = 1 + (HIT_BOOST - 1) * (comet.boost / HIT_BOOST_TIME);
      }
      comet.speed = comet.base * comet.boostMul;
    }

    comet.s += dt * comet.speed * cfg.flowDir;
    // Which end is the far one depends on the way it set off.
    if (cfg.flowDir < 0 ? comet.s < RUN_LOW : comet.s > RUN_HIGH) {
      comet.racing = false;
      comet.idle = 0;
      comet.idleFor = cfg.cometDelay * (0.6 + Math.random() * 0.8);
      comet.trailCol.fill(0);
      (comet.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      (comet.head.material as THREE.SpriteMaterial).opacity = 0;
      return;
    }

    const spin = flow * comet.pulse;
    const ends = clamp((comet.s - RUN_LOW) / RUN_FADE, 0, 1) * clamp((RUN_HIGH - comet.s) / RUN_FADE, 0, 1);

    for (let i = 0; i < tailLen; i++) {
      const s = clamp(comet.s - i * 0.005 * cfg.flowDir, 0.005, 0.995);
      const at = i * 3;
      shape.writePoint(comet.trail, at, s, comet.lane, spin, WOBBLE, comet.wobblePhase, now);
      const along = (1 - i / tailLen) ** 2;
      const v = comet.bright * cfg.cometGlow * along * ends;
      // The first few segments run hotter, which is what gives the head a core.
      const hot = entrance * (i < 3 ? 1.3 : 1);
      comet.trailCol[at] = tint.comet.r * v * hot;
      comet.trailCol[at + 1] = tint.comet.g * v * hot;
      comet.trailCol[at + 2] = tint.comet.b * v * hot;
    }

    comet.head.position.set(comet.trail[0], comet.trail[1], comet.trail[2]);
    const swell = comet.boost > 0 ? 1 + (comet.boostMul - 1) * 0.8 : 1;
    (comet.head.material as THREE.SpriteMaterial).opacity = ends * 0.35 * entrance * swell;
    comet.head.scale.set(0.35 * swell, 0.35 * swell, 1);
    (comet.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (comet.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Comets running over dots: close enough is a hit. */
  function collide(now: number) {
    const cfg = cfgRef.current;
    const force = cfg.collideForce;
    if (force <= 0) return;
    const hitSq = HIT_RADIUS * HIT_RADIUS;
    for (const comet of cometList) {
      if (!comet.racing) continue;
      const x = comet.trail[0];
      const y = comet.trail[1];
      const z = comet.trail[2];
      if (x === 0 && y === 0 && z === 0) continue;
      // Every third dot: the dots are a cloud, not a wall.
      for (let i = 0; i < dotCount; i += 3) {
        const dx = dotHome[i * 3] - x;
        const dy = dotHome[i * 3 + 1] - y;
        const dz = dotHome[i * 3 + 2] - z;
        const sq = dx * dx + dy * dy + dz * dz;
        if (sq < hitSq && dotHitAt[i] === 0) {
          dotHitAt[i] = 0.001;
          dotFlash[i] = HIT_FLASH * force;
          dotScale[i] = 1 + (HIT_POP - 1) * force;
          burstAt(i, now, force);
          comet.boost = HIT_BOOST_TIME;
          comet.boostMul = 1 + (HIT_BOOST - 1) * force;
          comet.speed = comet.base * comet.boostMul;
        }
      }
    }
  }

  /**
   * Where the repulsion field sits this frame.
   *
   * On a phone there is no pointer, so with `repel` on the field would never
   * move. The autopilot walks it along two sine pairs of incommensurable
   * periods, and hands back to a real pointer the moment one appears.
   */
  function driveRepel(cfg: VortexConfig, t: number) {
    const strength = clamp(cfg.repelStrength / 100, 0, 1) * REPEL_MAX_NDC;
    if (!cfg.hoverRepel) return 0;
    if (!cfg.autoplay) {
      repelUniforms.uMouse.value.copy(pointerNdc);
      return pointerInside ? strength : 0;
    }
    const since = pointerInside ? 0 : elapsed - pointerAt;
    const blend = clamp((since - 0.4) / AUTOPILOT_BLEND, 0, 1);
    const sx = 0.62 * Math.sin(t * 0.31) + 0.28 * Math.sin(t * 0.73 + 1.1);
    const sy = 0.55 * Math.sin(t * 0.41 + 2.3) + 0.24 * Math.sin(t * 0.19);
    repelUniforms.uMouse.value.set(
      pointerNdc.x + (sx - pointerNdc.x) * blend,
      pointerNdc.y + (sy - pointerNdc.y) * blend
    );
    return strength;
  }

  function step(now: number) {
    frame = requestAnimationFrame(step);
    const cfg = cfgRef.current;
    const dt = Math.min((now - lastTime) / 1000, 0.04);
    lastTime = now;

    // The clock starts on the first drawn frame, not when the engine was built.
    if (born === 0) born = now;
    elapsed = (now - born) / 1000;
    const t = elapsed;

    // A pointer that stopped reporting without ever leaving is treated as gone,
    // so the repel field always drifts back onto the autopilot path. Cleared
    // here rather than inside `driveRepel`, which returns early on two paths
    // that would otherwise never reach it.
    //
    // The stamp is re-based, not merely read: `driveRepel` measures its own
    // hand-back from this same `pointerAt`, and a stamp that is already
    // `POINTER_STALE_S` old makes `blend` 1 on the very frame the latch
    // releases. The field then jumped to wherever the sine path had wandered
    // in one frame — the ease this timeout exists to reach was skipped by the
    // timeout itself. A real `pointerleave` needs no re-base: its stamp is from
    // the last move, a frame or two ago, so the ramp starts at 0 on its own.
    // `ReactiveGrid` re-bases at the same point for the same reason.
    if (pointerInside && elapsed - pointerAt > POINTER_STALE_S) {
      pointerInside = false;
      pointerAt = elapsed;
    }

    const fadeStrand = ramp(t, ENTRANCE.strandStart, ENTRANCE.strandEnd);
    const fadeDot = ramp(t, ENTRANCE.dotStart, ENTRANCE.dotEnd);
    const fadeComet = ramp(t, ENTRANCE.cometStart, ENTRANCE.cometEnd);

    // Zoom, colours and repel reach are read here rather than baked at build
    // time, so dragging any of them does not restart the entrance.
    syncColors(cfg);
    const fov = fovForZoom(cfg.zoom);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    repelUniforms.uRadius.value = clamp(cfg.repelRadius / (viewHeight / 2), 0.01, 3);

    // The flow accumulates rather than being solved from elapsed time: `t *
    // speed` re-reads the whole history at the new rate, so nudging speed
    // would snap the form to wherever it would have been all along.
    flow += dt * cfg.flowSpeed;
    const repelTarget = driveRepel(cfg, t);
    const us = repelUniforms.uStrength;
    us.value += (repelTarget - us.value) * Math.min(1, dt * 12);

    /* strands, at their own rate */
    strandClock += dt;
    if (strandClock >= STRAND_HZ && strandGeo) {
      strandClock -= STRAND_HZ;
      for (const strand of strands) drawStrand(strand, t, fadeStrand);
      (strandGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (strandGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }

    if (rippleAwake) settle(dt);

    /* dots */
    if (dotMesh && dotCount > 0) {
      const size = cfg.dotSize;
      for (let i = 0; i < dotCount; i++) {
        const dot = dotList[i];
        const strand = strands[dot.strand] ?? strands[0];
        const spin = flow * strand.speed;
        const at = i * 3;
        shape.writePoint(dotHome, at, dot.s, dot.lane, spin, WOBBLE, strand.wobblePhase, t);

        // A dot a comet has run through: flashes, shrinks out, and is gone
        // until its respawn comes round.
        if (dotHitAt[i] > 0) {
          dotHitAt[i] += dt;
          const age = dotHitAt[i];
          if (age < HIT_FADE) {
            const k = age / HIT_FADE;
            dotAlive[i] = (1 + (HIT_POP - 1) * (1 - k)) * (1 - k * k);
            dotFlash[i] = HIT_FLASH * (1 - k * k) * (1 - k * k);
          } else {
            dotAlive[i] = 0;
            dotFlash[i] = 0;
          }
          if (age > HIT_RESPAWN) {
            dotHitAt[i] = 0;
            dotAlive[i] = 1;
            dotFlash[i] = 0;
          }
        }

        const alive = dotAlive[i];
        const scale = size * dotScale[i] * alive;
        dummy.makeScale(scale, scale, scale);
        dummy.setPosition(
          dotHome[at] + dotShift[at],
          dotHome[at + 1] + dotShift[at + 1],
          dotHome[at + 2] + dotShift[at + 2]
        );
        dotMesh.setMatrixAt(i, dummy);

        // A sine raised to a power spends most of its time near nothing and
        // spikes briefly, which reads as a twinkle rather than a throb.
        const beat =
          1 -
          cfg.dotFlicker +
          cfg.dotFlicker * (0.08 + 0.92 * Math.max(0, Math.sin(t * dot.flickerRate + dot.pulse)) ** 2.5);
        const swollen = dotScale[i] > 1.02 ? 1 + (dotScale[i] - 1) * 0.5 : 1;
        const v = dot.bright * beat * cfg.dotGlow * swollen * fadeDot * (1 + dotFlash[i]) * alive;
        dotColors[at] = tint.dot.r * v;
        dotColors[at + 1] = tint.dot.g * v;
        dotColors[at + 2] = tint.dot.b * v;
      }
      dotMesh.instanceMatrix.needsUpdate = true;
      if (dotMesh.instanceColor) dotMesh.instanceColor.needsUpdate = true;
      (dotMesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * fadeDot;
    }

    /* comets */
    for (const comet of cometList) driveComet(comet, t, dt, fadeComet);
    tick++;
    // Every other frame: in one they do not move far enough to slip past a dot.
    if (tick % 2 === 0 && dotCount > 0) collide(t);

    renderer.render(scene, camera);
  }

  /* ---------------------------------------- boot */
  build();
  observer.observe(container);
  lastTime = performance.now();
  frame = requestAnimationFrame(step);

  return {
    rebuild() {
      build();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('pointercancel', onPointerLeave);
      teardownBuild();
      scene.remove(group);
      scene.clear();
      strandPos = new Float32Array(0);
      strandCol = new Float32Array(0);
      dotHome = new Float32Array(0);
      dotShift = new Float32Array(0);
      dotVel = new Float32Array(0);
      dotScale = new Float32Array(0);
      dotScaleVel = new Float32Array(0);
      dotHitAt = new Float32Array(0);
      dotFlash = new Float32Array(0);
      dotAlive = new Float32Array(0);
      dotColors = new Float32Array(0);
      renderer.dispose();
      // Free the GL context at once; browsers cap how many can be open.
      renderer.forceContextLoss();
    }
  };
}

/* ============================================================ component */

export interface TornadoProps {
  /** Solid backdrop behind the vortex. */
  background?: string;
  /** How wide the crown flares at the top, screen px. */
  topRadius?: number;
  /** How tightly the form pinches at its narrowest point, screen px. */
  waistRadius?: number;
  /** Where the pinch sits, 0..100 measured down from the crown. */
  waistPosition?: number;
  /** How wide the base spreads, screen px. */
  bottomRadius?: number;
  /** How many times the strands spiral around the form. */
  twist?: number;
  /** Camera zoom. Higher is closer. */
  zoom?: number;
  /** How fast the whole form spins and flows. */
  speed?: number;
  /** Flips the spin and flow. */
  direction?: 'right' | 'left';
  /** Strand count. Lowered from the source's 240 for a card-sized surface. */
  lineCount?: number;
  /** Strand colour. */
  lineColor?: string;
  /** Strand glow, 0..10. */
  lineGlow?: number;
  /** Draws the twinkling dot particles. */
  dots?: boolean;
  /** Dot count. Lowered from the source's 8000 for a card-sized surface. */
  dotCount?: number;
  /** Dot size, 0..100. */
  dotSize?: number;
  /** Dot colour. */
  dotColor?: string;
  /** Dot glow, 0..10. */
  dotGlow?: number;
  /** How hard the dots twinkle, 0..10. */
  dotFlicker?: number;
  /** Draws the racing comet streaks. */
  comets?: boolean;
  /** Comet count. */
  cometCount?: number;
  /** Comet speed, 0..10. */
  cometSpeed?: number;
  /** Comet colour. */
  cometColor?: string;
  /** Comet glow, 0..10. */
  cometGlow?: number;
  /** Comet tail length, in segments. */
  cometTail?: number;
  /** Seconds between comet flights. */
  cometDelay?: number;
  /** How hard a comet strike hits a dot, 0..10. 0 passes straight through. */
  cometCollide?: number;
  /** Cursor-driven repulsion of the vortex. */
  repel?: boolean;
  /** Reach of that repulsion, screen px. */
  repelRadius?: number;
  /** Strength of that repulsion, 0..100. */
  repelStrength?: number;
  /** Drives `repel` from a synthetic path when no real pointer is present. */
  autoplay?: boolean;
}

export default function Tornado({
  background = '#000000',
  topRadius = 380,
  waistRadius = 53,
  waistPosition = 50,
  bottomRadius = 1150,
  twist = 3,
  zoom = 75,
  speed = 10,
  direction = 'right',
  lineCount = 120,
  lineColor = '#ffffff',
  lineGlow = 10,
  dots = true,
  dotCount = 2000,
  dotSize = 20,
  dotColor = '#ffffff',
  dotGlow = 10,
  dotFlicker = 10,
  comets = true,
  cometCount = 10,
  cometSpeed = 6,
  cometColor = '#F9731A',
  cometGlow = 6,
  cometTail = 19,
  cometDelay = 8,
  cometCollide = 6,
  repel = false,
  repelRadius = 60,
  repelStrength = 10,
  autoplay = true
}: TornadoProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Prop units in, engine units out — the one place the two meet.
  const config: VortexConfig = {
    floorRadius: bottomRadius / PX_PER_WORLD,
    waistRadius: waistRadius / PX_PER_WORLD,
    crownRadius: topRadius / PX_PER_WORLD,
    // The prop measures down from the crown; the shape measures up from the
    // floor, so the number is flipped here.
    waistAt: 1 - waistPosition / 100,
    twist,
    zoom,
    flowDir: direction === 'left' ? -1 : 1,
    flowSpeed: (speed / 100) * (direction === 'left' ? -1 : 1),
    lineCount,
    lineColor,
    lineGlow: (lineGlow / 10) * LINE_GLOW_MAX,
    showDots: dots,
    dotCount,
    dotSize: dotSize / DOT_SIZE_SCALE,
    dotColor,
    dotGlow: (dotGlow / 10) * DOT_GLOW_MAX,
    dotFlicker: dotFlicker / 10,
    showComets: comets,
    cometCount,
    cometSpeed: (cometSpeed / 10) * COMET_SPEED_MAX,
    cometColor,
    cometGlow: (cometGlow / 10) * COMET_GLOW_MAX,
    cometTail,
    cometDelay,
    collideForce: cometCollide / 10,
    hoverRepel: repel,
    repelRadius,
    repelStrength,
    autoplay
  };

  // Only the values deciding how many things there are, or the shape they sit
  // on, are in the key: a rebuild relays every buffer and restarts the
  // entrance, which for a colour is both waste and a visible stutter.
  const buildKey = JSON.stringify([
    config.floorRadius,
    config.waistRadius,
    config.crownRadius,
    config.waistAt,
    config.twist,
    config.lineCount,
    config.showDots,
    config.dotCount,
    config.showComets,
    config.cometCount,
    config.cometTail
  ]);

  const configRef = useRef(config);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effects below.
  useEffect(() => {
    configRef.current = config;
  });

  const apiRef = useRef<VortexApi | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    try {
      apiRef.current = createVortex(canvas, container, configRef);
    } catch {
      // WebGL can be unavailable (blocked, out of contexts, software render).
      // Fail to a transparent canvas rather than taking the card down.
      return;
    }
    return () => {
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, []);

  // The first run is skipped: the effect above has just built the scene from
  // this very config, and rebuilding before a frame is drawn restarts the
  // entrance for nothing.
  const built = useRef(false);
  useEffect(() => {
    if (!built.current) {
      built.current = true;
      return;
    }
    apiRef.current?.rebuild();
  }, [buildKey]);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" style={{ background }}>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Mesh, Plane, Program, RenderTarget, Renderer, Texture } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

import { resolveBufferRatio } from '../render-scale';

const DEFAULT_GLYPH_PADDING_PX = 2;
const DEFAULT_CHARACTERS = '●○•·';
const FRAME_INTERVAL = 1e3 / 30;

const perlinVertexShader = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0., 1.);
}`;

const perlinFragmentShader = `#version 300 es
precision mediump float;
uniform float uFrequency;
uniform float uTime;
uniform float uSpeed;
uniform float uValue;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_ );
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;
  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv = (uv - 0.5) * vec2(aspect, 1.0) + 0.5;
  float hue = abs(snoise(vec3(uv * uFrequency, uTime * uSpeed)));
  vec3 rainbowColor = hsv2rgb(vec3(hue, 1.0, uValue));
  fragColor = vec4(rainbowColor, 1.0);
}`;

const dotVertexShader = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0., 1.);
}`;

const dotFragmentShader = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uTexture;
uniform int uPaletteCount;
uniform vec3 uPalette[10];
uniform float uPaletteA[10];
uniform float uCellSize;
uniform float uGamma;
uniform float uPaletteBias;
uniform int uUseGlyphAtlas;
uniform sampler2D uGlyphAtlas;
uniform ivec2 uGlyphGrid;
uniform int uCharCount;
out vec4 fragColor;

void main() {
  vec2 pix = gl_FragCoord.xy;
  float cell = max(uCellSize, 1.0);

  vec2 cellIdx = floor(pix / cell);
  vec2 cellCenter = (cellIdx + 0.5) * cell;
  vec3 col = texture(uTexture, cellCenter / uResolution.xy).rgb;
  float gray = 0.3 * col.r + 0.59 * col.g + 0.11 * col.b;
  gray = pow(clamp(gray, 0.0001, 1.0), uGamma);

  float mark = 0.0;
  if (uUseGlyphAtlas == 1 && uCharCount > 0 && uGlyphGrid.x > 0 && uGlyphGrid.y > 0) {
    float g = clamp(gray + uPaletteBias, 0.0, 1.0);
    int idx = int(clamp(floor(g * float(uCharCount - 1) + 0.5), 0.0, float(uCharCount - 1)));
    vec2 cellUV = fract(pix / cell);
    vec2 grid = vec2(uGlyphGrid);
    vec2 tileSize = 1.0 / grid;
    float colIdx = float(idx % uGlyphGrid.x);
    float rowIdx = floor(float(idx) / float(uGlyphGrid.x));
    vec2 atlasUV = (vec2(colIdx, rowIdx) + cellUV) * tileSize;
    vec3 glyphSample = texture(uGlyphAtlas, atlasUV).rgb;
    mark = dot(glyphSample, vec3(0.299, 0.587, 0.114));
  } else {
    vec2 cellUV = fract(pix / cell) - 0.5;
    float dist = length(cellUV);
    float radius = clamp(gray + uPaletteBias, 0.0, 1.0) * 0.5;
    float aa = fwidth(dist) + 1e-4;
    mark = 1.0 - smoothstep(radius - aa, radius + aa, dist);
  }

  float g2 = clamp(gray + uPaletteBias, 0.0, 1.0);
  int cnt = max(uPaletteCount, 1);
  vec3 dotCol;
  float dotOpacity;
  if (cnt <= 1) {
    dotCol = uPalette[0];
    dotOpacity = uPaletteA[0];
  } else {
    float scaled = g2 * float(cnt - 1);
    int i0 = int(floor(scaled));
    i0 = clamp(i0, 0, cnt - 2);
    float f = scaled - float(i0);
    dotCol = mix(uPalette[i0], uPalette[i0 + 1], f);
    dotOpacity = mix(uPaletteA[i0], uPaletteA[i0 + 1], f);
  }
  fragColor = vec4(dotCol, mark * dotOpacity);
}`;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColorToRgba(input: string): Rgba {
  if (!input) return { r: 0, g: 0, b: 0, a: 1 };
  const str = input.trim();
  const rgbaMatch = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (rgbaMatch) {
    const r = Math.max(0, Math.min(255, parseFloat(rgbaMatch[1]))) / 255;
    const g = Math.max(0, Math.min(255, parseFloat(rgbaMatch[2]))) / 255;
    const b = Math.max(0, Math.min(255, parseFloat(rgbaMatch[3]))) / 255;
    const a = rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4]))) : 1;
    return { r, g, b, a };
  }
  const hex = str.replace(/^#/, '');
  if (hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: parseInt(hex.slice(6, 8), 16) / 255
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: 1
    };
  }
  if (hex.length === 4) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
      a: parseInt(hex[3] + hex[3], 16) / 255
    };
  }
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
      a: 1
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function colorStringToVec4(input: string): [number, number, number, number] {
  const { r, g, b, a } = parseColorToRgba(input);
  return [r, g, b, a];
}

function mapLinear(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

function mapFrequencyUiToShader(ui: number): number {
  return mapLinear(ui, 1, 10, 0.3, 6);
}
function mapSpeedUiToShader(ui: number): number {
  return ui * 0.05;
}
function mapCellSizeUiToShader(ui: number): number {
  return mapLinear(ui, 1, 100, 6, 60);
}
function mapGammaUiToShader(ui: number): number {
  return mapLinear(ui, 1, 20, 0.5, 8);
}
function mapPaletteBiasUiToShader(ui: number): number {
  return ui * 0.05;
}

const MAX_COLORS = 10;
const DEFAULT_COLORS = ['#FFFFFF', '#E07000', '#000000'];

interface PaletteUniforms {
  rgb: [number, number, number][];
  alpha: number[];
}

function buildPaletteUniforms(colorList: string[]): PaletteUniforms {
  const rgb: [number, number, number][] = [];
  const alpha: number[] = [];
  for (let i = 0; i < MAX_COLORS; i++) {
    const src = colorList[i];
    if (src != null) {
      const [r, g, b, a] = colorStringToVec4(src);
      rgb.push([r, g, b]);
      alpha.push(a);
    } else {
      rgb.push([0, 0, 0]);
      alpha.push(0);
    }
  }
  return { rgb, alpha };
}

interface GlyphAtlas {
  texture: Texture;
  cols: number;
  rows: number;
  count: number;
}

function buildGlyphAtlas(
  gl: OGLRenderingContext,
  characters: string,
  fontFamily: string,
  fontWeight: string | number,
  fontSizePx: number,
  paddingPx: number
): GlyphAtlas | null {
  // Split by code point, exactly as `sanitizeCharacters` does. Indexing by code
  // UNIT disagreed with it: an emoji is one entry there and two here, so the
  // atlas drew a lone surrogate into each of two cells — both blank — and
  // reported an inflated `count`, which the shader then indexes across. Astral
  // glyphs came out as gaps in the field.
  const glyphs = Array.from(characters);
  const count = Math.max(1, glyphs.length);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellPx = Math.max(8, fontSizePx + paddingPx * 2);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellPx * dpr;
  canvas.height = rows * cellPx * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
  for (let i = 0; i < count; i++) {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    ctx.fillText(glyphs[i] ?? '', cx * cellPx + cellPx / 2, cy * cellPx + cellPx / 2);
  }
  const texture = new Texture(gl, {
    image: canvas,
    wrapS: gl.CLAMP_TO_EDGE,
    wrapT: gl.CLAMP_TO_EDGE,
    generateMipmaps: false,
    flipY: true
  });
  return { texture, cols, rows, count };
}

function sanitizeCharacters(raw: string): string {
  const sanitized = Array.from(raw)
    .filter(ch => !/\s/.test(ch))
    .join('');
  return sanitized.length > 0 ? sanitized : DEFAULT_CHARACTERS;
}

export interface DotMatrixProps {
  frequency?: number;
  speed?: number;
  bgColor?: string;
  colors?: string[];
  cellSize?: number;
  gamma?: number;
  paletteBias?: number;
  useGlyphAtlas?: boolean;
  characters?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  fontSizePx?: number;
}

export default function DotMatrix({
  frequency = 1,
  speed = 6,
  bgColor = '#000000',
  colors = DEFAULT_COLORS,
  cellSize = 20,
  gamma = 4,
  paletteBias = 10,
  useGlyphAtlas = false,
  characters = DEFAULT_CHARACTERS,
  fontFamily = 'monospace',
  fontWeight = 400,
  fontSizePx = 42
}: DotMatrixProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const perlinProgramRef = useRef<Program | null>(null);
  const dotProgramRef = useRef<Program | null>(null);
  const applyAtlasRef = useRef<((enabled: boolean) => void) | null>(null);
  const dprRef = useRef(1);

  const paletteColors = colors.length > 0 ? colors : DEFAULT_COLORS;
  const paletteCount = Math.min(MAX_COLORS, Math.max(1, paletteColors.length));
  const paletteKey = paletteColors.slice(0, MAX_COLORS).join('|');
  const effectiveCharacters = sanitizeCharacters(characters);

  // The atlas is rebuilt from a ref snapshot so the glyph effect never has to
  // tear down the GL context just because the font or character set changed.
  const glyphCfgRef = useRef({ effectiveCharacters, fontFamily, fontWeight, fontSizePx });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    glyphCfgRef.current = { effectiveCharacters, fontFamily, fontWeight, fontSizePx };
  });

  // Bumped by the restore handler so the effect below re-runs and builds a
  // fresh renderer. Restarting the loop alone would draw through handles the
  // loss detached. Same shape as `Plasma`/`Grainient`.
  const [glGeneration, setGlGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // The ratio BEFORE the device-pixel budget. `applySize` lowers it once it
    // knows the box; `dprRef.current` always holds the one actually in force.
    const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = baseDpr;

    /**
     * THE CANVAS IS OGL'S, NOT REACT'S — and that is the whole point.
     *
     * This used to render a `<canvas ref={canvasRef}>` and hand that element to
     * OGL. React owns such an element, so it SURVIVES this effect's cleanup —
     * while the cleanup ends by destroying the context living on it. A canvas
     * hands the same context object back to every later `getContext` call, so a
     * SECOND setup on the same element got the ALREADY-LOST context: every
     * shader failed to compile with a null info log, OGL's `Program` constructor
     * early-returned leaving `uniformLocations` undefined, and the first
     * `render()` threw `Cannot read properties of undefined (reading 'forEach')`.
     * The layer's error boundary caught it, dropped to `css-fallback`, and the
     * card was statically dead for the rest of the session. React StrictMode's
     * double-invoke reproduced it on every dev mount; in production any teardown
     * and re-setup over preserved DOM did.
     *
     * Letting OGL allocate the element makes a second setup impossible to poison
     * by construction: a new element cannot be holding an old context. The
     * release below therefore STAYS — WebKit frees a context slot only when the
     * context object is destroyed, and this project is under a
     * 16-per-web-content-process ceiling. Same shape as `Plasma`/`Grainient`.
     */
    const renderer = new Renderer({
      dpr: baseDpr,
      alpha: true,
      premultipliedAlpha: false,
      webgl: 2
    });
    const gl = renderer.gl;
    const canvas = gl.canvas as HTMLCanvasElement;

    const loseContext = () => {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    };

    // The shaders are GLSL ES 3.00 (`#version 300 es`); on a WebGL1 context they
    // cannot compile at all, so bail out and leave the flat background instead.
    // Checked BEFORE the canvas is attached, so a bail-out leaves no blank
    // canvas behind for the card layer to mistake for a live renderer.
    if (!renderer.isWebgl2) {
      loseContext();
      return;
    }

    canvas.className = 'pointer-events-none block h-full w-full';
    container.appendChild(canvas);

    const measure = () => {
      const rect = container.getBoundingClientRect();
      return {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height))
      };
    };

    const applySize = (width: number, height: number) => {
      // Cap the DRAWING BUFFER, never the CSS box — which is pinned to 100%
      // two lines down and therefore untouched by anything here. `uCellSize`
      // is the one thing in this shader denominated in buffer pixels (it is
      // compared against gl_FragCoord), and it is already multiplied by this
      // ratio, so the dot grid keeps exactly the apparent size the operator
      // set. See `render-scale.ts`.
      dprRef.current = resolveBufferRatio(width, height, baseDpr);
      renderer.dpr = dprRef.current;
      renderer.setSize(width, height);
      // `setSize` writes fixed px onto the canvas style; keep it fluid instead.
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    };

    const initial = measure();
    applySize(initial.width, initial.height);

    const perlinGeometry = new Plane(gl, { width: 2, height: 2 });
    const dotGeometry = new Plane(gl, { width: 2, height: 2 });
    const palette = buildPaletteUniforms(paletteColors);

    const perlinProgram = new Program(gl, {
      vertex: perlinVertexShader,
      fragment: perlinFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uFrequency: { value: mapFrequencyUiToShader(frequency) },
        uSpeed: { value: mapSpeedUiToShader(speed) },
        uValue: { value: 1 },
        uResolution: { value: [gl.canvas.width, gl.canvas.height] }
      }
    });
    perlinProgramRef.current = perlinProgram;
    const perlinMesh = new Mesh(gl, { geometry: perlinGeometry, program: perlinProgram });

    const renderTarget = new RenderTarget(gl, {
      width: gl.canvas.width,
      height: gl.canvas.height
    });

    // The glyph sampler always needs something bound, even in plain dot mode.
    const fallbackGlyphTexture = new Texture(gl, {
      width: 1,
      height: 1,
      generateMipmaps: false,
      flipY: false
    });

    const dotProgram = new Program(gl, {
      vertex: dotVertexShader,
      fragment: dotFragmentShader,
      uniforms: {
        uResolution: { value: [gl.canvas.width, gl.canvas.height] },
        uTexture: { value: renderTarget.texture },
        uPaletteCount: { value: paletteCount },
        uPalette: { value: palette.rgb },
        uPaletteA: { value: palette.alpha },
        // Cell size is compared against gl_FragCoord, which is in device pixels,
        // so scale by dpr to keep the dot grid the same apparent size everywhere.
        uCellSize: { value: mapCellSizeUiToShader(cellSize) * dprRef.current },
        uGamma: { value: mapGammaUiToShader(gamma) },
        uPaletteBias: { value: mapPaletteBiasUiToShader(paletteBias) },
        uUseGlyphAtlas: { value: 0 },
        uGlyphAtlas: { value: fallbackGlyphTexture },
        uGlyphGrid: { value: [0, 0] },
        uCharCount: { value: 0 }
      }
    });
    dotProgramRef.current = dotProgram;
    const dotMesh = new Mesh(gl, { geometry: dotGeometry, program: dotProgram });

    let glyphTexture: Texture | null = null;
    const releaseGlyphTexture = () => {
      if (glyphTexture) {
        // ogl's Texture has no disposer of its own; drop the GL object by hand.
        if (glyphTexture.texture) gl.deleteTexture(glyphTexture.texture);
        glyphTexture = null;
      }
    };

    let appliedKey: string | null = null;
    const applyAtlas = (enabled: boolean) => {
      const cfg = glyphCfgRef.current;
      const key = enabled
        ? `${cfg.effectiveCharacters}\u0000${cfg.fontFamily}\u0000${cfg.fontWeight}\u0000${cfg.fontSizePx}`
        : '';
      if (key === appliedKey) return;
      appliedKey = key;
      releaseGlyphTexture();
      const atlas = enabled
        ? buildGlyphAtlas(
            gl,
            cfg.effectiveCharacters,
            cfg.fontFamily,
            cfg.fontWeight,
            cfg.fontSizePx,
            DEFAULT_GLYPH_PADDING_PX
          )
        : null;
      if (atlas) {
        glyphTexture = atlas.texture;
        dotProgram.uniforms.uGlyphAtlas.value = atlas.texture;
        dotProgram.uniforms.uGlyphGrid.value = [atlas.cols, atlas.rows];
        dotProgram.uniforms.uCharCount.value = atlas.count;
        dotProgram.uniforms.uUseGlyphAtlas.value = 1;
      } else {
        dotProgram.uniforms.uGlyphAtlas.value = fallbackGlyphTexture;
        dotProgram.uniforms.uGlyphGrid.value = [0, 0];
        dotProgram.uniforms.uCharCount.value = 0;
        dotProgram.uniforms.uUseGlyphAtlas.value = 0;
      }
    };
    applyAtlasRef.current = applyAtlas;
    applyAtlas(useGlyphAtlas);

    const syncResolution = () => {
      const res = [gl.canvas.width, gl.canvas.height];
      perlinProgram.uniforms.uResolution.value = res;
      dotProgram.uniforms.uResolution.value = res;
    };

    const doResize = () => {
      const { width, height } = measure();
      if (width === renderer.width && height === renderer.height) return;
      applySize(width, height);
      renderTarget.setSize(gl.canvas.width, gl.canvas.height);
      syncResolution();
      // The budget can hand back a different ratio for the new box, and the
      // cell size is denominated in buffer pixels — without this the grid
      // would change apparent size on a resize that crossed a budget step.
      dotProgram.uniforms.uCellSize.value = mapCellSizeUiToShader(cellSize) * dprRef.current;
    };

    let rafId: number | null = null;
    let lastTime = 0;
    let contextLost = false;

    const update = (time: number) => {
      if (contextLost) return;
      rafId = requestAnimationFrame(update);
      if (time - lastTime < FRAME_INTERVAL) return;
      lastTime = time;
      perlinProgram.uniforms.uTime.value = time * 0.001;
      syncResolution();
      renderer.render({ scene: perlinMesh, target: renderTarget });
      renderer.render({ scene: dotMesh });
    };

    syncResolution();
    // THE FIRST PAINT RUNS INSIDE THE EFFECT, which makes it the one place in
    // this file where a throw escapes into React's commit instead of into a rAF
    // callback the browser merely reports to `window.onerror`.
    //
    // A context can be lost DURING this build — WebKit gives a web-content
    // process sixteen and recycles the oldest — and ogl's `Program` constructor
    // early-returns half-built when linking fails: `ogl/src/core/Program.js:84`
    // returns before assigning `uniformLocations`, which `Program.use()` then
    // dereferences. Both calls below go through it, so both throw a TypeError.
    //
    // Escaping HERE is what makes it permanent: the `webglcontextlost` and
    // `webglcontextrestored` listeners are registered further down, so a throw
    // at this line skips them, and the restore that heals every sibling effect
    // is never heard — the card stays blank until the subscriber reloads.
    // Skipping one frame costs a frame; throwing costs the session. Measured
    // across all 22 WebGL card effects: this file and its sibling
    // `ChromaticWaves` are the only two that paint synchronously, and were the
    // only two that did not recover.
    if (!gl.isContextLost()) {
      renderer.render({ scene: perlinMesh, target: renderTarget });
      renderer.render({ scene: dotMesh });
    }
    rafId = requestAnimationFrame(update);

    // OGL does not handle context loss (`ogl/src/core/Renderer.js`: "TODO:
    // Handle context loss"), unlike three.js, whose `WebGLRenderer` installs
    // its own. Without `preventDefault()` here the browser never fires
    // `webglcontextrestored` at all — so the recoverable loss WebKit produces
    // when it recycles the oldest of its 16 per-process contexts becomes a
    // permanently blank card for the rest of the session, with the loop still
    // issuing draw calls against dead handles.
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    const handleContextRestored = () => {
      setGlGeneration(generation => generation + 1);
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    let resizePending = false;
    const resizeObserver = new ResizeObserver(() => {
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => {
        resizePending = false;
        doResize();
      });
    });
    resizeObserver.observe(container);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      // Listeners come off before loseContext, or the restore handler would
      // fire during teardown and rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      applyAtlasRef.current = null;
      perlinProgramRef.current = null;
      dotProgramRef.current = null;
      releaseGlyphTexture();
      if (fallbackGlyphTexture.texture) gl.deleteTexture(fallbackGlyphTexture.texture);
      perlinProgram.remove();
      dotProgram.remove();
      perlinGeometry.remove();
      dotGeometry.remove();
      if (renderTarget.buffer) gl.deleteFramebuffer(renderTarget.buffer);
      for (const texture of renderTarget.textures) {
        if (texture.texture) gl.deleteTexture(texture.texture);
      }
      if (renderTarget.depthBuffer) gl.deleteRenderbuffer(renderTarget.depthBuffer);
      // The element goes before the context does. A detached canvas is not a
      // presentation, and the card layer's canvas observer reads exactly that:
      // a `webglcontextlost` on a canvas still in the document is a fault, one
      // on a canvas that has left it is this teardown.
      try {
        container.removeChild(canvas);
      } catch {
        /* already gone */
      }
      // Mobile browsers cap live WebGL contexts at roughly eight; hand this one
      // back immediately rather than waiting for the GC to notice the canvas.
      loseContext();
    };
  }, [glGeneration]);

  useEffect(() => {
    const perlin = perlinProgramRef.current;
    if (perlin) {
      perlin.uniforms.uFrequency.value = mapFrequencyUiToShader(frequency);
      perlin.uniforms.uSpeed.value = mapSpeedUiToShader(speed);
    }
    const dot = dotProgramRef.current;
    if (dot) {
      const palette = buildPaletteUniforms(paletteColors);
      dot.uniforms.uPaletteCount.value = paletteCount;
      dot.uniforms.uPalette.value = palette.rgb;
      dot.uniforms.uPaletteA.value = palette.alpha;
      dot.uniforms.uCellSize.value = mapCellSizeUiToShader(cellSize) * dprRef.current;
      dot.uniforms.uGamma.value = mapGammaUiToShader(gamma);
      dot.uniforms.uPaletteBias.value = mapPaletteBiasUiToShader(paletteBias);
    }
  }, [frequency, speed, paletteCount, paletteKey, cellSize, gamma, paletteBias]);

  useEffect(() => {
    applyAtlasRef.current?.(useGlyphAtlas);
  }, [useGlyphAtlas, effectiveCharacters, fontFamily, fontWeight, fontSizePx]);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" style={{ background: bgColor }} />
  );
}

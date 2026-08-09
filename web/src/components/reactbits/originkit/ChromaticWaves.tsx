import { useEffect, useRef } from 'react';
import { Mesh, Plane, Program, RenderTarget, Renderer } from 'ogl';

import { resolveBufferRatio } from '../render-scale';

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
uniform float uPaletteAlpha[10];
uniform float uCellSize;
uniform float uGamma;
uniform float uPaletteBias;
out vec4 fragColor;

void main() {
  vec2 pix = gl_FragCoord.xy;
  float cell = max(uCellSize, 1.0);

  vec2 cellIdx = floor(pix / cell);
  vec2 cellCenter = (cellIdx + 0.5) * cell;
  vec3 col = texture(uTexture, cellCenter / uResolution.xy).rgb;
  float gray = 0.3 * col.r + 0.59 * col.g + 0.11 * col.b;
  gray = pow(clamp(gray, 0.0001, 1.0), uGamma);

  vec2 cellUV = fract(pix / cell) - 0.5;
  float dist = length(cellUV);
  float radius = clamp(gray + uPaletteBias, 0.0, 1.0) * 0.5;
  float aa = fwidth(dist) + 1e-4;
  float mark = 1.0 - smoothstep(radius - aa, radius + aa, dist);

  float g2 = clamp(gray + uPaletteBias, 0.0, 1.0);
  int cnt = max(uPaletteCount, 1);
  vec3 dotCol;
  float dotOpacity;
  if (cnt <= 1) {
    dotCol = uPalette[0];
    dotOpacity = uPaletteAlpha[0];
  } else {
    float scaled = g2 * float(cnt - 1);
    int seg = int(floor(scaled));
    seg = clamp(seg, 0, cnt - 2);
    float f = clamp(scaled - float(seg), 0.0, 1.0);
    dotCol = mix(uPalette[seg], uPalette[seg + 1], f);
    dotOpacity = mix(uPaletteAlpha[seg], uPaletteAlpha[seg + 1], f);
  }
  fragColor = vec4(dotCol, mark * dotOpacity);
}`;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const cssVariableRegex = /var\s*\(\s*(--[\w-]+)(?:\s*,\s*((?:[^)(]+|\((?:[^)(]+|\([^)(]*\))*\))*))?\s*\)/;

function extractDefaultValue(cssVar: string): string {
  if (!cssVar || !cssVar.startsWith('var(')) return cssVar;
  const match = cssVariableRegex.exec(cssVar);
  if (!match) return cssVar;
  const fallback = (match[2] || '').trim();
  if (fallback.startsWith('var(')) return extractDefaultValue(fallback);
  return fallback || cssVar;
}

function resolveTokenColor(input: string): string {
  if (typeof input !== 'string') return input;
  if (!input.startsWith('var(')) return input;
  return extractDefaultValue(input);
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
  const { r, g, b, a } = parseColorToRgba(resolveTokenColor(input));
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
const DEFAULT_COLORS = ['#FFFFFF'];
const FRAME_INTERVAL = 1e3 / 30;

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

export interface ChromaticWavesProps {
  frequency?: number;
  speed?: number;
  bgColor?: string;
  colors?: string[];
  cellSize?: number;
  gamma?: number;
  paletteBias?: number;
}

export default function ChromaticWaves({
  frequency = 1,
  speed = 4,
  bgColor = '#000000',
  colors = DEFAULT_COLORS,
  cellSize = 34,
  gamma = 6,
  paletteBias = -3
}: ChromaticWavesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const perlinProgramRef = useRef<Program | null>(null);
  const dotProgramRef = useRef<Program | null>(null);
  const dprRef = useRef(1);

  const paletteColors = colors.length > 0 ? colors : DEFAULT_COLORS;
  const paletteCount = Math.min(MAX_COLORS, Math.max(1, paletteColors.length));
  const paletteKey = paletteColors.slice(0, MAX_COLORS).join('|');

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
      // ratio, so the cell grid keeps exactly the apparent size the operator
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

    const dotProgram = new Program(gl, {
      vertex: dotVertexShader,
      fragment: dotFragmentShader,
      uniforms: {
        uResolution: { value: [gl.canvas.width, gl.canvas.height] },
        uTexture: { value: renderTarget.texture },
        uPaletteCount: { value: paletteCount },
        uPalette: { value: palette.rgb },
        uPaletteAlpha: { value: palette.alpha },
        // Cell size is compared against gl_FragCoord, which is in device pixels,
        // so scale by dpr to keep the dot grid the same apparent size everywhere.
        uCellSize: { value: mapCellSizeUiToShader(cellSize) * dprRef.current },
        uGamma: { value: mapGammaUiToShader(gamma) },
        uPaletteBias: { value: mapPaletteBiasUiToShader(paletteBias) }
      }
    });
    dotProgramRef.current = dotProgram;
    const dotMesh = new Mesh(gl, { geometry: dotGeometry, program: dotProgram });

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

    const update = (time: number) => {
      rafId = requestAnimationFrame(update);
      if (time - lastTime < FRAME_INTERVAL) return;
      lastTime = time;
      perlinProgram.uniforms.uTime.value = time * 0.001;
      syncResolution();
      renderer.render({ scene: perlinMesh, target: renderTarget });
      renderer.render({ scene: dotMesh });
    };

    syncResolution();
    renderer.render({ scene: perlinMesh, target: renderTarget });
    renderer.render({ scene: dotMesh });
    rafId = requestAnimationFrame(update);

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
      perlinProgramRef.current = null;
      dotProgramRef.current = null;
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
  }, []);

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
      dot.uniforms.uPaletteAlpha.value = palette.alpha;
      dot.uniforms.uCellSize.value = mapCellSizeUiToShader(cellSize) * dprRef.current;
      dot.uniforms.uGamma.value = mapGammaUiToShader(gamma);
      dot.uniforms.uPaletteBias.value = mapPaletteBiasUiToShader(paletteBias);
    }
  }, [frequency, speed, paletteCount, paletteKey, cellSize, gamma, paletteBias]);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" style={{ background: bgColor }} />
  );
}

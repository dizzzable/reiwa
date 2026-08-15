import { useEffect, useRef, useState } from 'react';

import { resolveBufferRatio } from '../render-scale';

/**
 * Thunderstrike — GPU lightning bolt.
 *
 * Ported from Originkit `thunderstrike` (preset `base`). Raw WebGL 1: a single
 * full-screen quad whose fragment shader generates the bolt from fBm noise.
 * The only per-frame CPU work is uniform upload, which makes this the cheapest
 * effect in the set.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

/** Parse `#rgb` / `#rrggbb[aa]` / `rgb()` / `rgba()` / `hsl()` into 0..1 RGB. Never NaN. */
function parseColor(input: string): Rgb {
  const fallback: Rgb = { r: 0, g: 0, b: 0 };
  const s = (input || '').trim();
  if (!s) return fallback;

  let r = 0;
  let g = 0;
  let b = 0;

  const hexMatch = s.match(/^#?([0-9a-fA-F]{3,8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .slice(0, 3)
        .split('')
        .map(c => c + c)
        .join('');
    } else if (hex.length === 8) {
      hex = hex.slice(0, 6);
    }
    if (hex.length !== 6) return fallback;
    r = parseInt(hex.slice(0, 2), 16) / 255;
    g = parseInt(hex.slice(2, 4), 16) / 255;
    b = parseInt(hex.slice(4, 6), 16) / 255;
  } else {
    const rgbMatch = s.match(/rgba?\(([^)]+)\)/i);
    if (rgbMatch) {
      const parts = rgbMatch[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(v => parseFloat(v));
      if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return fallback;
      const scale = parts[0] > 1 || parts[1] > 1 || parts[2] > 1 ? 255 : 1;
      r = parts[0] / scale;
      g = parts[1] / scale;
      b = parts[2] / scale;
    } else {
      const hslMatch = s.match(/hsla?\(([^)]+)\)/i);
      if (!hslMatch) return fallback;
      const parts = hslMatch[1]
        .split(/[\s,/%]+/)
        .filter(Boolean)
        .map(v => parseFloat(v));
      if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return fallback;
      const h = (((parts[0] % 360) + 360) % 360) / 360;
      const sat = parts[1] > 1 ? parts[1] / 100 : parts[1];
      const li = parts[2] > 1 ? parts[2] / 100 : parts[2];
      const k = (n: number) => (n + h * 12) % 12;
      const f = (n: number) => li - sat * Math.min(li, 1 - li) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      r = f(0);
      g = f(8);
      b = f(4);
    }
  }

  if ([r, g, b].some(n => Number.isNaN(n))) return fallback;
  return {
    r: Math.min(1, Math.max(0, r)),
    g: Math.min(1, Math.max(0, g)),
    b: Math.min(1, Math.max(0, b))
  };
}

/** RGB 0..1 → HSV (h in degrees). The shader keys the bolt off hue alone. */
function rgbToHsv(rgb: Rgb): Hsv {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h: h >= 0 ? h : h + 360, s, v };
}

export interface ThunderstrikeProps {
  /** Core colour of the bolt. Only its hue reaches the shader. */
  lightningColor?: string;
  /** Backdrop colour behind the bolt. */
  backgroundColor?: string;
  /** Shifts the bolt left/right across the card. */
  xOffset?: number;
  /** How fast the crackle animates. */
  speed?: number;
  /** Brightness/strength of the glow. */
  intensity?: number;
  /** Noise scale — how thick or fine the bolt looks. */
  size?: number;
  /** Rotation of the bolt, in degrees. */
  angle?: number;
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uHue;
uniform vec3 uBackgroundHsv;
uniform float uXOffset;
uniform float uSpeed;
uniform float uIntensity;
uniform float uSize;
uniform float uAngle;

#define OCTAVE_COUNT 10

vec3 hsv2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return c.z * mix(vec3(1.0), rgb, c.y);
}

float hash11(float p) {
    p = fract(p * .1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

mat2 rotate2d(float theta) {
    float c = cos(theta);
    float s = sin(theta);
    return mat2(c, -s, s, c);
}

float noise(vec2 p) {
    vec2 ip = floor(p);
    vec2 fp = fract(p);
    float a = hash12(ip);
    float b = hash12(ip + vec2(1.0, 0.0));
    float c = hash12(ip + vec2(0.0, 1.0));
    float d = hash12(ip + vec2(1.0, 1.0));

    vec2 t = smoothstep(0.0, 1.0, fp);
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < OCTAVE_COUNT; ++i) {
        value += amplitude * noise(p);
        p *= rotate2d(0.45);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
    vec2 uv = fragCoord / iResolution.xy;
    uv = 2.0 * uv - 1.0;
    uv.x *= iResolution.x / iResolution.y;

    uv *= rotate2d(uAngle);

    uv.x += uXOffset;

    uv += 2.0 * fbm(uv * uSize + 0.8 * iTime * uSpeed) - 1.0;

    float dist = abs(uv.x);
    vec3 baseColor = hsv2rgb(vec3(uHue / 360.0, 0.7, 0.8));
    vec3 bgColor = hsv2rgb(vec3(uBackgroundHsv.x, uBackgroundHsv.y, uBackgroundHsv.z));
    vec3 lightningEffect = baseColor * pow(mix(0.0, 0.07, hash11(iTime * uSpeed)) / dist, 1.0) * uIntensity;
    vec3 col = mix(bgColor, lightningEffect, clamp(lightningEffect.r, 0.0, 1.0));
    col = pow(col, vec3(1.0));
    fragColor = vec4(col, 1.0);
}

void main() {
    mainImage(gl_FragColor, gl_FragCoord.xy);
}
`;

export default function Thunderstrike({
  lightningColor = '#593C0C',
  backgroundColor = '#000000',
  xOffset = 11,
  speed = 55,
  intensity = 69,
  size = 20,
  angle = 10
}: ThunderstrikeProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Live prop bag so tweaking a control never tears down the GL context.
  const propsRef = useRef({ lightningColor, backgroundColor, xOffset, speed, intensity, size, angle });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    propsRef.current = { lightningColor, backgroundColor, xOffset, speed, intensity, size, angle };
  });

  // Bumped by the restore handler so the effect below re-runs and rebuilds
  // the program on the revived context. Same shape as its direct sibling
  // `CosmicOrb`, which re-inits in place; here the whole effect owns the
  // canvas, so re-running it is the equivalent.
  const [glGeneration, setGlGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * THE CANVAS IS THIS EFFECT'S, NOT REACT'S — and that is the whole point.
     *
     * This used to render a `<canvas ref={canvasRef}>` and open the context on
     * that element. React owns such an element, so it SURVIVES this effect's
     * cleanup — while `disposeGl` below ends by destroying the context living on
     * it. A canvas hands the same context object back to every later
     * `getContext` call, so a SECOND setup on the same element got the
     * ALREADY-LOST context: `createShader` returns null on a lost context, so
     * `compile` bailed, `disposeGl` ran, and the component returned early to a
     * permanently blank canvas — silently, with nothing thrown for the card
     * layer's error boundary to catch. React StrictMode's double-invoke
     * reproduced it on every dev mount; in production any teardown and re-setup
     * over preserved DOM did.
     *
     * Allocating the element here makes a second setup impossible to poison by
     * construction: a new element cannot be holding an old context. The release
     * in `disposeGl` therefore STAYS — WebKit frees a context slot only when the
     * context object is destroyed, and this project is under a
     * 16-per-web-content-process ceiling. Same shape as `Plasma`/`Grainient`.
     *
     * The canvas is attached to the container only once the program has linked,
     * so a failed start leaves no blank canvas behind for the card layer to
     * mistake for a live renderer.
     */
    const canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power'
    });
    if (!gl) return;

    let destroyed = false;
    let contextLost = false;
    let rafId = 0;

    const compile = (source: string, type: number): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = compile(VERTEX_SHADER, gl.VERTEX_SHADER);
    const fragmentShader = compile(FRAGMENT_SHADER, gl.FRAGMENT_SHADER);
    const program = vertexShader && fragmentShader ? gl.createProgram() : null;
    const vertexBuffer = gl.createBuffer();

    /** Free every GL object we own. Safe to call twice. */
    const disposeGl = () => {
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      if (program) gl.deleteProgram(program);
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    };

    if (!vertexShader || !fragmentShader || !program) {
      disposeGl();
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      disposeGl();
      return;
    }
    gl.useProgram(program);

    const uniforms = {
      iResolution: gl.getUniformLocation(program, 'iResolution'),
      iTime: gl.getUniformLocation(program, 'iTime'),
      uHue: gl.getUniformLocation(program, 'uHue'),
      uBackgroundHsv: gl.getUniformLocation(program, 'uBackgroundHsv'),
      uXOffset: gl.getUniformLocation(program, 'uXOffset'),
      uSpeed: gl.getUniformLocation(program, 'uSpeed'),
      uIntensity: gl.getUniformLocation(program, 'uIntensity'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uAngle: gl.getUniformLocation(program, 'uAngle')
    };

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    // Size comes from the container, never from the window.
    const applySize = () => {
      const rect = container.getBoundingClientRect();
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      const dpr = resolveBufferRatio(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    container.appendChild(canvas);
    applySize();
    const resizeObserver = new ResizeObserver(applySize);
    resizeObserver.observe(container);

    const startTime = performance.now();

    const render = () => {
      if (destroyed || contextLost) return;
      gl.viewport(0, 0, canvas.width, canvas.height);

      const p = propsRef.current;
      const bolt = rgbToHsv(parseColor(p.lightningColor));
      const bg = rgbToHsv(parseColor(p.backgroundColor));

      gl.uniform2f(uniforms.iResolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.iTime, (performance.now() - startTime) / 1e3);
      gl.uniform1f(uniforms.uHue, Number.isFinite(bolt.h) ? bolt.h : 0);
      gl.uniform3f(
        uniforms.uBackgroundHsv,
        (Number.isFinite(bg.h) ? bg.h : 0) / 360,
        Number.isFinite(bg.s) ? bg.s : 0,
        Number.isFinite(bg.v) ? bg.v : 0
      );
      gl.uniform1f(uniforms.uXOffset, -p.xOffset / 25);
      gl.uniform1f(uniforms.uSpeed, p.speed / 50);
      gl.uniform1f(uniforms.uIntensity, p.intensity / 50);
      gl.uniform1f(uniforms.uSize, p.size * 0.03);
      gl.uniform1f(uniforms.uAngle, (p.angle * Math.PI) / 180);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);

    // `webglcontextlost` is not a touch or wheel event: preventDefault here
    // is what asks the browser to restore the context, and blocks no gesture.
    // Without it the browser never fires `webglcontextrestored` at all — so
    // the recoverable loss WebKit produces when it recycles the oldest of its
    // 16 per-process contexts becomes a permanently blank card for the rest
    // of the session, with the loop still issuing draw calls against dead
    // handles. `CosmicOrb`, the sibling on the same raw WebGL, already does
    // this; this file was the one that did not.
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
    const handleContextRestored = () => {
      setGlGeneration(generation => generation + 1);
    };
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    return () => {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      // Listeners come off before disposeGl, or the restore handler would
      // fire during teardown and rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      // The element goes before the context does. A detached canvas is not a
      // presentation, and the card layer's canvas observer reads exactly that:
      // a `webglcontextlost` on a canvas still in the document is a fault, one
      // on a canvas that has left it is this teardown.
      try {
        container.removeChild(canvas);
      } catch {
        /* already gone */
      }
      disposeGl();
    };
  }, [glGeneration]);

  return <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" />;
}

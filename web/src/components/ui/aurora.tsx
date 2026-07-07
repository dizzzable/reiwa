/**
 * Aurora — React Bits WebGL aurora background (ported to TSX).
 * Source: reactbits.dev (DavidHDev/react-bits, MIT). Renders a flowing
 * simplex-noise aurora via a single OGL fullscreen triangle. Used as the
 * living background of the subscription card; `colorStops` are wired to the
 * operator's brand colour so the card matches branding automatically.
 *
 * Cheap: one triangle, one fragment shader, no DOM churn. The canvas fills
 * its container (position the container, not the canvas).
 */

import { Renderer, Program, Mesh, Color, Triangle } from "ogl";
import { useEffect, useRef } from "react";

// GLSL ES 1.00 (no `#version 300 es`). This compiles on BOTH a WebGL1 and a
// WebGL2 context. That matters on iPhone: iOS Safari runs a SHARED GPU process
// with a low per-page live-WebGL-context cap, so `getContext('webgl2')` can
// return null under pressure and OGL then SILENTLY falls back to WebGL1 (it
// only `console.warn`s a shader-compile failure, never throws). A `#version
// 300 es` shader is a hard compile error on WebGL1 → the canvas stayed blank
// on iPhone while Android/desktop (WebGL2 available) were fine. A 1.00 shader
// removes that entire failure class (isolated Telegram WKWebView had its own
// context budget, which is why a past fix appeared to work only there).
const VERT = `attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Three fixed colour stops at 0.0 / 0.5 / 1.0 as a plain function taking
// explicit args — no multi-line #define (iOS mishandled it) and no dynamic
// array indexing (iOS is touchy about it). Output identical to the original.
vec3 colorRamp3(vec3 c0, vec3 c1, vec3 c2, float factor) {
  float f = clamp(factor, 0.0, 1.0);
  if (f < 0.5) {
    return mix(c0, c1, f / 0.5);
  }
  return mix(c1, c2, (f - 0.5) / 0.5);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  vec3 rampColor = colorRamp3(uColorStops[0], uColorStops[1], uColorStops[2], uv.x);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;

  gl_FragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

export interface AuroraProps {
  readonly colorStops?: readonly [string, string, string];
  readonly amplitude?: number;
  readonly blend?: number;
  readonly speed?: number;
  readonly className?: string;
}

export function Aurora({
  colorStops = ["#5227FF", "#7cff67", "#5227FF"],
  amplitude = 1.0,
  blend = 0.5,
  speed = 1.0,
  className,
}: AuroraProps) {
  const propsRef = useRef({ colorStops, amplitude, blend, speed });
  propsRef.current = { colorStops, amplitude, blend, speed };

  const ctnDom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctn = ctnDom.current;
    if (!ctn) return;

    // Guard renderer creation: iOS Safari/WKWebView can refuse a new WebGL2
    // context (per-page context cap reached, or the GPU process is under
    // pressure). Failing quietly leaves the always-present static gradient
    // base visible instead of throwing during render.
    let renderer: Renderer;
    try {
      renderer = new Renderer({
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
      });
    } catch {
      return;
    }
    const gl = renderer.gl;
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.style.backgroundColor = "transparent";
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    let program: Program | undefined;

    // Size from the CONTAINER via ResizeObserver rather than `window.resize`.
    // iOS Safari does not reliably fire `window.resize` when the layout
    // viewport changes (address-bar collapse/expand on scroll), so a
    // window-listener leaves the canvas rendering at a stale size — which
    // reads as the "janky"/misaligned aurora testers reported. A
    // ResizeObserver on the actual container always tracks the real box.
    function resize() {
      const width = Math.max(1, Math.floor(ctn!.offsetWidth));
      const height = Math.max(1, Math.floor(ctn!.offsetHeight));
      renderer.setSize(width, height);
      if (program) {
        program.uniforms.uResolution.value = [width, height];
      }
    }
    const ro = new ResizeObserver(resize);
    ro.observe(ctn);

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) {
      delete geometry.attributes.uv;
    }

    const colorStopsArray = propsRef.current.colorStops.map((hex) => {
      const c = new Color(hex);
      return [c.r, c.g, c.b];
    });

    program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uColorStops: { value: colorStopsArray },
        uResolution: { value: [ctn.offsetWidth, ctn.offsetHeight] },
        uBlend: { value: blend },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });
    ctn.appendChild(canvas);

    let animateId = 0;
    let contextLost = false;
    const update = (t: number) => {
      if (contextLost) return;
      animateId = requestAnimationFrame(update);
      const current = propsRef.current;
      const time = t * 0.01;
      if (program) {
        program.uniforms.uTime.value = time * (current.speed ?? 1.0) * 0.1;
        program.uniforms.uAmplitude.value = current.amplitude ?? 1.0;
        program.uniforms.uBlend.value = current.blend ?? blend;
        program.uniforms.uColorStops.value = current.colorStops.map((hex) => {
          const c = new Color(hex);
          return [c.r, c.g, c.b];
        });
        renderer.render({ scene: mesh });
      }
    };

    // Recover from a lost context instead of staying blank forever. WebKit
    // drops the oldest WebGL context when a page holds too many at once (a
    // hard, low cap on iPhone) and also on backgrounding — without these
    // handlers the card would render once, lose its context, and never come
    // back until the component fully remounts.
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      cancelAnimationFrame(animateId);
    };
    const handleContextRestored = () => {
      contextLost = false;
      cancelAnimationFrame(animateId);
      animateId = requestAnimationFrame(update);
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    resize();
    animateId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animateId);
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      if (canvas.parentNode === ctn) {
        ctn.removeChild(canvas);
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // Mount ONCE: every animated prop (amplitude/blend/speed/colorStops) is
    // read live from `propsRef` inside the frame loop, so a prop change must
    // NOT tear down and recreate the WebGL context — recreating contexts is
    // exactly the iOS per-page context-cap churn this component avoids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ctnDom}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
}

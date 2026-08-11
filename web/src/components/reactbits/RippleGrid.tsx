import { useRef, useEffect, useState } from 'react';
import { Renderer, Program, Triangle, Mesh } from 'ogl';

import { resolveBufferRatio } from './render-scale';

type Props = {
  enableRainbow?: boolean;
  gridColor?: string;
  rippleIntensity?: number;
  gridSize?: number;
  gridThickness?: number;
  fadeDistance?: number;
  vignetteStrength?: number;
  glowIntensity?: number;
  opacity?: number;
  gridRotation?: number;
  mouseInteraction?: boolean;
  mouseInteractionRadius?: number;
};

const RippleGrid: React.FC<Props> = ({
  enableRainbow = false,
  gridColor = '#ffffff',
  rippleIntensity = 0.05,
  gridSize = 10.0,
  gridThickness = 15.0,
  fadeDistance = 1.5,
  vignetteStrength = 2.0,
  glowIntensity = 0.1,
  opacity = 1.0,
  gridRotation = 0,
  mouseInteraction = true,
  mouseInteractionRadius = 1
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mousePositionRef = useRef({ x: 0.5, y: 0.5 });
  const targetMouseRef = useRef({ x: 0.5, y: 0.5 });
  const mouseInfluenceRef = useRef(0);
  const uniformsRef = useRef<any>(null);
  // Bumped by `webglcontextrestored` to re-run the build effect below. OGL keeps
  // every GL handle inside Renderer/Program/Geometry and caches driver state on
  // the Renderer, none of which survive a context loss and none of which it can
  // reset — so the only honest recovery is to build the whole thing again. The
  // rebuild reads the props it is rendered with, and repoints `uniformsRef` at
  // the new program, so the operator's settings survive the round trip and the
  // uniform-push effect underneath keeps writing to something live.
  const [glGeneration, setGlGeneration] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    // Captured here, not read from the ref in cleanup. React detaches refs
    // before a passive cleanup runs on unmount, so `containerRef.current` is
    // already `null` by then and `?.removeChild(...)` silently does nothing —
    // leaving the dead canvas in the DOM. A second mount on the same element
    // then finds THAT canvas, backed by a context we just destroyed, and the
    // effect never appears again. Every other repaired component in this
    // directory captures the container for exactly this reason.
    const ctn = containerRef.current;

    const hexToRgb = (hex: string): [number, number, number] => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result
        ? [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255]
        : [1, 1, 1];
    };

    // `|| 1` because a browser that does not report a ratio yields `undefined`,
    // and `Math.min(undefined, 2)` is `NaN` — which ogl passes straight into
    // the canvas dimensions, producing a zero-sized surface and a blank card.
    // This is the ratio BEFORE the device-pixel budget; `resize` reduces it
    // when the box is large enough to need it.
    const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderer = new Renderer({
      dpr: baseDpr,
      alpha: true
    });
    const gl = renderer.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.canvas.style.width = '100%';
    gl.canvas.style.height = '100%';
    ctn.appendChild(gl.canvas);

    const vert = `
attribute vec2 position;
varying vec2 vUv;
void main() {
    vUv = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}`;

    const frag = `precision highp float;
uniform float iTime;
uniform vec2 iResolution;
uniform bool enableRainbow;
uniform vec3 gridColor;
uniform float rippleIntensity;
uniform float gridSize;
uniform float gridThickness;
uniform float fadeDistance;
uniform float vignetteStrength;
uniform float glowIntensity;
uniform float opacity;
uniform float gridRotation;
uniform bool mouseInteraction;
uniform vec2 mousePosition;
uniform float mouseInfluence;
uniform float mouseInteractionRadius;
varying vec2 vUv;

float pi = 3.141592;

mat2 rotate(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
}

void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    uv.x *= iResolution.x / iResolution.y;

    if (gridRotation != 0.0) {
        uv = rotate(gridRotation * pi / 180.0) * uv;
    }

    float dist = length(uv);
    float func = sin(pi * (iTime - dist));
    vec2 rippleUv = uv + uv * func * rippleIntensity;

    if (mouseInteraction && mouseInfluence > 0.0) {
        vec2 mouseUv = (mousePosition * 2.0 - 1.0);
        mouseUv.x *= iResolution.x / iResolution.y;
        float mouseDist = length(uv - mouseUv);
        
        float influence = mouseInfluence * exp(-mouseDist * mouseDist / (mouseInteractionRadius * mouseInteractionRadius));
        
        float mouseWave = sin(pi * (iTime * 2.0 - mouseDist * 3.0)) * influence;
        rippleUv += normalize(uv - mouseUv) * mouseWave * rippleIntensity * 0.3;
    }

    vec2 a = sin(gridSize * 0.5 * pi * rippleUv - pi / 2.0);
    vec2 b = abs(a);

    float aaWidth = 0.5;
    vec2 smoothB = vec2(
        smoothstep(0.0, aaWidth, b.x),
        smoothstep(0.0, aaWidth, b.y)
    );

    vec3 color = vec3(0.0);
    color += exp(-gridThickness * smoothB.x * (0.8 + 0.5 * sin(pi * iTime)));
    color += exp(-gridThickness * smoothB.y);
    color += 0.5 * exp(-(gridThickness / 4.0) * sin(smoothB.x));
    color += 0.5 * exp(-(gridThickness / 3.0) * smoothB.y);

    if (glowIntensity > 0.0) {
        color += glowIntensity * exp(-gridThickness * 0.5 * smoothB.x);
        color += glowIntensity * exp(-gridThickness * 0.5 * smoothB.y);
    }

    float ddd = exp(-2.0 * clamp(pow(dist, fadeDistance), 0.0, 1.0));
    
    vec2 vignetteCoords = vUv - 0.5;
    float vignetteDistance = length(vignetteCoords);
    float vignette = 1.0 - pow(vignetteDistance * 2.0, vignetteStrength);
    vignette = clamp(vignette, 0.0, 1.0);
    
    vec3 t;
    if (enableRainbow) {
        t = vec3(
            uv.x * 0.5 + 0.5 * sin(iTime),
            uv.y * 0.5 + 0.5 * cos(iTime),
            pow(cos(iTime), 4.0)
        ) + 0.5;
    } else {
        t = gridColor;
    }

    float finalFade = ddd * vignette;
    float alpha = length(color) * finalFade * opacity;
    gl_FragColor = vec4(color * t * finalFade * opacity, alpha);
}`;

    const uniforms = {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      enableRainbow: { value: enableRainbow },
      gridColor: { value: hexToRgb(gridColor) },
      rippleIntensity: { value: rippleIntensity },
      gridSize: { value: gridSize },
      gridThickness: { value: gridThickness },
      fadeDistance: { value: fadeDistance },
      vignetteStrength: { value: vignetteStrength },
      glowIntensity: { value: glowIntensity },
      opacity: { value: opacity },
      gridRotation: { value: gridRotation },
      mouseInteraction: { value: mouseInteraction },
      mousePosition: { value: [0.5, 0.5] },
      mouseInfluence: { value: 0 },
      mouseInteractionRadius: { value: mouseInteractionRadius }
    };

    uniformsRef.current = uniforms;

    const geometry = new Triangle(gl);
    const program = new Program(gl, { vertex: vert, fragment: frag, uniforms });
    const mesh = new Mesh(gl, { geometry, program });

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = ctn;
      // Cap the DRAWING BUFFER, never the CSS box. ogl's `setSize` writes
      // `canvas.style` from the CSS numbers below and multiplies only
      // `canvas.width/height` by `dpr`, so this lowers sampling density and
      // changes nothing the operator configured — every feature this shader
      // derives from `uResolution` is a fraction of it. See `render-scale.ts`.
      const bufferRatio = resolveBufferRatio(w, h, baseDpr);
      // Reallocate the drawing buffer only when the box actually moved — see
      // the note in `LiquidChrome.tsx`: iOS fires `resize` per frame while the
      // address bar collapses, a full-viewport host is `lvh`-sized so its box
      // does not move, and ogl's `setSize` reallocates the WebGL buffer even
      // for an identical value. The uniform stays outside the guard so a
      // container matching ogl's 300×150 construction size still gets it.
      if (w !== renderer.width || h !== renderer.height || bufferRatio !== renderer.dpr) {
        renderer.dpr = bufferRatio;
        renderer.setSize(w, h);
      }
      uniforms.iResolution.value = [w, h];
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!mouseInteraction) return;
      const rect = ctn.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = 1.0 - (e.clientY - rect.top) / rect.height;
      targetMouseRef.current = { x, y };
    };

    const handleMouseEnter = () => {
      if (!mouseInteraction) return;
      mouseInfluenceRef.current = 1.0;
    };

    const handleMouseLeave = () => {
      if (!mouseInteraction) return;
      mouseInfluenceRef.current = 0.0;
    };

    window.addEventListener('resize', resize);
    if (mouseInteraction) {
      ctn.addEventListener('mousemove', handleMouseMove);
      ctn.addEventListener('mouseenter', handleMouseEnter);
      ctn.addEventListener('mouseleave', handleMouseLeave);
    }
    resize();

    // The frame id has to be kept: an unstored requestAnimationFrame cannot be
    // cancelled, so the loop below outlived every unmount, held the renderer
    // and its canvas alive against GC, and kept calling render() on a context
    // the cleanup had already lost.
    let raf = 0;
    let contextLost = false;

    const render = (t: number) => {
      if (contextLost) return;
      uniforms.iTime.value = t * 0.001;

      const lerpFactor = 0.1;
      mousePositionRef.current.x += (targetMouseRef.current.x - mousePositionRef.current.x) * lerpFactor;
      mousePositionRef.current.y += (targetMouseRef.current.y - mousePositionRef.current.y) * lerpFactor;

      const currentInfluence = uniforms.mouseInfluence.value;
      const targetInfluence = mouseInfluenceRef.current;
      uniforms.mouseInfluence.value += (targetInfluence - currentInfluence) * 0.05;

      uniforms.mousePosition.value = [mousePositionRef.current.x, mousePositionRef.current.y];

      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(render);
    };

    // Without preventDefault the browser never fires `webglcontextrestored`,
    // so a recoverable loss becomes permanent.
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(raf);
    };
    // Restarting the loop alone would draw with handles the loss detached.
    // Re-running the effect tears this renderer down (freeing its slot) and
    // builds a fresh one, so the count of live contexts stays flat.
    const handleContextRestored = () => {
      setGlGeneration(generation => generation + 1);
    };
    const canvas = gl.canvas as HTMLCanvasElement;
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      if (mouseInteraction) {
        // `ctn`, not `containerRef.current`: the ref is already `null` here on
        // unmount, so this guard was false and these three listeners were never
        // taken off — the same detach that left the dead canvas in the DOM,
        // three lines further down.
        ctn.removeEventListener('mousemove', handleMouseMove);
        ctn.removeEventListener('mouseenter', handleMouseEnter);
        ctn.removeEventListener('mouseleave', handleMouseLeave);
      }
      // Listeners come off before loseContext, or handleContextRestored would
      // fire during teardown and rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      // Detach before destroying, the order every other component here uses:
      // the canvas must be out of the DOM whether or not the extension is
      // available, and a lost context on a still-attached canvas is what a
      // remount finds.
      if (gl.canvas.parentNode === ctn) ctn.removeChild(gl.canvas);
      renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [glGeneration]);

  useEffect(() => {
    if (!uniformsRef.current) return;

    const hexToRgb = (hex: string): [number, number, number] => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result
        ? [parseInt(result[1], 16) / 255, parseInt(result[2], 16) / 255, parseInt(result[3], 16) / 255]
        : [1, 1, 1];
    };

    uniformsRef.current.enableRainbow.value = enableRainbow;
    uniformsRef.current.gridColor.value = hexToRgb(gridColor);
    uniformsRef.current.rippleIntensity.value = rippleIntensity;
    uniformsRef.current.gridSize.value = gridSize;
    uniformsRef.current.gridThickness.value = gridThickness;
    uniformsRef.current.fadeDistance.value = fadeDistance;
    uniformsRef.current.vignetteStrength.value = vignetteStrength;
    uniformsRef.current.glowIntensity.value = glowIntensity;
    uniformsRef.current.opacity.value = opacity;
    uniformsRef.current.gridRotation.value = gridRotation;
    uniformsRef.current.mouseInteraction.value = mouseInteraction;
    uniformsRef.current.mouseInteractionRadius.value = mouseInteractionRadius;
  }, [
    enableRainbow,
    gridColor,
    rippleIntensity,
    gridSize,
    gridThickness,
    fadeDistance,
    vignetteStrength,
    glowIntensity,
    opacity,
    gridRotation,
    mouseInteraction,
    mouseInteractionRadius
  ]);

  return <div ref={containerRef} className="w-full h-full relative overflow-hidden [&_canvas]:block" />;
};

export default RippleGrid;

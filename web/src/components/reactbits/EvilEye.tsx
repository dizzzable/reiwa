import { Renderer, Program, Mesh, Triangle, Texture } from 'ogl';
import { useEffect, useRef, useState } from 'react';

import { resolveBufferRatio } from './render-scale';

interface EvilEyeProps {
  eyeColor?: string;
  intensity?: number;
  pupilSize?: number;
  irisWidth?: number;
  glowIntensity?: number;
  scale?: number;
  noiseScale?: number;
  pupilFollow?: number;
  flameSpeed?: number;
  backgroundColor?: string;
}

function hexToVec3(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  ];
}

function generateNoiseTexture(size = 256): Uint8Array {
  const data = new Uint8Array(size * size * 4);

  function hash(x: number, y: number, s: number): number {
    let n = x * 374761393 + y * 668265263 + s * 1274126177;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  function noise(px: number, py: number, freq: number, seed: number): number {
    const fx = (px / size) * freq;
    const fy = (py / size) * freq;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const w = freq | 0;
    const v00 = hash(((ix % w) + w) % w, ((iy % w) + w) % w, seed);
    const v10 = hash((((ix + 1) % w) + w) % w, ((iy % w) + w) % w, seed);
    const v01 = hash(((ix % w) + w) % w, (((iy + 1) % w) + w) % w, seed);
    const v11 = hash((((ix + 1) % w) + w) % w, (((iy + 1) % w) + w) % w, seed);
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.4;
      let totalAmp = 0;
      for (let o = 0; o < 8; o++) {
        const f = 32 * (1 << o);
        v += amp * noise(x, y, f, o * 31);
        totalAmp += amp;
        amp *= 0.65;
      }
      v /= totalAmp;
      v = (v - 0.5) * 2.2 + 0.5;
      v = Math.max(0, Math.min(1, v));
      const val = Math.round(v * 255);
      const i = (y * size + x) * 4;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
  }

  return data;
}

/** The size the shader samples this at; changing it changes the picture. */
const NOISE_SIZE = 256;

/**
 * 256 × 256 pixels × 8 octaves ≈ 524,000 noise evaluations, all of them
 * synchronous and all of them on the MAIN THREAD — i.e. felt as a frozen tap,
 * not as a dropped frame. It used to run inside an effect that depended on
 * every prop, so it ran again on every tick of every slider.
 *
 * The function is pure and deterministic, so one result serves every mount for
 * the life of the module. 256 KiB, built at most once, on first use rather than
 * at import so a page that never shows this effect never pays for it.
 */
let noiseDataCache: Uint8Array | null = null;
function sharedNoiseTexture(): Uint8Array {
  if (!noiseDataCache) noiseDataCache = generateNoiseTexture(NOISE_SIZE);
  return noiseDataCache;
}

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uResolution;
uniform sampler2D uNoiseTexture;
uniform float uPupilSize;
uniform float uIrisWidth;
uniform float uGlowIntensity;
uniform float uIntensity;
uniform float uScale;
uniform float uNoiseScale;
uniform vec2 uMouse;
uniform float uPupilFollow;
uniform float uFlameSpeed;
uniform vec3 uEyeColor;
uniform vec3 uBgColor;

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution.xy) / uResolution.y;
  uv /= uScale;
  float ft = uTime * uFlameSpeed;

  float polarRadius = length(uv) * 2.0;
  float polarAngle = (2.0 * atan(uv.x, uv.y)) / 6.28 * 0.3;
  vec2 polarUv = vec2(polarRadius, polarAngle);

  vec4 noiseA = texture2D(uNoiseTexture, polarUv * vec2(0.2, 7.0) * uNoiseScale + vec2(-ft * 0.1, 0.0));
  vec4 noiseB = texture2D(uNoiseTexture, polarUv * vec2(0.3, 4.0) * uNoiseScale + vec2(-ft * 0.2, 0.0));
  vec4 noiseC = texture2D(uNoiseTexture, polarUv * vec2(0.1, 5.0) * uNoiseScale + vec2(-ft * 0.1, 0.0));

  float distanceMask = 1.0 - length(uv);

  // Inner ring
  float innerRing = clamp(-1.0 * ((distanceMask - 0.7) / uIrisWidth), 0.0, 1.0);
  innerRing = (innerRing * distanceMask - 0.2) / 0.28;
  innerRing += noiseA.r - 0.5;
  innerRing *= 1.3;
  innerRing = clamp(innerRing, 0.0, 1.0);

  float outerRing = clamp(-1.0 * ((distanceMask - 0.5) / 0.2), 0.0, 1.0);
  outerRing = (outerRing * distanceMask - 0.1) / 0.38;
  outerRing += noiseC.r - 0.5;
  outerRing *= 1.3;
  outerRing = clamp(outerRing, 0.0, 1.0);

  innerRing += outerRing;

  // Inner eye
  float innerEye = distanceMask - 0.1 * 2.0;
  innerEye *= noiseB.r * 2.0;

  // Pupil with cursor tracking
  vec2 pupilOffset = uMouse * uPupilFollow * 0.12;
  vec2 pupilUv = uv - pupilOffset;
  float pupil = 1.0 - length(pupilUv * vec2(9.0, 2.3));
  pupil *= uPupilSize;
  pupil = clamp(pupil, 0.0, 1.0);
  pupil /= 0.35;

  // Outer eye
  float outerEyeGlow = 1.0 - length(uv * vec2(0.5, 1.5));
  outerEyeGlow = clamp(outerEyeGlow + 0.5, 0.0, 1.0);
  outerEyeGlow += noiseC.r - 0.5;
  float outerBgGlow = outerEyeGlow;
  outerEyeGlow = pow(outerEyeGlow, 2.0);
  outerEyeGlow += distanceMask;
  outerEyeGlow *= uGlowIntensity;
  outerEyeGlow = clamp(outerEyeGlow, 0.0, 1.0);
  outerEyeGlow *= pow(1.0 - distanceMask, 2.0) * 2.5;

  // Outer eye bg glow
  outerBgGlow += distanceMask;
  outerBgGlow = pow(outerBgGlow, 0.5);
  outerBgGlow *= 0.15;

  vec3 color = uEyeColor * uIntensity * clamp(max(innerRing + innerEye, outerEyeGlow + outerBgGlow) - pupil, 0.0, 3.0);
  color += uBgColor;

  gl_FragColor = vec4(color, 1.0);
}
`;

export default function EvilEye({
  eyeColor = '#FF6F37',
  intensity = 1.5,
  pupilSize = 0.6,
  irisWidth = 0.25,
  glowIntensity = 0.35,
  scale = 0.8,
  noiseScale = 1.0,
  pupilFollow = 1.0,
  flameSpeed = 1.0,
  backgroundColor = '#000000'
}: EvilEyeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const programRef = useRef<Program | null>(null);
  // Bumped by `webglcontextrestored` to re-run the build effect. OGL keeps every
  // GL handle inside Renderer/Program/Geometry/Texture and caches driver state
  // on the Renderer, none of which survive a context loss and none of which it
  // can reset — so the only honest recovery is to build the whole thing again.
  const [glGeneration, setGlGeneration] = useState(0);

  // Build effect: renderer, noise texture, program, mesh. Runs once per GL
  // context, never on a prop change.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    // The ratio BEFORE the device-pixel budget; `resize` reduces it when the
    // box is large enough to need it. ogl defaults to 1, which is already a
    // 3.7M-pixel buffer on a 1440p viewport.
    const baseDpr = Math.min(window.devicePixelRatio || 1, 2);
    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, premultipliedAlpha: false, dpr: baseDpr });
    } catch {
      return;
    }
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);

    const noiseData = sharedNoiseTexture();
    const noiseTexture = new Texture(gl, {
      image: noiseData,
      width: NOISE_SIZE,
      height: NOISE_SIZE,
      generateMipmaps: false,
      flipY: false,
    });
    noiseTexture.minFilter = gl.LINEAR;
    noiseTexture.magFilter = gl.LINEAR;
    noiseTexture.wrapS = gl.REPEAT;
    noiseTexture.wrapT = gl.REPEAT;

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

    function onMouseMove(e: MouseEvent) {
      const rect = container.getBoundingClientRect();
      mouse.tx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.ty = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    }

    function onMouseLeave() {
      mouse.tx = 0;
      mouse.ty = 0;
    }

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mouseleave', onMouseLeave);

    let program: Program;

    function resize() {
      const w = container.offsetWidth;
      const h = container.offsetHeight;
      // Cap the DRAWING BUFFER, never the CSS box: `setSize` writes
      // `canvas.style.width/height` from the width/height passed in and
      // multiplies only `canvas.width/height` by `dpr`. The eye is sized from
      // `uResolution`, so the picture is the same one at a lower sampling
      // density. See `render-scale.ts`.
      renderer.dpr = resolveBufferRatio(w, h, baseDpr);
      renderer.setSize(w, h);
      if (program) {
        program.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height];
      }
    }
    // A window `resize` listener misses every reason this box actually changes
    // size — a panel opening, a card reflowing, a drawer sliding — and fires
    // for plenty that do not affect it.
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    const geometry = new Triangle(gl);
    program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [gl.canvas.width, gl.canvas.height, gl.canvas.width / gl.canvas.height] },
        uNoiseTexture: { value: noiseTexture },
        uPupilSize: { value: pupilSize },
        uIrisWidth: { value: irisWidth },
        uGlowIntensity: { value: glowIntensity },
        uIntensity: { value: intensity },
        uScale: { value: scale },
        uNoiseScale: { value: noiseScale },
        uMouse: { value: [0, 0] },
        uPupilFollow: { value: pupilFollow },
        uFlameSpeed: { value: flameSpeed },
        uEyeColor: { value: hexToVec3(eyeColor) },
        uBgColor: { value: hexToVec3(backgroundColor) }
      }
    });

    programRef.current = program;

    const mesh = new Mesh(gl, { geometry, program });
    container.appendChild(gl.canvas);

    let animationFrameId = 0;
    let contextLost = false;

    function update(time: number) {
      if (contextLost) return;
      animationFrameId = requestAnimationFrame(update);
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      program.uniforms.uMouse.value = [mouse.x, mouse.y];
      program.uniforms.uTime.value = time * 0.001;
      renderer.render({ scene: mesh });
    }

    // Without preventDefault the browser never fires `webglcontextrestored`,
    // so a recoverable loss becomes permanent.
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(animationFrameId);
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

    animationFrameId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animationFrameId);
      ro.disconnect();
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('mouseleave', onMouseLeave);
      // Listeners come off before loseContext, or handleContextRestored would
      // fire during teardown and rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      programRef.current = null;
      // Guarded: `removeChild` THROWS if the node is not a child, and it will
      // not be one whenever React has already discarded the container subtree.
      if (canvas.parentNode === container) container.removeChild(canvas);
      // A dropped reference does not free the context: WebKit only returns the
      // slot when the object is destroyed, and the page hits the 16-context cap
      // long before GC gets there.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // Construction only. Every prop is pushed to a uniform by the effect below.
  }, [glGeneration]);

  // Uniform pushes — zero GPU cost, no teardown.
  useEffect(() => {
    const program = programRef.current;
    if (!program) return;
    const u = program.uniforms;
    u.uPupilSize.value = pupilSize;
    u.uIrisWidth.value = irisWidth;
    u.uGlowIntensity.value = glowIntensity;
    u.uIntensity.value = intensity;
    u.uScale.value = scale;
    u.uNoiseScale.value = noiseScale;
    u.uPupilFollow.value = pupilFollow;
    u.uFlameSpeed.value = flameSpeed;
    u.uEyeColor.value = hexToVec3(eyeColor);
    u.uBgColor.value = hexToVec3(backgroundColor);
  }, [
    eyeColor,
    intensity,
    pupilSize,
    irisWidth,
    glowIntensity,
    scale,
    noiseScale,
    pupilFollow,
    flameSpeed,
    backgroundColor,
    // A rebuilt Program starts on the values baked into its constructor;
    // without this a restored canvas would render the mount-time props.
    glGeneration
  ]);

  return <div ref={containerRef} className="w-full h-full" />;
}

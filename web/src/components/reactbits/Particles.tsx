import React, { useEffect, useRef, useState } from 'react';
import { Renderer, Camera, Geometry, Program, Mesh } from 'ogl';

import { resolveRenderScale } from './render-scale';

interface ParticlesProps {
  particleCount?: number;
  particleSpread?: number;
  speed?: number;
  particleColors?: string[];
  moveParticlesOnHover?: boolean;
  particleHoverFactor?: number;
  alphaParticles?: boolean;
  particleBaseSize?: number;
  sizeRandomness?: number;
  cameraDistance?: number;
  disableRotation?: boolean;
  pixelRatio?: number;
  className?: string;
}

const defaultColors: string[] = ['#ffffff', '#ffffff', '#ffffff'];

const hexToRgb = (hex: string): [number, number, number] => {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map(c => c + c)
      .join('');
  }
  const int = parseInt(hex, 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  return [r, g, b];
};

const vertex = /* glsl */ `
  attribute vec3 position;
  attribute vec4 random;
  attribute vec3 color;
  
  uniform mat4 modelMatrix;
  uniform mat4 viewMatrix;
  uniform mat4 projectionMatrix;
  uniform float uTime;
  uniform float uSpread;
  uniform float uBaseSize;
  uniform float uSizeRandomness;
  
  varying vec4 vRandom;
  varying vec3 vColor;
  
  void main() {
    vRandom = random;
    vColor = color;
    
    vec3 pos = position * uSpread;
    pos.z *= 10.0;
    
    vec4 mPos = modelMatrix * vec4(pos, 1.0);
    float t = uTime;
    mPos.x += sin(t * random.z + 6.28 * random.w) * mix(0.1, 1.5, random.x);
    mPos.y += sin(t * random.y + 6.28 * random.x) * mix(0.1, 1.5, random.w);
    mPos.z += sin(t * random.w + 6.28 * random.y) * mix(0.1, 1.5, random.z);
    
    vec4 mvPos = viewMatrix * mPos;

    if (uSizeRandomness == 0.0) {
      gl_PointSize = uBaseSize;
    } else {
      gl_PointSize = (uBaseSize * (1.0 + uSizeRandomness * (random.x - 0.5))) / length(mvPos.xyz);
    }
    
    gl_Position = projectionMatrix * mvPos;
    gl_Position = projectionMatrix * mvPos;
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  
  uniform float uTime;
  uniform float uAlphaParticles;
  varying vec4 vRandom;
  varying vec3 vColor;
  
  void main() {
    vec2 uv = gl_PointCoord.xy;
    float d = length(uv - vec2(0.5));
    
    if(uAlphaParticles < 0.5) {
      if(d > 0.5) {
        discard;
      }
      gl_FragColor = vec4(vColor + 0.2 * sin(uv.yxx + uTime + vRandom.y * 6.28), 1.0);
    } else {
      float circle = smoothstep(0.5, 0.4, d) * 0.8;
      gl_FragColor = vec4(vColor + 0.2 * sin(uv.yxx + uTime + vRandom.y * 6.28), circle);
    }
  }
`;

const Particles: React.FC<ParticlesProps> = ({
  particleCount = 200,
  particleSpread = 10,
  speed = 0.1,
  particleColors,
  moveParticlesOnHover = false,
  particleHoverFactor = 1,
  alphaParticles = false,
  particleBaseSize = 100,
  sizeRandomness = 1,
  cameraDistance = 20,
  disableRotation = false,
  pixelRatio = 1,
  className
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Bumped by `webglcontextrestored` to re-run the effect below. OGL keeps
  // every GL handle inside Renderer/Program/Geometry and caches driver state on
  // the Renderer, none of which survive a context loss and none of which it can
  // reset — so the only honest recovery is to build the whole thing again.
  const [glGeneration, setGlGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // `pixelRatio` is an operator-set control and reached the renderer
    // unclamped. Fill rate is the reason for the ceiling: this shader runs per
    // fragment, so the cost is the square of the multiplier, and on a phone
    // already halving its frame rate under Low Power Mode or thermal pressure
    // that is the difference between artwork and a slideshow. Two is beyond what
    // any display resolves on a card, and the same component also backs the
    // full-screen app background, where a large multiplier additionally
    // approaches WebKit's canvas-area ceiling.
    const dpr = Math.min(Math.max(pixelRatio, 1), 2);
    const renderer = new Renderer({ dpr, depth: false, alpha: true });
    const gl = renderer.gl;
    container.appendChild(gl.canvas);
    gl.clearColor(0, 0, 0, 0);

    const camera = new Camera(gl, { fov: 15 });
    camera.position.set(0, 0, cameraDistance);

    // Assigned once the program below exists. `resize` runs before it — ogl
    // needs a sized surface first — and has to reach the point size afterwards.
    let sizedProgram: Program | null = null;
    let renderScale = 1;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      // Cap the DRAWING BUFFER, never the CSS box. ogl's `setSize` writes
      // `canvas.style` from the CSS numbers below and multiplies only
      // `canvas.width/height` by `dpr`, so this lowers sampling density.
      // `uBaseSize` is the one thing here denominated in BUFFER pixels
      // (`gl_PointSize` is), so it is scaled by the same factor below and the
      // particles keep exactly the on-screen size they had. See
      // `render-scale.ts`.
      renderScale = resolveRenderScale(width, height, dpr);
      const bufferRatio = dpr * renderScale;
      // Reallocate the drawing buffer only when the box actually moved — see
      // the note in `LiquidChrome.tsx`: iOS fires `resize` per frame while the
      // address bar collapses, a full-viewport host is `lvh`-sized so its box
      // does not move, and ogl's `setSize` reallocates the WebGL buffer even
      // for an identical value. The camera stays outside the guard so a
      // container matching ogl's 300×150 construction size still gets it.
      if (width !== renderer.width || height !== renderer.height || bufferRatio !== renderer.dpr) {
        renderer.dpr = bufferRatio;
        renderer.setSize(width, height);
      }
      camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
      if (sizedProgram) {
        sizedProgram.uniforms.uBaseSize.value = particleBaseSize * pixelRatio * renderScale;
      }
    };
    window.addEventListener('resize', resize, false);
    resize();

    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      mouseRef.current = { x, y };
    };

    if (moveParticlesOnHover) {
      container.addEventListener('mousemove', handleMouseMove);
    }

    const count = particleCount;
    const positions = new Float32Array(count * 3);
    const randoms = new Float32Array(count * 4);
    const colors = new Float32Array(count * 3);
    const palette = particleColors && particleColors.length > 0 ? particleColors : defaultColors;

    for (let i = 0; i < count; i++) {
      let x: number, y: number, z: number, len: number;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        len = x * x + y * y + z * z;
      } while (len > 1 || len === 0);
      const r = Math.cbrt(Math.random());
      positions.set([x * r, y * r, z * r], i * 3);
      randoms.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
      const col = hexToRgb(palette[Math.floor(Math.random() * palette.length)]);
      colors.set(col, i * 3);
    }

    const geometry = new Geometry(gl, {
      position: { size: 3, data: positions },
      random: { size: 4, data: randoms },
      color: { size: 3, data: colors }
    });

    const program = new Program(gl, {
      vertex,
      fragment,
      uniforms: {
        uTime: { value: 0 },
        uSpread: { value: particleSpread },
        uBaseSize: { value: particleBaseSize * pixelRatio * renderScale },
        uSizeRandomness: { value: sizeRandomness },
        uAlphaParticles: { value: alphaParticles ? 1 : 0 }
      },
      transparent: true,
      depthTest: false
    });
    // From here on `resize` can keep the point size in step with the buffer.
    sizedProgram = program;

    const particles = new Mesh(gl, { mode: gl.POINTS, geometry, program });

    let animationFrameId: number;
    let contextLost = false;
    let lastTime = performance.now();
    let elapsed = 0;

    const update = (t: number) => {
      if (contextLost) return;
      animationFrameId = requestAnimationFrame(update);
      const delta = t - lastTime;
      lastTime = t;
      elapsed += delta * speed;

      program.uniforms.uTime.value = elapsed * 0.001;

      if (moveParticlesOnHover) {
        particles.position.x = -mouseRef.current.x * particleHoverFactor;
        particles.position.y = -mouseRef.current.y * particleHoverFactor;
      } else {
        particles.position.x = 0;
        particles.position.y = 0;
      }

      if (!disableRotation) {
        particles.rotation.x = Math.sin(elapsed * 0.0002) * 0.1;
        particles.rotation.y = Math.cos(elapsed * 0.0005) * 0.15;
        particles.rotation.z += 0.01 * speed;
      }

      renderer.render({ scene: particles, camera });
    };

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
    const canvas = gl.canvas;
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    animationFrameId = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
      // Listeners come off before loseContext, or handleContextRestored would
      // fire during teardown and rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      if (moveParticlesOnHover) {
        container.removeEventListener('mousemove', handleMouseMove);
      }
      program.remove();
      geometry.remove();
      if (container.contains(canvas)) {
        container.removeChild(canvas);
      }
      // A dropped reference does not free the context: WebKit only returns the
      // slot when the object is destroyed, and the page hits the 16-context cap
      // long before GC gets there.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    particleCount,
    particleSpread,
    speed,
    moveParticlesOnHover,
    particleHoverFactor,
    alphaParticles,
    particleBaseSize,
    sizeRandomness,
    cameraDistance,
    disableRotation,
    pixelRatio,
    glGeneration
  ]);

  return <div ref={containerRef} className={`relative w-full h-full ${className}`} />;
};

export default Particles;

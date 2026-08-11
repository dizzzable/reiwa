import { useCallback, useRef, useState, useEffect, forwardRef, RefObject } from 'react';
import { Canvas, useFrame, useThree, ThreeEvent, RootState } from '@react-three/fiber';
import { EffectComposer, wrapEffect } from '@react-three/postprocessing';
import { Effect, type EffectComposer as EffectComposerImpl } from 'postprocessing';
import * as THREE from 'three';

import { BudgetedDpr, type FiberDpr } from './fiber-render-scale';

/** What the Canvas asked for before the device-pixel budget. */
const BASE_DPR: FiberDpr = 1;

/**
 * Delete the GPU objects hanging off a scene before the context that owns them
 * goes away. Losing the context frees the driver allocations but leaves every
 * three.js wrapper — geometry buffers, material programs — attached to the
 * renderer's internal maps.
 */
const releaseSceneResources = (scene: THREE.Object3D): void => {
  scene.traverse(object => {
    const mesh = object as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
};

const waveVertexShader = `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 modelPosition = modelMatrix * vec4(position, 1.0);
  vec4 viewPosition = viewMatrix * modelPosition;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const waveFragmentShader = `
precision highp float;
uniform vec2 resolution;
uniform float time;
uniform float waveSpeed;
uniform float waveFrequency;
uniform float waveAmplitude;
uniform vec3 waveColor;
uniform vec2 mousePos;
uniform int enableMouseInteraction;
uniform float mouseRadius;

vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fade_xy = fade(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
}

const int OCTAVES = 4;
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  float freq = waveFrequency;
  for (int i = 0; i < OCTAVES; i++) {
    value += amp * abs(cnoise(p));
    p *= freq;
    amp *= waveAmplitude;
  }
  return value;
}

float pattern(vec2 p) {
  vec2 p2 = p - time * waveSpeed;
  return fbm(p + fbm(p2)); 
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  uv -= 0.5;
  uv.x *= resolution.x / resolution.y;
  float f = pattern(uv);
  if (enableMouseInteraction == 1) {
    vec2 mouseNDC = (mousePos / resolution - 0.5) * vec2(1.0, -1.0);
    mouseNDC.x *= resolution.x / resolution.y;
    float dist = length(uv - mouseNDC);
    float effect = 1.0 - smoothstep(0.0, mouseRadius, dist);
    f -= 0.5 * effect;
  }
  vec3 col = mix(vec3(0.0), waveColor, f);
  gl_FragColor = vec4(col, 1.0);
}
`;

const ditherFragmentShader = `
precision highp float;
uniform float colorNum;
uniform float pixelSize;
const float bayerMatrix8x8[64] = float[64](
  0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0,  3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
  32.0/64.0,16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0,19.0/64.0, 47.0/64.0, 31.0/64.0,
  8.0/64.0, 56.0/64.0,  4.0/64.0, 52.0/64.0, 11.0/64.0,59.0/64.0,  7.0/64.0, 55.0/64.0,
  40.0/64.0,24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0,27.0/64.0, 39.0/64.0, 23.0/64.0,
  2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0,  1.0/64.0,49.0/64.0, 13.0/64.0, 61.0/64.0,
  34.0/64.0,18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0,17.0/64.0, 45.0/64.0, 29.0/64.0,
  10.0/64.0,58.0/64.0,  6.0/64.0, 54.0/64.0,  9.0/64.0,57.0/64.0,  5.0/64.0, 53.0/64.0,
  42.0/64.0,26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0,25.0/64.0, 37.0/64.0, 21.0/64.0
);

vec3 dither(vec2 uv, vec3 color) {
  vec2 scaledCoord = floor(uv * resolution / pixelSize);
  int x = int(mod(scaledCoord.x, 8.0));
  int y = int(mod(scaledCoord.y, 8.0));
  float threshold = bayerMatrix8x8[y * 8 + x] - 0.25;
  float step = 1.0 / (colorNum - 1.0);
  color += threshold * step;
  float bias = 0.2;
  color = clamp(color - bias, 0.0, 1.0);
  return floor(color * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);
}

void mainImage(in vec4 inputColor, in vec2 uv, out vec4 outputColor) {
  vec2 normalizedPixelSize = pixelSize / resolution;
  vec2 uvPixel = normalizedPixelSize * floor(uv / normalizedPixelSize);
  vec4 color = texture2D(inputBuffer, uvPixel);
  color.rgb = dither(uv, color.rgb);
  outputColor = color;
}
`;

class RetroEffectImpl extends Effect {
  public uniforms: Map<string, THREE.Uniform<any>>;
  constructor() {
    const uniforms = new Map<string, THREE.Uniform<any>>([
      ['colorNum', new THREE.Uniform(4.0)],
      ['pixelSize', new THREE.Uniform(2.0)]
    ]);
    super('RetroEffect', ditherFragmentShader, { uniforms });
    this.uniforms = uniforms;
  }
  set colorNum(value: number) {
    this.uniforms.get('colorNum')!.value = value;
  }
  get colorNum(): number {
    return this.uniforms.get('colorNum')!.value;
  }
  set pixelSize(value: number) {
    this.uniforms.get('pixelSize')!.value = value;
  }
  get pixelSize(): number {
    return this.uniforms.get('pixelSize')!.value;
  }
}

// Hoisted out of the component body on purpose. wrapEffect() mints a new
// component type on every call, so building it during render made React unmount
// and remount the effect on each re-render — a fresh RetroEffectImpl, a fresh
// compiled pass in the composer, and the previous ones left behind.
const WrappedRetroEffect = wrapEffect(RetroEffectImpl);

const RetroEffect = forwardRef<RetroEffectImpl, { colorNum: number; pixelSize: number }>((props, ref) => {
  const { colorNum, pixelSize } = props;
  return <WrappedRetroEffect ref={ref} colorNum={colorNum} pixelSize={pixelSize} />;
});

RetroEffect.displayName = 'RetroEffect';

interface WaveUniforms {
  [key: string]: THREE.Uniform<any>;
  time: THREE.Uniform<number>;
  resolution: THREE.Uniform<THREE.Vector2>;
  waveSpeed: THREE.Uniform<number>;
  waveFrequency: THREE.Uniform<number>;
  waveAmplitude: THREE.Uniform<number>;
  waveColor: THREE.Uniform<THREE.Color>;
  mousePos: THREE.Uniform<THREE.Vector2>;
  enableMouseInteraction: THREE.Uniform<number>;
  mouseRadius: THREE.Uniform<number>;
}

interface DitheredWavesProps {
  waveSpeed: number;
  waveFrequency: number;
  waveAmplitude: number;
  waveColor: [number, number, number];
  colorNum: number;
  pixelSize: number;
  disableAnimation: boolean;
  enableMouseInteraction: boolean;
  mouseRadius: number;
  composerRef: RefObject<EffectComposerImpl | null>;
}

function DitheredWaves({
  waveSpeed,
  waveFrequency,
  waveAmplitude,
  waveColor,
  colorNum,
  pixelSize,
  disableAnimation,
  enableMouseInteraction,
  mouseRadius,
  composerRef
}: DitheredWavesProps) {
  const mesh = useRef<THREE.Mesh>(null);
  const mouseRef = useRef(new THREE.Vector2());
  const { viewport, size, gl } = useThree();

  const waveUniformsRef = useRef<WaveUniforms>({
    time: new THREE.Uniform(0),
    resolution: new THREE.Uniform(new THREE.Vector2(0, 0)),
    waveSpeed: new THREE.Uniform(waveSpeed),
    waveFrequency: new THREE.Uniform(waveFrequency),
    waveAmplitude: new THREE.Uniform(waveAmplitude),
    waveColor: new THREE.Uniform(new THREE.Color(...waveColor)),
    mousePos: new THREE.Uniform(new THREE.Vector2(0, 0)),
    enableMouseInteraction: new THREE.Uniform(enableMouseInteraction ? 1 : 0),
    mouseRadius: new THREE.Uniform(mouseRadius)
  });

  // `viewport.dpr` rather than `gl.getPixelRatio()` alone: the device-pixel
  // budget lowers the ratio WITHOUT the measured box changing, and this effect
  // used to depend on `size` only — so the resolution uniform would have stayed
  // on the pre-budget value and the shader would have sampled a buffer that no
  // longer existed at that size. The two are the same number; the store one is
  // what re-runs this.
  const dpr = useThree(state => state.viewport.dpr);
  useEffect(() => {
    const newWidth = Math.floor(size.width * dpr);
    const newHeight = Math.floor(size.height * dpr);
    const currentRes = waveUniformsRef.current.resolution.value;
    if (currentRes.x !== newWidth || currentRes.y !== newHeight) {
      currentRes.set(newWidth, newHeight);
    }
  }, [size, dpr]);

  const prevColor = useRef([...waveColor]);
  useFrame(({ clock }) => {
    const u = waveUniformsRef.current;

    if (!disableAnimation) {
      u.time.value = clock.getElapsedTime();
    }

    if (u.waveSpeed.value !== waveSpeed) u.waveSpeed.value = waveSpeed;
    if (u.waveFrequency.value !== waveFrequency) u.waveFrequency.value = waveFrequency;
    if (u.waveAmplitude.value !== waveAmplitude) u.waveAmplitude.value = waveAmplitude;

    if (!prevColor.current.every((v, i) => v === waveColor[i])) {
      u.waveColor.value.set(...waveColor);
      prevColor.current = [...waveColor];
    }

    u.enableMouseInteraction.value = enableMouseInteraction ? 1 : 0;
    u.mouseRadius.value = mouseRadius;

    if (enableMouseInteraction) {
      u.mousePos.value.copy(mouseRef.current);
    }
  });

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!enableMouseInteraction) return;
    const rect = gl.domElement.getBoundingClientRect();
    const dpr = gl.getPixelRatio();
    mouseRef.current.set((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
  };

  return (
    <>
      <mesh ref={mesh} scale={[viewport.width, viewport.height, 1]}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          vertexShader={waveVertexShader}
          fragmentShader={waveFragmentShader}
          uniforms={waveUniformsRef.current}
        />
      </mesh>

      {/* `multisampling={0}`: @react-three/postprocessing defaults to an
          8-sample MSAA render target plus a resolve blit per frame. Same
          reasoning as `antialias: false` on the Canvas — one full-screen quad
          has no geometry edges to smooth, and RetroEffect re-quantises every
          pixel into deliberately chunky Bayer dithering anyway. */}
      <EffectComposer ref={composerRef} multisampling={0}>
        <RetroEffect colorNum={colorNum} pixelSize={pixelSize} />
      </EffectComposer>

      <mesh
        onPointerMove={handlePointerMove}
        position={[0, 0, 0.01]}
        scale={[viewport.width, viewport.height, 1]}
        visible={false}
      >
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>
    </>
  );
}

interface DitherProps {
  waveSpeed?: number;
  waveFrequency?: number;
  waveAmplitude?: number;
  waveColor?: [number, number, number];
  colorNum?: number;
  pixelSize?: number;
  disableAnimation?: boolean;
  enableMouseInteraction?: boolean;
  mouseRadius?: number;
}

export default function Dither({
  waveSpeed = 0.05,
  waveFrequency = 3,
  waveAmplitude = 0.3,
  waveColor = [0.5, 0.5, 0.5],
  colorNum = 4,
  pixelSize = 2,
  disableAnimation = false,
  enableMouseInteraction = true,
  mouseRadius = 1
}: DitherProps) {
  const rootRef = useRef<RootState | null>(null);
  const composerRef = useRef<EffectComposerImpl | null>(null);
  // The ratio and the factor it was reduced by, resolved once `BudgetedDpr`
  // has seen the box fiber measured. Both are needed: the ratio goes on the
  // `dpr` prop, and `pixelSize` — the one thing in this effect denominated in
  // BUFFER pixels — is multiplied by the scale so the Bayer blocks keep exactly
  // the size on screen the operator set. Without that compensation, capping the
  // buffer would coarsen the dither by 1/scale, which is a different picture
  // rather than a softer one.
  const [budget, setBudget] = useState<{ dpr: FiberDpr; scale: number }>({
    dpr: BASE_DPR,
    scale: 1
  });
  const handleResolve = useCallback((dpr: number, scale: number) => {
    setBudget(previous =>
      previous.dpr === dpr && previous.scale === scale ? previous : { dpr, scale }
    );
  }, []);

  // React Three Fiber does release the context on unmount, but from inside a
  // 500 ms setTimeout and without ever calling gl.dispose(). Half a second is
  // several slides of a carousel swipe, and WebKit allows only 16 live WebGL
  // contexts per web-content process before it starts recycling the oldest and
  // handing out an unrecoverable SyntheticLostContext. Release it here instead,
  // synchronously, while unmounting.
  useEffect(
    () => () => {
      const root = rootRef.current;
      const composer = composerRef.current;
      rootRef.current = null;
      composerRef.current = null;
      // The composer owns render targets — framebuffers and their textures —
      // that @react-three/postprocessing never frees, so it goes first.
      composer?.dispose();
      if (root === null) return;
      releaseSceneResources(root.scene);
      // dispose() detaches THREE.WebGLRenderer's own webglcontextlost /
      // webglcontextrestored listeners, so the loss below cannot re-enter the
      // restore path and rebuild what we are freeing.
      root.gl.dispose();
      root.gl.forceContextLoss();
    },
    []
  );

  return (
    /**
     * `resize={{ offsetSize: true }}` — measure the LAYOUT box, not the painted one.
     *
     * fiber sizes itself from react-use-measure, whose default is
     * getBoundingClientRect(): TRANSFORMED geometry. That measurement is then
     * written straight back into `canvas.style.width/height`, which is a LAYOUT
     * property — so under any ancestor transform fiber scales the canvas by the
     * transform and the browser then scales it again. `offsetSize` swaps
     * width/height for offsetWidth/offsetHeight, which a transform cannot see,
     * and makes fiber's measure-then-style loop self-consistent — for this
     * canvas and for the composer's render targets, which track the renderer's
     * size. The panel's preview tiles carry `hover:scale-[1.03]`, and
     * react-use-measure re-measures on scroll, so this is reachable rather than
     * theoretical. Everywhere else it changes nothing: with no transform above,
     * the layout box and the painted box are the same box.
     *
     * One inexactness, stated because it is real: offsetWidth/offsetHeight are
     * the border box ROUNDED to whole pixels, so on a fractional layout box the
     * canvas's inline CSS size can land up to half a pixel off the container;
     * fiber's wrapper is `overflow: hidden`, so that shows as at most a
     * sub-pixel edge.
     *
     * `dpr` is state rather than the literal `1` so the device-pixel budget can
     * lower it — see `fiber-render-scale.tsx`.
     */
    <Canvas
      className="w-full h-full relative"
      camera={{ position: [0, 0, 6] }}
      dpr={budget.dpr}
      resize={{ offsetSize: true }}
      // `preserveDrawingBuffer: false`: the `true` it replaced forced the
      // browser to copy the full drawing buffer every frame instead of
      // flipping it, and NOTHING reads the buffer back — no
      // toDataURL/readPixels/captureStream caller for this canvas exists in
      // either repository. This used to be argued through the card layer's
      // paint-evidence sampler, which returned before touching a shader canvas
      // anyway; that sampler has since been deleted from reiwa outright, so
      // the one reader the argument had to reason around no longer exists at
      // all. The conclusion is unchanged and now has one fewer thing holding
      // it up.
      // `antialias: false`: MSAA smooths geometry edges, and this scene is a
      // single full-screen quad with none; the RetroEffect pass then
      // re-quantises every pixel to a Bayer-dithered palette whose whole point
      // is chunky pixels. The default framebuffer's MSAA storage bought
      // nothing visible.
      gl={{ antialias: false, preserveDrawingBuffer: false }}
      onCreated={state => {
        rootRef.current = state;
      }}
    >
      <BudgetedDpr base={BASE_DPR} onResolve={handleResolve} />
      <DitheredWaves
        composerRef={composerRef}
        waveSpeed={waveSpeed}
        waveFrequency={waveFrequency}
        waveAmplitude={waveAmplitude}
        waveColor={waveColor}
        colorNum={colorNum}
        // In buffer pixels. `budget.scale` is 1 for every card and every phone,
        // so this is bit-identical there; where the buffer is capped it keeps
        // the blocks the same size on screen instead of magnifying them.
        pixelSize={pixelSize * budget.scale}
        disableAnimation={disableAnimation}
        enableMouseInteraction={enableMouseInteraction}
        mouseRadius={mouseRadius}
      />
    </Canvas>
  );
}

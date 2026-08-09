import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { Canvas, useFrame, useThree, RootState } from '@react-three/fiber';
import { Color, Mesh, Object3D, ShaderMaterial } from 'three';
import { IUniform } from 'three';

import { BudgetedDpr, type FiberDpr } from './fiber-render-scale';

/**
 * Delete the GPU objects hanging off a scene before the context that owns them
 * goes away. Losing the context frees the driver allocations but leaves every
 * three.js wrapper — geometry buffers, material programs — attached to the
 * renderer's internal maps.
 */
const releaseSceneResources = (scene: Object3D): void => {
  scene.traverse(object => {
    const mesh = object as Partial<Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
};

type NormalizedRGB = [number, number, number];

const hexToNormalizedRGB = (hex: string): NormalizedRGB => {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
};

interface UniformValue<T = number | Color> {
  value: T;
}

interface SilkUniforms {
  uSpeed: UniformValue<number>;
  uScale: UniformValue<number>;
  uNoiseIntensity: UniformValue<number>;
  uColor: UniformValue<Color>;
  uRotation: UniformValue<number>;
  uTime: UniformValue<number>;
  [uniform: string]: IUniform;
}

const vertexShader = `
varying vec2 vUv;
varying vec3 vPosition;

void main() {
  vPosition = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
varying vec2 vUv;
varying vec3 vPosition;

uniform float uTime;
uniform vec3  uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;

const float e = 2.71828182845904523536;

float noise(vec2 texCoord) {
  float G = e;
  vec2  r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}

vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2  rot = mat2(c, -s, s, c);
  return rot * uv;
}

void main() {
  float rnd        = noise(gl_FragCoord.xy);
  vec2  uv         = rotateUvs(vUv * uScale, uRotation);
  vec2  tex        = uv * uScale;
  float tOffset    = uSpeed * uTime;

  tex.y += 0.03 * sin(8.0 * tex.x - tOffset);

  float pattern = 0.6 +
                  0.4 * sin(5.0 * (tex.x + tex.y +
                                   cos(3.0 * tex.x + 5.0 * tex.y) +
                                   0.02 * tOffset) +
                           sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));

  vec4 col = vec4(uColor, 1.0) * vec4(pattern) - rnd / 15.0 * uNoiseIntensity;
  col.a = 1.0;
  gl_FragColor = col;
}
`;

interface SilkPlaneProps {
  uniforms: SilkUniforms;
}

const SilkPlane = forwardRef<Mesh, SilkPlaneProps>(function SilkPlane({ uniforms }, ref) {
  const { viewport } = useThree();

  useLayoutEffect(() => {
    const mesh = ref as React.MutableRefObject<Mesh | null>;
    if (mesh.current) {
      mesh.current.scale.set(viewport.width, viewport.height, 1);
    }
  }, [ref, viewport]);

  useFrame((_state: RootState, delta: number) => {
    const mesh = ref as React.MutableRefObject<Mesh | null>;
    if (mesh.current) {
      const material = mesh.current.material as ShaderMaterial & {
        uniforms: SilkUniforms;
      };
      material.uniforms.uTime.value += 0.1 * delta;
    }
  });

  return (
    <mesh ref={ref}>
      <planeGeometry args={[1, 1, 1, 1]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
    </mesh>
  );
});
SilkPlane.displayName = 'SilkPlane';

export interface SilkProps {
  speed?: number;
  scale?: number;
  color?: string;
  noiseIntensity?: number;
  rotation?: number;
}

const BASE_DPR: FiberDpr = [1, 2];

const Silk: React.FC<SilkProps> = ({ speed = 5, scale = 1, color = '#7B7481', noiseIntensity = 1.5, rotation = 0 }) => {
  const meshRef = useRef<Mesh>(null);
  const rootRef = useRef<RootState | null>(null);
  // Starts as the clamp fiber would have used on its own and becomes the
  // budgeted number once `BudgetedDpr` has seen the measured box.
  const [dpr, setDpr] = useState<FiberDpr>(BASE_DPR);
  const handleResolve = useCallback((resolved: number) => {
    setDpr(previous => (previous === resolved ? previous : resolved));
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
      rootRef.current = null;
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

  const uniforms = useMemo<SilkUniforms>(
    () => ({
      uSpeed: { value: speed },
      uScale: { value: scale },
      uNoiseIntensity: { value: noiseIntensity },
      uColor: { value: new Color(...hexToNormalizedRGB(color)) },
      uRotation: { value: rotation },
      uTime: { value: 0 }
    }),
    [speed, scale, noiseIntensity, color, rotation]
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
     * and makes fiber's measure-then-style loop self-consistent. The panel's
     * preview tiles carry `hover:scale-[1.03]`, and react-use-measure
     * re-measures on scroll, so this is reachable rather than theoretical.
     * Everywhere else it changes nothing: with no transform above, the layout
     * box and the painted box are the same box.
     *
     * One inexactness, stated because it is real: offsetWidth/offsetHeight are
     * the border box ROUNDED to whole pixels, so on a fractional layout box the
     * canvas's inline CSS size can land up to half a pixel off the container.
     * fiber's wrapper is `overflow: hidden`, so that shows as at most a
     * sub-pixel edge; the drawing buffer stays 1:1 with what it presents into.
     *
     * `dpr` is state rather than the literal `[1, 2]` so the device-pixel
     * budget can lower it — see `fiber-render-scale.tsx`.
     */
    <Canvas
      dpr={dpr}
      frameloop="always"
      resize={{ offsetSize: true }}
      onCreated={state => {
        rootRef.current = state;
      }}
    >
      <BudgetedDpr base={BASE_DPR} onResolve={handleResolve} />
      <SilkPlane ref={meshRef} uniforms={uniforms} />
    </Canvas>
  );
};

export default Silk;

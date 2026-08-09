import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import { resolveBufferRatio } from '../render-scale';

/**
 * Particlesphere — a sphere of glowing particles that scatter from the cursor.
 *
 * Ported from Originkit `particlesphere` (preset `base`). three.js: an
 * InstancedMesh of tiny additive spheres on a Fibonacci distribution, spun by
 * an autonomous loop and pushed around by the cursor.
 *
 * Three things from the source are gone on purpose:
 *  - every `touch*` listener. They were registered `{ passive: false }` and
 *    called `preventDefault()`, so a swipe starting on the card would not
 *    scroll the page. The sphere auto-spins (`stopOnHover` is false), so it
 *    never needed them.
 *  - the `document`-level mousemove/mouseup drag pair, replaced with pointer
 *    capture on the canvas.
 *  - the inlined `RenderTarget` shim, which hard-coded "preview" and made the
 *    whole canvas-mode branch (and its zoom probe) unreachable.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse `#rgb[a]` / `#rrggbb[aa]` / `rgb()` / `rgba()` into 0..1 channels. */
function parseColorToRgba(input: string): Rgba {
  const str = (input || '').trim();
  if (!str) return { r: 1, g: 1, b: 1, a: 1 };

  const rgbaMatch = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (rgbaMatch) {
    return {
      r: Math.max(0, Math.min(255, parseFloat(rgbaMatch[1]))) / 255,
      g: Math.max(0, Math.min(255, parseFloat(rgbaMatch[2]))) / 255,
      b: Math.max(0, Math.min(255, parseFloat(rgbaMatch[3]))) / 255,
      a: rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4]))) : 1
    };
  }

  const hex = str.replace(/^#/, '');
  const at = (i: number, len: number) => (len === 3 || len === 4 ? hex[i] + hex[i] : hex.slice(i * 2, i * 2 + 2));
  if (hex.length === 3 || hex.length === 4 || hex.length === 6 || hex.length === 8) {
    const len = hex.length;
    const hasAlpha = len === 4 || len === 8;
    const r = parseInt(at(0, len), 16) / 255;
    const g = parseInt(at(1, len), 16) / 255;
    const b = parseInt(at(2, len), 16) / 255;
    const a = hasAlpha ? parseInt(at(3, len), 16) / 255 : 1;
    if ([r, g, b, a].every(n => Number.isFinite(n))) return { r, g, b, a };
  }
  return { r: 1, g: 1, b: 1, a: 1 };
}

function mapLinear(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/**
 * Wall-clock seconds.
 *
 * The loop's own `elapsed` is a frame-clamped accumulator — a frame is worth at
 * most 3/60 s of it however long it really took — so `elapsed` runs slow
 * whenever the device does. That is right for the drift path, whose speed
 * should follow the animation, and wrong for anything measuring how long a
 * person has been doing something: at 5 fps three of its seconds are about
 * twelve real ones.
 */
const wallSeconds = () => performance.now() / 1000;

/** Displacement decay. */
const RETURN_FORCE = 0.015;
const FRICTION = 0.94;

/** Sphere geometry detail. Each particle is a few pixels across on a card, so
 *  the source's 8x8 buys nothing and costs nearly twice the triangles. */
const PARTICLE_SEGMENTS = 6;

/** Seconds a hand-over between a real pointer and the autopilot takes. */
const AUTOPILOT_BLEND = 1.5;

/** Seconds the field holds at the release point before it drifts off. */
const AUTOPILOT_DWELL = 0.4;

/**
 * Seconds of silence after which a pointer counts as gone even though no
 * `pointerleave` ever arrived. It does not always arrive — the webview takes
 * over a swipe, a sheet is dismissed mid-touch — and without this both the
 * repulsion field and `stopOnHover` stay latched on the last touched point for
 * the life of the mount: the field never moves again and the sphere never turns
 * again.
 *
 * Measured on the wall clock, and only against a touch or pen. A mouse gets its
 * `pointerleave`, and a mouse that is merely resting still — which reports
 * nothing at all — is a pointer that IS there. Timing that one out cleared
 * `hovering` under a stationary cursor, so `stopOnHover` stopped holding the
 * spin after three seconds of a hover that had not ended.
 */
const POINTER_STALE_S = 3;

interface SphereConfig {
  particlesCount: number;
  particleSize: number;
  scaleMultiplier: number;
  rotationSpeed: number;
  speedN: number;
  smoothingN: number;
  dragN: number;
  drag: boolean;
  stopOnHover: boolean;
  cursorOn: boolean;
  cursorRadius: number;
  cursorStrength: number;
  clickForce: number;
  sphereColor: string;
  autoplay: boolean;
}

interface SphereApi {
  rebuild: () => void;
  dispose: () => void;
}

function createSphere(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  cfgRef: { current: SphereConfig }
): SphereApi {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const group = new THREE.Group();
  scene.add(group);

  let mesh: THREE.InstancedMesh | null = null;
  let geometry: THREE.SphereGeometry | null = null;
  let material: THREE.MeshBasicMaterial | null = null;

  // Flat buffers rather than arrays of Vector3: the source allocated three
  // Vector3 per particle up front and several more per particle per frame,
  // which at any real particle count is most of a frame spent in the GC.
  let count = 0;
  let basePos = new Float32Array(0);
  let disp = new Float32Array(0);
  let scatterVel = new Float32Array(0);

  // Scratch objects, reused every frame.
  const matrix = new THREE.Matrix4();
  const inverseGroup = new THREE.Matrix4();
  /** local -> clip, the three per-particle matrix products folded into one. */
  const localToClip = new THREE.Matrix4();
  const cameraRight = new THREE.Vector3();
  const cameraUp = new THREE.Vector3();
  const localRight = new THREE.Vector3();
  const localUp = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const projectedPos = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  let canvasWidth = 1;
  let canvasHeight = 1;

  function releaseBuild() {
    if (mesh) {
      group.remove(mesh);
      mesh.dispose();
      mesh = null;
    }
    if (geometry) {
      geometry.dispose();
      geometry = null;
    }
    if (material) {
      material.dispose();
      material = null;
    }
  }

  function build() {
    const cfg = cfgRef.current;
    releaseBuild();

    count = Math.max(1, Math.round(cfg.particlesCount));
    basePos = new Float32Array(count * 3);
    disp = new Float32Array(count * 3);
    scatterVel = new Float32Array(count * 3);

    // Fibonacci sphere: even spacing without clustering at the poles.
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const sphereRadius = 1 * cfg.scaleMultiplier;
    for (let i = 0; i < count; i++) {
      const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = goldenAngle * i;
      basePos[i * 3] = Math.cos(theta) * ring * sphereRadius;
      basePos[i * 3 + 1] = y * sphereRadius;
      basePos[i * 3 + 2] = Math.sin(theta) * ring * sphereRadius;
    }

    const rgba = parseColorToRgba(cfg.sphereColor);
    geometry = new THREE.SphereGeometry(cfg.particleSize * 0.15, PARTICLE_SEGMENTS, PARTICLE_SEGMENTS);
    material = new THREE.MeshBasicMaterial({
      // Every instance shared one colour in the source, so a per-instance
      // colour attribute was buffer for nothing.
      color: new THREE.Color(rgba.r, rgba.g, rgba.b),
      blending: THREE.AdditiveBlending,
      transparent: rgba.a < 1,
      opacity: rgba.a
    });

    mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      matrix.setPosition(basePos[i * 3], basePos[i * 3 + 1], basePos[i * 3 + 2]);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);

    // The camera must stay outside the sphere whatever `scale` says.
    camera.position.z = Math.max(3, sphereRadius + 1);
    syncCamera();
  }

  /** Keep the matrices the projection maths reads valid before the first render. */
  function syncCamera() {
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    canvasWidth = Math.max(1, rect.width);
    canvasHeight = Math.max(1, rect.height);
    // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
    // moves; the element keeps the size CSS gave it, and the context
    // transform below still maps CSS units into it — so every feature this
    // effect draws keeps the size the operator configured, at a lower
    // sampling density. See `render-scale.ts`.
    // three.js `setPixelRatio` multiplies the buffer only, and `setSize(w, h,
    // false)` is already told not to write the canvas style at all.
    renderer.setPixelRatio(
      resolveBufferRatio(canvasWidth, canvasHeight, Math.min(window.devicePixelRatio || 1, 2))
    );
    renderer.setSize(canvasWidth, canvasHeight, false);
    camera.aspect = canvasWidth / canvasHeight;
    camera.updateProjectionMatrix();
    syncCamera();
  }
  const observer = new ResizeObserver(resize);

  /* ---------------------------------------- input */
  // Canvas-scoped only. No touch listeners at all, nothing passive:false, and
  // no preventDefault anywhere — a swipe that starts here still scrolls.
  let pointer: { x: number; y: number } | null = null;
  /** Wall-clock seconds of the last pointer event, for `POINTER_STALE_S`. */
  let pointerAt = -1e9;
  /** Was the last pointer a touch or pen? Only those are timed out. */
  let pointerCoarse = false;
  let hovering = false;
  let dragging = false;
  let activePointer = -1;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let lastDragTime = 0;
  let elapsed = 0;

  const rotation = { x: 0, y: 0 };
  const targetRotation = { x: 0, y: 0 };
  const velocity = { x: 0, y: 0 };

  const trackPointer = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
      pointer = { x, y };
      pointerAt = wallSeconds();
      pointerCoarse = e.pointerType !== 'mouse';
    } else {
      pointer = null;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!cfgRef.current.drag) return;
    dragging = true;
    activePointer = e.pointerId;
    velocity.x = 0;
    velocity.y = 0;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    lastDragTime = performance.now();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience; without it the drag simply stops at the edge.
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    trackPointer(e);
    if (!dragging || e.pointerId !== activePointer) return;
    const cfg = cfgRef.current;
    const now = performance.now();
    const sinceLast = now - lastDragTime;
    const sensitivity = mapLinear(cfg.dragN, 0, 1, 0.001, 0.02);
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;

    targetRotation.x += dx * sensitivity;
    targetRotation.y = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetRotation.y + dy * sensitivity));

    if (sinceLast > 0) {
      const norm = (1000 / 60) / sinceLast;
      velocity.x = dx * sensitivity * 0.3 * norm;
      velocity.y = dy * sensitivity * 0.3 * norm;
    }
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    lastDragTime = now;
  };

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== activePointer) return;
    dragging = false;
    activePointer = -1;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };

  const onPointerEnter = (e: PointerEvent) => {
    hovering = true;
    // Stamped here too so `hovering` ages out on the same clock as `pointer`.
    pointerAt = wallSeconds();
    pointerCoarse = e.pointerType !== 'mouse';
  };
  const onPointerLeave = (e: PointerEvent) => {
    hovering = false;
    pointer = null;
    endDrag(e);
  };

  /** A burst that throws nearby particles outward from a screen point. */
  function scatterFrom(screenX: number, screenY: number) {
    const cfg = cfgRef.current;
    if (!cfg.cursorOn || !cfg.clickForce || !mesh) return;
    group.updateMatrixWorld(true);
    inverseGroup.copy(group.matrixWorld).invert();

    const radiusSq = cfg.cursorRadius * cfg.cursorRadius;
    const ndcX = (screenX / canvasWidth) * 2 - 1;
    const ndcY = 1 - (screenY / canvasHeight) * 2;

    // Where the burst sits in the world: along the ray through the click, at
    // the distance of the sphere's centre. Runs once per click, so the few
    // vectors here are not on the per-frame path.
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const dir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camPos).normalize();
    const burst = camPos.clone().addScaledVector(dir, camPos.length());

    for (let i = 0; i < count; i++) {
      const at = i * 3;
      worldPos.set(basePos[at] + disp[at], basePos[at + 1] + disp[at + 1], basePos[at + 2] + disp[at + 2]);
      worldPos.applyMatrix4(group.matrixWorld);
      projectedPos.copy(worldPos).project(camera);
      const sx = (projectedPos.x * 0.5 + 0.5) * canvasWidth;
      const sy = (-projectedPos.y * 0.5 + 0.5) * canvasHeight;
      const dx = screenX - sx;
      const dy = screenY - sy;
      const distSq = dx * dx + dy * dy;
      if (distSq >= radiusSq || distSq <= 0) continue;

      const force = ((cfg.cursorRadius - Math.sqrt(distSq)) / cfg.cursorRadius) * cfg.clickForce;
      // Radial, away from the burst point. `scratch` is free here.
      scratch.subVectors(worldPos, burst);
      if (scratch.length() <= 0.001) continue;
      scratch.normalize().multiplyScalar(force * 0.5).applyMatrix4(inverseGroup);
      scatterVel[at] += scratch.x;
      scatterVel[at + 1] += scratch.y;
      scatterVel[at + 2] += scratch.z;
    }
  }

  const onClick = (e: MouseEvent) => {
    const rect = container.getBoundingClientRect();
    scatterFrom(e.clientX - rect.left, e.clientY - rect.top);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerenter', onPointerEnter);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);

  /* ---------------------------------------- loop */
  let frame = 0;
  let lastFrameTime = performance.now();

  /* ---------------------------------------- autopilot hand-over */
  // Where the repulsion field actually sat last frame, and the hand-over it is
  // easing through. Keeping the field's own position is what makes the ease
  // work in BOTH directions: whichever side takes over, it is eased in from
  // where the field is, never from where it is going.
  let fieldX = 0;
  let fieldY = 0;
  let fieldLive = false;
  let handoffX = 0;
  let handoffY = 0;
  let handoffAt = -1e9;
  let handoffToPointer = false;

  /**
   * Where the repulsion field sits this frame. On a phone no pointer is ever
   * coming, so the field is walked along two sine pairs of incommensurable
   * periods, and it changes hands with a real pointer over `AUTOPILOT_BLEND`.
   *
   * The blend used to be computed and then thrown away. `since` was forced to 0
   * whenever a pointer existed, so `blend` was 0 on every frame a pointer was
   * over the card; and with no pointer the function returned the synthetic
   * point before it reached the blended line at all. So neither branch ever
   * applied it: the field jumped from the finger to the drifted synthetic point
   * in one frame, and jumped back on the next move — two hard shoves of the
   * whole particle field per latch cycle.
   */
  function resolveCursor(cfg: SphereConfig, t: number, wall: number): { x: number; y: number } | null {
    if (!cfg.autoplay) {
      // Nothing to hand over to. Re-arm, so turning autoplay back on starts a
      // fresh hand-over rather than easing out of a position from minutes ago.
      fieldLive = false;
      return pointer;
    }

    const sx = canvasWidth * (0.5 + 0.34 * Math.sin(t * 0.27) + 0.12 * Math.sin(t * 0.63 + 1.7));
    const sy = canvasHeight * (0.5 + 0.3 * Math.sin(t * 0.41 + 2.2) + 0.11 * Math.sin(t * 0.19));
    const live = pointer;
    const toPointer = live !== null;

    if (!fieldLive) {
      // First frame: there is no previous position to ease out of, so the field
      // simply starts where it belongs.
      fieldLive = true;
      handoffToPointer = toPointer;
      handoffAt = -1e9;
    } else if (toPointer !== handoffToPointer) {
      handoffX = fieldX;
      handoffY = fieldY;
      handoffAt = wall;
      handoffToPointer = toPointer;
    }

    // Letting go dwells first, so a finger lifted for a single frame does not
    // send the field wandering. Being taken over is picked up at once.
    const dwell = toPointer ? 0 : AUTOPILOT_DWELL;
    const blend = Math.max(0, Math.min(1, (wall - handoffAt - dwell) / AUTOPILOT_BLEND));
    const targetX = live ? live.x : sx;
    const targetY = live ? live.y : sy;
    fieldX = handoffX + (targetX - handoffX) * blend;
    fieldY = handoffY + (targetY - handoffY) * blend;
    return { x: fieldX, y: fieldY };
  }

  function step() {
    frame = requestAnimationFrame(step);
    const cfg = cfgRef.current;
    if (!mesh) return;

    const now = performance.now();
    const deltaFactor = Math.min((now - lastFrameTime) / (1000 / 60), 3);
    lastFrameTime = now;
    elapsed += deltaFactor / 60;
    const t = elapsed;
    const wall = now / 1000;

    // A touch that stopped reporting without ever leaving counts as gone, so
    // the autopilot and the rotation always come back. Guarded three ways, all
    // of which the unguarded version got wrong: it ran before anything had ever
    // hovered (`pointerAt` starts at -1e9, so it fired on frame one), it ran
    // against a resting mouse, and it read the frame-clamped `elapsed`.
    if (pointerCoarse && (pointer !== null || hovering) && wall - pointerAt > POINTER_STALE_S) {
      pointer = null;
      hovering = false;
    }

    const threshold = 0.01;
    const lerpFactor = cfg.smoothingN === 0 ? 1 : mapLinear(cfg.smoothingN, 0, 1, 0.4, 0.03);
    const velocityDecay = mapLinear(cfg.smoothingN, 0, 1, 0.7, 0.96);

    if (!dragging && cfg.rotationSpeed !== 0 && (!cfg.stopOnHover || !hovering)) {
      targetRotation.x += cfg.rotationSpeed * 0.1 * deltaFactor;
    }

    if (!dragging && cfg.smoothingN > 0) {
      if (Math.abs(velocity.x) > threshold || Math.abs(velocity.y) > threshold) {
        targetRotation.x += velocity.x * deltaFactor;
        targetRotation.y = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetRotation.y + velocity.y * deltaFactor));
        const decay = Math.pow(velocityDecay, deltaFactor);
        velocity.x *= decay;
        velocity.y *= decay;
      } else {
        velocity.x = 0;
        velocity.y = 0;
      }
    }

    const timeLerp = 1 - Math.pow(1 - lerpFactor, deltaFactor);
    rotation.x += (targetRotation.x - rotation.x) * timeLerp;
    rotation.y = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotation.y + (targetRotation.y - rotation.y) * timeLerp));

    group.rotation.y = rotation.x;
    group.rotation.x = rotation.y;
    group.updateMatrixWorld(true);

    if (cfg.cursorOn) {
      const cursor = resolveCursor(cfg, t, wall);
      // Invariant for the whole particle loop — the source rebuilt all three
      // of these per particle, per frame.
      inverseGroup.copy(group.matrixWorld).invert();
      cameraRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      cameraUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      localRight.copy(cameraRight).applyMatrix4(inverseGroup);
      localUp.copy(cameraUp).applyMatrix4(inverseGroup);

      const radiusSq = cfg.cursorRadius * cfg.cursorRadius;
      const frictionFactor = Math.pow(FRICTION, deltaFactor);
      const returnForce = RETURN_FORCE * cfg.speedN * deltaFactor;
      const decay = frictionFactor * (1 - returnForce);

      // `autoplay` hands back a synthetic cursor whenever no real one exists,
      // which is always on a phone — so this branch, which used to be skipped
      // entirely on a device with no pointer, now runs for every particle every
      // frame. Defaults are 2500 particles and the slider reaches 4000.
      //
      // Two things make that affordable without changing the result. The three
      // matrix products the source applied per particle — local->world, then
      // world->view, then view->clip inside `project` — are the same three
      // matrices for the whole frame, so fold them into one here. And the
      // front-layer test was evaluated LAST, after all of that work; it only
      // needs the world-z row of `group.matrixWorld`, four multiplies, so it
      // goes first and rejects roughly half the sphere before anything else.
      if (!cursor) {
        // No cursor at all: nothing to project, just let the field relax. This
        // is the path an unattended phone used to take before `autoplay`.
        for (let k = 0; k < disp.length; k++) disp[k] *= decay;
      } else {
        const m = localToClip
          .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
          .multiply(group.matrixWorld).elements;
        const gw = group.matrixWorld.elements;
        const halfW = canvasWidth * 0.5;
        const halfH = canvasHeight * 0.5;
        const cursorX = cursor.x;
        const cursorY = cursor.y;

        for (let i = 0; i < count; i++) {
          const at = i * 3;
          const lx = basePos[at] + disp[at];
          const ly = basePos[at + 1] + disp[at + 1];
          const lz = basePos[at + 2] + disp[at + 2];
          // Only the front layer reacts; the back keeps rotating untouched.
          // `group.matrixWorld` is affine, so this is the whole of `worldPos.z`.
          if (gw[2] * lx + gw[6] * ly + gw[10] * lz + gw[14] > 0) {
            const cw = m[3] * lx + m[7] * ly + m[11] * lz + m[15];
            if (cw !== 0) {
              const sx = ((m[0] * lx + m[4] * ly + m[8] * lz + m[12]) / cw) * halfW + halfW;
              const sy = -((m[1] * lx + m[5] * ly + m[9] * lz + m[13]) / cw) * halfH + halfH;
              const dx = cursorX - sx;
              const dy = cursorY - sy;
              const distSq = dx * dx + dy * dy;
              if (distSq < radiusSq && distSq > 0) {
                const distance = Math.sqrt(distSq);
                const force = (cfg.cursorRadius - distance) / cfg.cursorRadius;
                const angle = Math.atan2(dy, dx);
                const push = force * cfg.cursorStrength * cfg.speedN * deltaFactor * 0.01;
                const rx = -Math.cos(angle) * push;
                const ry = Math.sin(angle) * push;
                disp[at] += localRight.x * rx + localUp.x * ry;
                disp[at + 1] += localRight.y * rx + localUp.y * ry;
                disp[at + 2] += localRight.z * rx + localUp.z * ry;
              }
            }
          }
          disp[at] *= decay;
          disp[at + 1] *= decay;
          disp[at + 2] *= decay;
        }
      }
    }

    // Scatter velocities spring the particles back where they belong.
    const scatterFriction = Math.pow(0.95, deltaFactor);
    const scatterReturn = 1 - RETURN_FORCE * cfg.speedN * deltaFactor;
    for (let i = 0; i < count; i++) {
      const at = i * 3;
      disp[at] += scatterVel[at] * deltaFactor * 0.1;
      disp[at + 1] += scatterVel[at + 1] * deltaFactor * 0.1;
      disp[at + 2] += scatterVel[at + 2] * deltaFactor * 0.1;
      const k = scatterFriction * scatterReturn;
      scatterVel[at] *= k;
      scatterVel[at + 1] *= k;
      scatterVel[at + 2] *= k;
    }

    for (let i = 0; i < count; i++) {
      const at = i * 3;
      matrix.setPosition(basePos[at] + disp[at], basePos[at + 1] + disp[at + 1], basePos[at + 2] + disp[at + 2]);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    renderer.render(scene, camera);
  }

  build();
  resize();
  observer.observe(container);
  frame = requestAnimationFrame(step);

  return {
    rebuild() {
      build();
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerenter', onPointerEnter);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('click', onClick);
      releaseBuild();
      scene.remove(group);
      scene.clear();
      basePos = new Float32Array(0);
      disp = new Float32Array(0);
      scatterVel = new Float32Array(0);
      count = 0;
      renderer.dispose();
      // Free the GL context at once; browsers cap how many can be open.
      renderer.forceContextLoss();
    }
  };
}

export interface ParticlesphereProps {
  /** Particles spread across the sphere. Lowered from the source's 10000. */
  particlesCount?: number;
  /** Size of each particle, 1..10. */
  particleScale?: number;
  /** Auto-spin direction. */
  rotationDirection?: 'clockwise' | 'anticlockwise';
  /** How fast the sphere auto-rotates. */
  speed?: number;
  /** Overall size of the sphere, 0..10. */
  scale?: number;
  /** Click-and-drag to rotate by hand. */
  drag?: boolean;
  /** Rotation easing and throw momentum, 0..10. */
  smoothing?: number;
  /** Drag sensitivity, 0..10. */
  dragSpeed?: number;
  /** Pauses auto-rotation while a cursor is over the card. */
  stopOnHover?: boolean;
  /** Cursor repulsion and click-scatter. */
  cursorOn?: boolean;
  /** Radius around the cursor that pushes particles, in px. */
  cursorRadius?: number;
  /** Force pushing particles from the cursor, 0..10. */
  cursorStrength?: number;
  /** Strength of the burst that scatters particles on click. */
  clickForce?: number;
  /** Colour of the particles and their additive glow. Alpha is honoured. */
  sphereColor?: string;
  /** Drives the repulsion field from a synthetic path when no pointer exists. */
  autoplay?: boolean;
}

export default function Particlesphere({
  particlesCount = 2500,
  particleScale = 8,
  rotationDirection = 'clockwise',
  speed = 20,
  scale = 10,
  drag = true,
  smoothing = 7,
  dragSpeed = 5,
  stopOnHover = false,
  cursorOn = true,
  cursorRadius = 75,
  cursorStrength = 10,
  clickForce = 5,
  sphereColor = '#FFFFFF',
  autoplay = true
}: ParticlesphereProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef<SphereApi | null>(null);

  const speedN = speed / 10;
  const baseSpeed = mapLinear(speedN, 0.1, 1, 0.01, 0.05);

  const config: SphereConfig = {
    particlesCount,
    particleSize: mapLinear(Math.max(0.1, Math.min(1, particleScale / 10)), 0.1, 1, 0.01, 0.1),
    scaleMultiplier: mapLinear(Math.max(0, Math.min(1, scale / 10)), 0, 1, 0.25, 1.25),
    rotationSpeed: rotationDirection === 'anticlockwise' ? -baseSpeed : baseSpeed,
    speedN,
    smoothingN: smoothing / 10,
    dragN: dragSpeed / 10,
    drag,
    stopOnHover,
    cursorOn,
    cursorRadius: Math.max(0, Math.min(600, cursorRadius)),
    cursorStrength: mapLinear(Math.max(0, Math.min(1, cursorStrength / 10)), 0, 1, 0, 15),
    clickForce,
    sphereColor,
    autoplay
  };

  // Only what decides how many particles there are, how big they are, or what
  // colour they are needs the buffers laid out again. Everything else is read
  // off the ref inside the loop and lands on the next frame.
  const buildKey = `${config.particlesCount}|${config.particleSize}|${config.scaleMultiplier}|${config.sphereColor}`;

  const configRef = useRef(config);
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effects below.
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    try {
      apiRef.current = createSphere(canvas, container, configRef);
    } catch {
      // WebGL can be unavailable (blocked, out of contexts, software render).
      return;
    }
    return () => {
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, []);

  const built = useRef(false);
  useEffect(() => {
    if (!built.current) {
      built.current = true;
      return;
    }
    apiRef.current?.rebuild();
  }, [buildKey]);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

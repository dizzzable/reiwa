import { useEffect, useRef } from 'react';

/**
 * CosmicOrb — a galaxy sealed inside a glass sphere.
 *
 * Ported from Originkit `cosmic-orb` (preset `base`). Raw WebGL 1 with
 * hand-written GLSL; one quad, everything procedural in the fragment shader.
 *
 * The source renders a fixed-pixel square that `border-radius: 50%` crops into
 * a circle, so it could never fill a rectangular card. Here the sphere is a
 * circle in *shader* space and the quad is mapped through an aspect-corrected
 * extent, so the card can be any rectangle. See the `fit` and `zoom` props.
 */

export interface CosmicOrbProps {
  /**
   * How the sphere meets a rectangular card.
   * `cover` scales the sphere until it covers the card (edges cropped) —
   * the default, because a card background should not have dead corners.
   * `contain` fits the whole circular orb inside the card and paints the
   * surrounding area with `background`.
   */
  fit?: 'cover' | 'contain';
  /** Magnification on top of `fit`. 1 = exact fit, >1 zooms into the sphere. */
  zoom?: number;
  /** Galaxy character. `auto` lets `seed` decide. */
  archetype?: 'auto' | 'spiral' | 'nebula' | 'core' | 'deep';
  /** Anchor colour — drives the void glow around the galaxy. */
  anchor?: string;
  /** Accent colour A. */
  colorA?: string;
  /** Accent colour B. */
  colorB?: string;
  /** Accent colour C. */
  colorC?: string;
  /** Colour surrounding the sphere. */
  background?: string;
  /** Internal nebula/star drift rate. 50 is normal. */
  speed?: number;
  /** Rotation rate of the sphere itself. 50 is normal. */
  spin?: number;
  /** Chromatic-aberration lens warp along the sphere's edge. */
  lens?: boolean;
  /** Strength of that lens warp. */
  lensAmount?: number;
  /** Layout seed. Changing it re-rolls the galaxy, so two cards can differ. */
  seed?: number;
}

const MAX_DPR = 2;
/**
 * Longest-side cap on the drawing buffer, in device pixels.
 *
 * This effect is NOT routed through `render-scale.ts`, and deliberately so:
 * two caps stacked on one buffer is two numbers to keep in step and one of
 * them silently doing nothing. This one is strictly tighter everywhere it can
 * apply — the largest buffer it permits is 1280×1280 = 1,638,400 device
 * pixels, which is inside `RENDER_PIXEL_BUDGET` (2,073,600) for every possible
 * aspect ratio, so the shared budget could never bind here even if it were
 * consulted. It also cannot be relaxed into the shared one without making this
 * effect 2.25× more expensive than it is today.
 *
 * `applySize` below is therefore the whole story for this component, and it is
 * the same shape as the shared helper: the CSS box is untouched, only
 * `canvas.width/height` moves.
 */
const MAX_PX = 1280;
const ARCHETYPES = ['spiral', 'nebula', 'core', 'deep'];

/** Parse `#rgb` / `#rrggbb` / `rgb()` into 0..1 RGB. */
function toRgb(color: string): [number, number, number] {
  const value = (color ?? '').trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map(c => c + c)
        .join('');
    }
    const n = parseInt(hex.slice(0, 6), 16);
    if (Number.isNaN(n)) return [1, 1, 1];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = value.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map(s => parseFloat(s));
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
  }
  return [1, 1, 1];
}

const VERTEX_SHADER = `
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SHADER_BODY = `
float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }
vec4 starfield(vec3 n, float t) {
  float lon = atan(n.z, n.x);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float v1 = fract(uPhase * 7.13);
  float v2 = fract(uPhase * 3.71);
  float v3 = fract(uPhase * 5.37);
  float at = uArch >= 0.0 ? uArch : floor(fract(uPhase * 9.73) * 4.0);
  float isNeb = step(0.5, at) * (1.0 - step(1.5, at));
  float isCore = step(1.5, at) * (1.0 - step(2.5, at));
  float isDeep = step(2.5, at);
  float gb = lat + (0.15 + 0.4 * v1) * sin(lon * (1.0 + floor(v2 * 2.0)) + 1.3)
           + 0.12 * sin(lon * 3.0 + t * 0.1);
  float band = exp(-gb * gb * (5.0 + 10.0 * v3));
  band = mix(band, max(band, 0.8), isNeb);
  band *= 1.0 - 0.85 * isDeep;
  float n1 = sin(lon * 2.0 + sin(lat * 3.0 + t * 0.25) * 1.6 + t * 0.15);
  float n2 = sin(lon * 5.0 - sin(lat * 4.0 - t * 0.2) * 1.2 - t * 0.22 + 2.4);
  float neb = pow(0.5 + 0.5 * n1, 2.0) * (0.45 + 0.55 * pow(0.5 + 0.5 * n2, 2.0));
  float lane = pow(0.5 + 0.5 * sin(lon * 4.0 + lat * 7.0 + sin(lon * 2.0) * 2.0), 3.0);
  float galaxy = band * neb * (1.0 - lane * (0.55 + 0.35 * v2));
  galaxy = clamp(galaxy, 0.0, 1.0);
  vec3 hue = mix(mix(uC0, uC1, v1), mix(uC1, uC2, v3), 0.5 + 0.5 * sin(lon + lat * 2.0 - t * 0.2));
  vec3 hueGrey = vec3(dot(hue, vec3(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey) * 1.45, 0.0, 1.0);
  vec3 dust = mix(vec3(0.72, 0.78, 0.92), hue, 0.45 + 0.3 * v1 + 0.45 * isNeb);
  vec3 col = dust * galaxy * (0.6 + 0.9 * isNeb);
  float shear = sin(lon * 13.0 + lat * 4.0 - t * 0.35) * sin(lon * 5.0 + t * 0.2);
  col += dust * band * neb * max(shear, 0.0) * 0.14;
  float gb2 = lat - (0.35 + 0.25 * v2) * sin(lon * 2.0 - 1.1) + 0.4;
  float arm = exp(-gb2 * gb2 * 7.0) * neb;
  col += mix(dust, uC1, 0.35) * arm * 0.2;
  vec3 voidGlow = mix(vec3(0.04, 0.03, 0.1), mix(uC0, mix(uC1, uC2, v3), v1) * 0.22, 0.75);
  col += voidGlow * (0.5 + 0.22 * sin(t * 0.4 + lon)) * (0.4 + 0.6 * band);
  col += vec3(1.0, 0.88, 0.68) * pow(band, 4.0) * pow(neb, 2.0) * 0.4;
  float ca = v2 * 6.28318;
  vec3 Cdir = normalize(vec3(cos(ca) * 0.85, 0.6 * (v3 - 0.5), sin(ca) * 0.85));
  float bulge = max(dot(n, Cdir), 0.0);
  col += mix(vec3(1.0, 0.85, 0.6), uC2, 0.25) * (pow(bulge, 14.0) * 1.6 + pow(bulge, 4.0) * 0.5) * isCore;
  float pocket = pow(neb, 5.0) * band * (0.7 + 0.3 * sin(t * 0.6 + lon * 3.0));
  col += mix(uC2, uC0, fract(v1 + 0.5 * sin(lon * 2.0) + 0.5)) * pocket * (0.5 + 0.4 * v2 + 0.8 * isNeb);
  float pocket2 = pow(0.5 + 0.5 * sin(lon * 3.0 + lat * 4.0 - t * 0.18 + 2.0), 6.0) * band;
  col += mix(uC1, uC2, v3) * pocket2 * (0.25 + 0.3 * v1 + 0.5 * isNeb);
  float detail = smoothstep(90.0, 200.0, uRes.y);
  vec2 gg = vec2(lon, lat) * 34.0;
  vec2 gc = floor(gg);
  vec2 gf = fract(gg);
  float gh = h1(gc.x * 3.7 + gc.y * 11.3);
  vec2 gp = vec2(0.2 + 0.6 * h1(gh * 91.0), 0.2 + 0.6 * h1(gh * 47.0));
  float gd = length((gf - gp) * vec2(cos(lat), 1.0));
  float grain = exp(-gd * gd * 700.0 * clamp(uRes.y / 420.0, 0.22, 1.0)) * step(0.3, gh) * (0.15 + 0.85 * band);
  col += vec3(0.88, 0.9, 1.0) * grain * 0.4 * detail;
  float w = clamp(galaxy * 0.7 + pow(band, 4.0) * 0.25, 0.0, 1.0);
  for (int s = 0; s < 3; s++) {
    float K = s == 0 ? 6.0 : (s == 1 ? 11.0 : 19.0);
    vec2 g = vec2(lon, lat) * K;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float hx = h1(cell.x * 13.7 + cell.y * 7.3 + float(s) * 91.0);
    float hy = h1(cell.x * 5.1 + cell.y * 17.9 + float(s) * 37.0);
    vec2 sp = vec2(0.15 + 0.7 * hx, 0.15 + 0.7 * hy);
    float d = length((f - sp) * vec2(cos(lat), 1.0));
    float census = (v2 - 0.5) * 0.2 + 0.35 * isNeb - 0.2 * isCore + 0.3 * isDeep;
    float keep = step((s == 2 ? 0.3 : 0.55) + census, h1(hx * 89.0 + hy * 31.0) + band * 0.25);
    float resFac = clamp(uRes.y / 420.0, 0.22, 1.0);
    float tw = mix(0.92, 0.6 + 0.4 * sin(t * (1.5 + 3.0 * hx) + hx * 40.0), resFac);
    float hz = h1(hx * 53.0 + hy * 71.0 + cell.x);
    float sizeJit = 0.35 + 1.8 * hz * hz;
    float sharp = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0)) / sizeJit * resFac;
    float star = exp(-d * d * sharp) * keep * tw;
    vec3 tint = mix(vec3(1.0), hx < 0.33 ? vec3(0.85, 0.9, 1.0) : (hx < 0.66 ? vec3(1.0, 0.95, 0.85) : mix(vec3(1.0), uC1, 0.3)), 0.6);
    float bright = (s == 0 ? 1.7 : (s == 1 ? 0.9 : 0.5)) * (0.55 + 0.7 * sizeJit);
    float starFade = mix(s == 2 ? 0.14 : 0.45, 1.0, detail);
    col += tint * star * bright * starFade;
    if (s == 0) {
      float big = smoothstep(1.2, 2.0, sizeJit);
      col += tint * exp(-d * d * 60.0) * 0.18 * big * tw * starFade;
      vec2 dd = (f - sp) * vec2(cos(lat), 1.0);
      float spike = exp(-dd.x * dd.x * 1200.0) * exp(-dd.y * dd.y * 26.0)
                  + exp(-dd.y * dd.y * 1200.0) * exp(-dd.x * dd.x * 26.0);
      col += tint * spike * 0.3 * big * tw * starFade;
      w = max(w, spike * 0.3 * big * starFade);
    }
    w = max(w, star * min(bright, 1.5) * starFade);
  }
  float pa = v1 * 6.28318;
  vec3 P = normalize(vec3(sin(pa) * 0.9, 1.4 * (v2 - 0.5), cos(pa) * 0.9));
  float pd = max(dot(n, P), 0.0);
  float beat = pow(0.5 + 0.5 * sin(t * (1.2 + v3) + v3 * 6.28), 8.0);
  float pulsarFade = mix(0.45, 1.0, detail);
  col += vec3(0.9, 0.95, 1.0) * (pow(pd, 900.0) * (0.6 + 1.2 * beat) + pow(pd, 110.0) * 0.5 * beat) * pulsarFade;
  w = max(w, pow(pd, 900.0) * (0.5 + 0.5 * beat) * pulsarFade);
  return vec4(min(col, vec3(1.0)), min(w, 1.0));
}
vec4 sphereAt(vec3 n, float spin, float t) {
  float roll = t * 0.13;
  float cr = cos(roll), sr = sin(roll);
  n = vec3(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z);
  float tilt = 0.45 + 0.35 * sin(t * 0.24);
  float cx = cos(tilt), sx = sin(tilt);
  n = vec3(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);
  float cs = cos(spin), ss = sin(spin);
  n = vec3(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);
  return starfield(n, t);
}
vec3 shade(vec2 p) {
  float r = length(p);
  float t = uTime * 0.8 + uPhase;
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  vec3 N = vec3(p.x, p.y, z);
  float fres = pow(1.0 - z, 2.4);
  vec3 I = vec3(0.0, 0.0, -1.0);
  vec3 R = refract(I, N, 0.75);
  float dHit = -2.0 * dot(N, R);
  vec3 B = normalize(N + R * dHit);
  float sv = fract(uPhase * 6.31);
  float sw = fract(uPhase * 2.17);
  float tWarp = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);
  vec4 front = sphereAt(N, uSpin, tWarp);
  vec4 back = sphereAt(B, uSpin, tWarp * 0.8 + 2.7);
  vec3 voidCol = mix(uAnchor * 0.04, uAnchor * 0.35, fres);
  vec3 col = mix(uBg, voidCol, 0.97 - 0.04 * fres);
  float fa = clamp(front.a, 0.0, 1.0);
  float ba = clamp(back.a, 0.0, 1.0);
  col = mix(col, back.rgb, ba * 0.16);
  col = mix(col, front.rgb, fa * 0.85);
  {
    float alon = atan(N.x, N.z);
    float speech = pow(0.5 + 0.5 * sin(alon * 3.0 + sin(alon * 7.0 + t * 1.1) * 0.7 + t * 0.5), 3.0)
                 * (0.55 + 0.45 * sin(alon * 5.0 - t * 0.65 + 1.7));
    float sky = -N.y;
    float hang = smoothstep(-0.15, 0.5, sky);
    float rays = 0.7 + 0.3 * sin(alon * 24.0 + sin(alon * 9.0 - t * 0.8) * 2.0 + t * 1.6);
    float aur = clamp(speech, 0.0, 1.0) * hang * rays;
    float av = fract(uPhase * 2.93);
    vec3 aurCol = mix(vec3(0.12, 0.95, 0.55), vec3(0.45, 0.35, 1.0),
                      smoothstep(0.0, 0.95, sky + 0.35 * speech));
    aurCol = mix(aurCol, mix(uC0, uC2, av), 0.15 + 0.4 * av);
    col += aurCol * aur * 0.8;
    float met = 4.5 + 3.5 * fract(uPhase * 4.91);
    float epoch = floor(t / met);
    float ph = fract(t / met);
    vec2 s0 = vec2(-1.1 + 2.2 * h1(epoch * 1.3), 0.85 - 1.4 * h1(epoch * 2.9));
    vec2 sd = normalize(vec2(0.7 + 0.5 * h1(epoch * 4.1), -0.35 - 0.4 * h1(epoch * 5.3)));
    vec2 head = s0 + sd * ph * 2.8;
    vec2 rel = p - head;
    float along = dot(rel, sd);
    float perp = dot(rel, vec2(-sd.y, sd.x));
    float vis = smoothstep(0.0, 0.06, ph) * smoothstep(0.5, 0.32, ph);
    float tail = exp(-perp * perp * 1600.0) * exp(along * 9.0) * step(along, 0.0)
               * smoothstep(-0.5, -0.02, along);
    float headGlow = exp(-dot(rel, rel) * 900.0);
    col += (vec3(1.0) * headGlow * 1.2 + mix(vec3(1.0), uC1, 0.3) * tail * 0.85) * vis;
    vec3 LD = normalize(vec3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
    float diffuse = 0.62 + 0.65 * max(dot(N, LD), 0.0);
    col *= diffuse;
    float counter = max(dot(N.xy, -LD.xy), 0.0) * fres;
    col += mix(uC0, vec3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;
  }
  vec3 L1 = normalize(vec3(-0.45 + 0.3 * sin(t * 0.34), 0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  float keyAmp = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  col += vec3(1.0) * pow(max(dot(N, L1), 0.0), 150.0) * keyAmp;
  vec3 LS = normalize(vec3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  col += vec3(1.0) * pow(max(dot(N, LS), 0.0), 7.0) * 0.05;
  vec3 L2 = normalize(vec3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69));
  col += vec3(1.0) * pow(max(dot(N, L2), 0.0), 140.0) * 0.25;
  col = mix(col, front.rgb, fa * fres * 0.3);
  float limb = smoothstep(0.94, 1.0, rr);
  col = mix(col, col * 0.85, limb * 0.4);
  return col;
}`;

// `uExtent` is the port's addition: half the visible box in sphere space.
// It carries the container's aspect ratio, which is what lets a circle-shaped
// effect fill a rectangle.
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform vec2 uRes;
uniform vec2 uExtent;
uniform vec3 uBg;
uniform vec3 uAnchor, uC0, uC1, uC2;
uniform float uTime, uPhase;
uniform float uSpin;
uniform float uArch;
uniform float uLens;
${SHADER_BODY}
void main() {
  vec2 p = (vUV * 2.0 - 1.0) * uExtent;
  if (length(p) > 1.0) {
    gl_FragColor = vec4(uBg, 1.0);
    return;
  }
  if (uLens > 0.0) {
    float r = length(p);
    float ex = exp(2.0 * 1.7724539 * (r - 0.9) / 0.1414214);
    float fall = 0.5 + 0.5 * (ex - 1.0) / (ex + 1.0);
    if (fall > 0.004) {
      float swell = 1.0 + 0.16 * (0.6 * sin(uTime * 0.9 + uPhase)
                                + 0.4 * sin(uTime * 1.7 + uPhase * 1.3));
      float k = uLens * fall * swell;
      float cR = 1.4 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase));
      float cG = 1.2 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 2.1));
      float cB = 1.0 * (1.0 + 0.06 * sin(uTime * 1.3 + uPhase + 4.2));
      vec3 col = vec3(shade(p * (1.0 - k * cR)).r,
                      shade(p * (1.0 - k * cG)).g,
                      shade(p * (1.0 - k * cB)).b);
      vec2 a2 = min(abs(p), 1.0);
      float lobe = max(abs(a2.x * 0.766 + a2.y * 0.643), abs(a2.x * 0.766 - a2.y * 0.643));
      float glow = 0.65 * pow(clamp((lobe - 0.0707) / 1.3435, 0.0, 1.0), 2.4) * fall;
      glow += 1.02 * clamp(1.0 + (r - 1.0) / 0.15, 0.0, 1.0) * step(r, 1.0) * pow(lobe, 2.0);
      col += vec3(0.25) * min(glow, 1.0);
      gl_FragColor = vec4(col, 1.0);
      return;
    }
  }
  gl_FragColor = vec4(shade(p), 1.0);
}`;

const UNIFORM_NAMES = [
  'uRes',
  'uExtent',
  'uBg',
  'uAnchor',
  'uC0',
  'uC1',
  'uC2',
  'uTime',
  'uPhase',
  'uSpin',
  'uArch',
  'uLens'
] as const;

export default function CosmicOrb({
  fit = 'cover',
  zoom = 1,
  archetype = 'auto',
  anchor = '#6A3CFF',
  colorA = '#3CE0FF',
  colorB = '#A24BFF',
  colorC = '#FF5EA8',
  background = '#000000',
  speed = 50,
  spin = 50,
  lens = true,
  lensAmount = 45,
  // Must match the catalog's control default. Nothing merges the catalog in on
  // the render path, so a stored props record without this key falls through to
  // here. The panel's slider steps by 1, and the fractional 17.317 it used to
  // ship was a value that slider could not return to once nudged — the seed
  // only has to differ from other seeds, so the fraction bought nothing.
  seed = 17
}: CosmicOrbProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const cfgRef = useRef({
    fit,
    zoom,
    bg: toRgb(background),
    anchor: toRgb(anchor),
    c0: toRgb(colorA),
    c1: toRgb(colorB),
    c2: toRgb(colorC),
    speed: Math.max(0, speed) / 50,
    spin: Math.max(0, spin) / 50,
    arch: archetype === 'auto' ? -1 : ARCHETYPES.indexOf(archetype),
    lens: lens ? (Math.max(0, lensAmount) / 100) * 0.2 : 0,
    phase: seed
  });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    cfgRef.current = {
      fit,
      zoom,
      bg: toRgb(background),
      anchor: toRgb(anchor),
      c0: toRgb(colorA),
      c1: toRgb(colorB),
      c2: toRgb(colorC),
      speed: Math.max(0, speed) / 50,
      spin: Math.max(0, spin) / 50,
      arch: archetype === 'auto' ? -1 : ARCHETYPES.indexOf(archetype),
      lens: lens ? (Math.max(0, lensAmount) / 100) * 0.2 : 0,
      phase: seed
    };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /**
     * THE CANVAS IS THIS EFFECT'S, NOT REACT'S — and that is the whole point.
     *
     * This used to render a `<canvas ref={canvasRef}>` and open the context on
     * that element. React owns such an element, so it SURVIVES this effect's
     * cleanup — while the cleanup ends by destroying the context living on it.
     * A canvas hands the same context object back to every later `getContext`
     * call, so a SECOND setup on the same element got the ALREADY-LOST context:
     * `createShader` returns null on a lost context, `init()` bailed, `ready`
     * stayed false and the card was permanently blank — silently, with nothing
     * thrown for the layer's error boundary to catch. React StrictMode's
     * double-invoke reproduced it on every dev mount; in production any teardown
     * and re-setup over preserved DOM did.
     *
     * Allocating the element here makes a second setup impossible to poison by
     * construction: a new element cannot be holding an old context. The release
     * in the cleanup therefore STAYS — WebKit frees a context slot only when the
     * context object is destroyed, and this project is under a
     * 16-per-web-content-process ceiling. Same shape as `Plasma`/`Grainient`.
     */
    const canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';

    const gl = canvas.getContext('webgl', {
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
      powerPreference: 'low-power'
    });
    if (!gl) return;

    container.appendChild(canvas);

    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let uniforms: Record<string, WebGLUniformLocation | null> = {};
    let ready = false;
    let rafId = 0;

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
      gl.deleteShader(sh);
      return null;
    };

    /** Release the program and buffer. Called on re-init and on unmount. */
    const releaseResources = () => {
      if (program) {
        gl.deleteProgram(program);
        program = null;
      }
      if (buffer) {
        gl.deleteBuffer(buffer);
        buffer = null;
      }
      uniforms = {};
      ready = false;
    };

    const init = () => {
      releaseResources();
      const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
      const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      if (!vs || !fs) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return;
      }
      const p = gl.createProgram();
      if (!p) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return;
      }
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.bindAttribLocation(p, 1, 'aUV');
      gl.linkProgram(p);
      // Shaders are reference-counted by the program; drop our handles now.
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        gl.deleteProgram(p);
        return;
      }
      program = p;
      for (const name of UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(p, name);

      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]),
        gl.STATIC_DRAW
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      ready = true;
    };

    // `webglcontextlost` is not a touch or wheel event: preventDefault here is
    // what asks the browser to restore the context, and blocks no gesture.
    const onLost = (e: Event) => {
      e.preventDefault();
      ready = false;
      program = null;
      buffer = null;
      uniforms = {};
    };
    const onRestored = () => {
      init();
      applySize();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    init();

    function applySize() {
      // A hoisted function declaration is created before the narrowing above,
      // so TypeScript re-widens the captured `container` here.
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      let w = Math.max(1, Math.round(Math.max(1, rect.width) * dpr));
      let h = Math.max(1, Math.round(Math.max(1, rect.height) * dpr));
      const longest = Math.max(w, h);
      if (longest > MAX_PX) {
        const k = MAX_PX / longest;
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    applySize();
    const resizeObserver = new ResizeObserver(applySize);
    resizeObserver.observe(container);

    const body = { spin: 0, spinVel: 0, lastT: null as number | null };

    /**
     * Advance the sphere's own rotation. The source threaded an audio-reactive
     * path through here, but its input was hard-wired to 0, so every audio term
     * (and the spin-direction flip it drove) was dead. Removed; the remaining
     * motion is identical.
     *
     * Takes wall-clock seconds, NOT the nebula's clock. Speed and Spin are two
     * separate controls, and they were sharing one clock: `tSpeed` is elapsed
     * time multiplied by Speed, so at Speed 0 it is pinned at 0, `dt` is 0 on
     * every frame, and `body.spin` never advances either. An operator who set
     * Speed to 0 to still the nebula got a frozen picture with the GPU still
     * drawing it, and no value of Spin could move it.
     */
    const advance = (tReal: number, phase: number, spinScale: number) => {
      const dt = body.lastT === null ? 0 : Math.min(0.1, Math.max(0, tReal - body.lastT));
      body.lastT = tReal;
      const o = (6.31 * phase) % 1;
      const s = 0.35 * Math.sin(tReal * (0.11 + 0.08 * ((2.17 * phase) % 1)) + phase);
      const targetVel = 0.65 * (0.65 + 0.7 * o) * (1 + s) * spinScale;
      body.spinVel += (targetVel - body.spinVel) * (dt > 0 ? 1 - Math.exp(-dt / 0.35) : 0);
      body.spin += body.spinVel * dt;
    };

    const start = performance.now();

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (!ready || !program) return;
      const cfg = cfgRef.current;
      // Two clocks. The nebula runs on `tNebula`, which Speed scales and can
      // stop; the sphere's rotation runs on wall-clock seconds and is scaled by
      // Spin alone. At the default Speed of 50 (`cfg.speed === 1`) the two are
      // the same number, so nothing about the shipped look changes.
      const tReal = (performance.now() - start) / 1000;
      const tNebula = tReal * cfg.speed;
      advance(tReal, cfg.phase, cfg.spin);

      // Aspect-corrected half-extent: this is what replaces the source's
      // fixed-pixel square + border-radius circle.
      const aspect = canvas.width / Math.max(1, canvas.height);
      const magnify = Math.max(0.05, cfg.zoom);
      let ex: number;
      let ey: number;
      if (cfg.fit === 'contain') {
        if (aspect >= 1) {
          ex = aspect;
          ey = 1;
        } else {
          ex = 1;
          ey = 1 / aspect;
        }
      } else {
        // Corner of the card lands just inside r = 1, so the sphere covers it.
        const k = 0.999 / Math.sqrt(aspect * aspect + 1);
        ex = aspect * k;
        ey = k;
      }
      ex /= magnify;
      ey /= magnify;

      gl.useProgram(program);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      gl.uniform2f(uniforms.uExtent, ex, ey);
      gl.uniform3f(uniforms.uBg, cfg.bg[0], cfg.bg[1], cfg.bg[2]);
      gl.uniform3f(uniforms.uAnchor, cfg.anchor[0], cfg.anchor[1], cfg.anchor[2]);
      gl.uniform3f(uniforms.uC0, cfg.c0[0], cfg.c0[1], cfg.c0[2]);
      gl.uniform3f(uniforms.uC1, cfg.c1[0], cfg.c1[1], cfg.c1[2]);
      gl.uniform3f(uniforms.uC2, cfg.c2[0], cfg.c2[1], cfg.c2[2]);
      gl.uniform1f(uniforms.uTime, tNebula);
      gl.uniform1f(uniforms.uPhase, cfg.phase);
      gl.uniform1f(uniforms.uArch, cfg.arch);
      gl.uniform1f(uniforms.uLens, cfg.lens);
      gl.uniform1f(uniforms.uSpin, body.spin);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      // Listeners come off before loseContext, or the restore handler would
      // rebuild everything we are about to free.
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      releaseResources();
      // The element goes before the context does. A detached canvas is not a
      // presentation, and the card layer's canvas observer reads exactly that:
      // a `webglcontextlost` on a canvas still in the document is a fault, one
      // on a canvas that has left it is this teardown.
      try {
        container.removeChild(canvas);
      } catch {
        /* already gone */
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden" />;
}

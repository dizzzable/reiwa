import { useEffect, useRef } from 'react';

import { resolveBufferRatio } from '../render-scale';

/**
 * WordGlobe — a sphere woven from repetitions of a phrase.
 *
 * Ported from Originkit `word-globe` (preset `base`). Canvas 2D: glyphs are
 * laid out along helical bands on a sphere and projected in JS each frame.
 *
 * Two gates from the source are gone. It froze under `prefers-reduced-motion`
 * (card artwork is gated centrally, not per component) and paused itself with
 * an IntersectionObserver (the card layer already controls mounting and
 * visibility, and a second observer only fights it).
 */

type GapKind = 'custom' | 'line' | 'seam';

interface Glyph {
  character: string;
  longitude: number;
  opacityVariation: number;
  polarAngle: number;
}

interface GeometrySettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
  word: string;
}

/** One projected glyph. Reused between frames rather than reallocated. */
interface ProjectedGlyph {
  character: string;
  depth: number;
  opacityVariation: number;
  scale: number;
  x: number;
  y: number;
}

const VIEWBOX_SIZE = 720;
const SILHOUETTE_RADIUS = 286;
const FULL_ROTATION = Math.PI * 2;
const MAX_GLYPHS = 6000;

const CAMERA_DISTANCE = 6.1;
const EQUATOR_BULGE = 0.28;
const SPARSE_SPACING_RATIO = 1.92;

const LINE_GAP_WEIGHT = 4;
const CUSTOM_GAP_WEIGHT = 19;
const SEAM_GAP_WEIGHT = 13;

const DENSE_FACE_GAPS: GapKind[] = [
  'line',
  'line',
  'line',
  'custom',
  'line',
  'line',
  'line',
  'line',
  'line',
  'line',
  'line',
  'line',
  'custom',
  'line',
  'line',
  'line'
];

const SPARSE_FACE_GAPS: GapKind[] = ['line', 'custom', 'line', 'line', 'line', 'custom', 'line', 'line'];

const BAND_GAPS: GapKind[] = [...DENSE_FACE_GAPS, 'seam', ...SPARSE_FACE_GAPS, 'seam'];

const DENSE_BAND_COUNT = DENSE_FACE_GAPS.length + 1;

const SPHERE_RADIUS = SILHOUETTE_RADIUS / (CAMERA_DISTANCE / Math.sqrt(CAMERA_DISTANCE * CAMERA_DISTANCE - 1));

const BAND_LONGITUDES = (() => {
  const intervalWeights = BAND_GAPS.map(gapKind => {
    if (gapKind === 'custom') return CUSTOM_GAP_WEIGHT;
    if (gapKind === 'seam') return SEAM_GAP_WEIGHT;
    return LINE_GAP_WEIGHT;
  });
  const totalWeight = intervalWeights.reduce((total, intervalWeight) => total + intervalWeight, 0);

  let travelledWeight = 0;

  return BAND_GAPS.map((_, bandIndex) => {
    if (bandIndex > 0) {
      travelledWeight += intervalWeights[bandIndex - 1] ?? 0;
    }
    return (travelledWeight / totalWeight) * FULL_ROTATION;
  });
})();

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum);

const getDeterministicVariation = (index: number, salt: number) => {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

const wrapLongitude = (longitude: number) => ((longitude % FULL_ROTATION) + FULL_ROTATION) % FULL_ROTATION;

/** Walk one helical band from pole to pole, laying glyphs as it goes. */
const walkBand = (
  startLongitude: number,
  startPolarAngle: number,
  spacing: number,
  twist: number,
  settings: GeometrySettings,
  characters: string[],
  characterWidths: number[],
  startCharacterIndex: number,
  variationSeed: number,
  output: Glyph[]
) => {
  let polarAngle = startPolarAngle;
  let characterIndex = startCharacterIndex;

  while (polarAngle < Math.PI && output.length < MAX_GLYPHS) {
    const slot = characterIndex % characters.length;
    const character = characters[slot] ?? 'd';

    const advancePixels = Math.max(characterWidths[slot] * spacing, settings.fontSize * 0.25);
    const advanceRadians = advancePixels / SPHERE_RADIUS;

    if (character.trim().length > 0) {
      output.push({
        character,
        longitude: wrapLongitude(startLongitude + twist * polarAngle + EQUATOR_BULGE * Math.sin(polarAngle)),
        opacityVariation: 0.82 + getDeterministicVariation(output.length, variationSeed) * 0.18,
        polarAngle
      });
    }

    const arcStretch = Math.sqrt(1 + twist * twist * Math.sin(polarAngle) * Math.sin(polarAngle));
    polarAngle += advanceRadians / arcStretch;
    characterIndex += 1;
  }

  return characterIndex;
};

const buildGeometry = (context: CanvasRenderingContext2D, settings: GeometrySettings, twist: number): Glyph[] => {
  // `||` catches `''` but not `'  '`, and `walkBand` drops every glyph whose
  // `trim()` is empty — so a whitespace-only word built an empty sphere and the
  // card went blank. Same defect as TextWave's empty `gridText`, same fallback.
  const characters = Array.from(settings.word.trim().length > 0 ? settings.word : 'dream');
  const previousFont = context.font;
  context.font = `${settings.fontWeight} ${settings.fontSize}px ${settings.fontFamily}`;
  const characterWidths = characters.map(character => context.measureText(character).width);
  context.font = previousFont;

  const glyphs: Glyph[] = [];
  let characterIndex = 0;

  const averageWidth =
    characterWidths.reduce((total, width) => total + width, 0) / Math.max(characterWidths.length, 1);
  const poleStagger = (averageWidth * settings.letterSpacing) / SPHERE_RADIUS;

  BAND_LONGITUDES.forEach((startLongitude, bandIndex) => {
    const spacing = bandIndex < DENSE_BAND_COUNT ? settings.letterSpacing : settings.letterSpacing * SPARSE_SPACING_RATIO;

    characterIndex = walkBand(
      startLongitude,
      (bandIndex / BAND_LONGITUDES.length) * poleStagger,
      spacing,
      twist,
      settings,
      characters,
      characterWidths,
      characterIndex,
      bandIndex,
      glyphs
    );
  });

  return glyphs;
};

export interface WordGlobeProps {
  /** The word or phrase repeated to build the sphere's surface. */
  word?: string;
  /** Colour of the text characters. */
  color?: string;
  /** Font family used for the glyphs. */
  fontFamily?: string;
  /** Base glyph size, before perspective scaling. */
  fontSize?: number;
  /** Font weight used for the glyphs. */
  fontWeight?: number;
  /** How fast the sphere rotates. */
  speed?: number;
  /** Spin direction. */
  rotationSide?: 'clockwise' | 'counterclockwise';
  /** How tightly the text bands twist into a helix. */
  twist?: number;
  /** Spacing between repeated letters — how dense the surface looks. */
  letterSpacing?: number;
}

export default function WordGlobe({
  // Must match the catalog's control default. Nothing merges the catalog in on
  // the render path, so a stored props record without this key falls through to
  // here — and the previous default made an unedited card advertise the source
  // library.
  word = 'dream',
  color = '#ffffff',
  fontFamily = 'Inter, sans-serif',
  fontSize = 15,
  fontWeight = 500,
  speed = 7,
  rotationSide = 'counterclockwise',
  twist = 50,
  letterSpacing = 800
}: WordGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const propsRef = useRef({ word, color, fontFamily, fontSize, fontWeight, speed, rotationSide, twist, letterSpacing });
  // Committed, not written during render: React may replay or discard a render,
  // and a discarded one must not leave the loop reading props from a commit that
  // never happened. No dependency array — every commit, ahead of the effect below.
  useEffect(() => {
    propsRef.current = { word, color, fontFamily, fontSize, fontWeight, speed, rotationSide, twist, letterSpacing };
  });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let canvasWidth = 0;
    let canvasHeight = 0;
    let pixelRatio = 1;
    let disposed = false;
    let frameId = 0;
    let geometry: Glyph[] = [];
    let geometrySignature = '';
    let previousTimestamp: number | null = null;
    let rotationElapsed = 0;

    // Refilled in place each frame. The source allocated a fresh object per
    // glyph per frame, which on a phone is thousands of short-lived objects a
    // second for no benefit.
    let projected: ProjectedGlyph[] = [];

    const ensureGeometry = () => {
      const p = propsRef.current;
      const settings: GeometrySettings = {
        fontFamily: p.fontFamily || 'Inter, sans-serif',
        fontSize: Math.max(p.fontSize, 4),
        fontWeight: p.fontWeight || 500,
        letterSpacing: Math.max(p.letterSpacing, 40) / 100,
        // Coerced here, at the one place a prop becomes geometry input, not
        // inside `buildGeometry`. A stored props record is free-form JSON that
        // the backend validates with `@IsObject()` alone, so `word: null`
        // arrives intact — no default fires for an explicit null — and
        // `settings.word.trim()` threw. It threw AFTER `geometrySignature` had
        // been assigned below, so every later frame matched the signature,
        // returned early and never rebuilt: one throw inside a `rAF`, with
        // nothing to catch it, and a globe that stayed blank for the life of
        // the mount. `buildGeometry` already turns `''` into the fallback word.
        word: typeof p.word === 'string' ? p.word : ''
      };
      const twistValue = p.twist / 10;
      const signature = `${settings.fontFamily}|${settings.fontSize}|${settings.fontWeight}|${settings.letterSpacing}|${settings.word}|${twistValue}`;
      if (signature === geometrySignature) return;
      geometrySignature = signature;
      geometry = buildGeometry(context, settings, twistValue);
      projected = geometry.map(glyph => ({
        character: glyph.character,
        depth: 0,
        opacityVariation: glyph.opacityVariation,
        scale: 1,
        x: 0,
        y: 0
      }));
    };

    const renderFrame = (timestamp: number) => {
      frameId = requestAnimationFrame(renderFrame);
      if (disposed || canvasWidth === 0 || canvasHeight === 0) return;

      if (previousTimestamp !== null) {
        rotationElapsed += timestamp - previousTimestamp;
      }
      previousTimestamp = timestamp;

      const p = propsRef.current;
      ensureGeometry();

      const safeDuration = (60 / Math.max(p.speed, 0.1)) * 1000;
      const sideMultiplier = p.rotationSide === 'counterclockwise' ? -1 : 1;
      const angle = (rotationElapsed / safeDuration) * FULL_ROTATION * sideMultiplier;

      const cosSpin = Math.cos(angle);
      const sinSpin = Math.sin(angle);

      for (let i = 0; i < geometry.length; i++) {
        const glyph = geometry[i];
        const out = projected[i];
        const ringRadius = Math.sin(glyph.polarAngle);
        const modelX = ringRadius * Math.cos(glyph.longitude);
        const modelY = Math.cos(glyph.polarAngle);
        const modelZ = ringRadius * Math.sin(glyph.longitude);

        const spunX = modelX * cosSpin + modelZ * sinSpin;
        const spunZ = -modelX * sinSpin + modelZ * cosSpin;
        const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - spunZ);

        out.character = glyph.character;
        out.depth = (spunZ + 1) / 2;
        out.opacityVariation = glyph.opacityVariation;
        out.scale = perspective;
        out.x = VIEWBOX_SIZE / 2 + spunX * SPHERE_RADIUS * perspective;
        out.y = VIEWBOX_SIZE / 2 - modelY * SPHERE_RADIUS * perspective;
      }

      // Back to front, so near glyphs paint over far ones.
      projected.sort((a, b) => a.depth - b.depth);

      const logicalScale = Math.min(canvasWidth, canvasHeight) / VIEWBOX_SIZE;
      const horizontalOffset = (canvasWidth - VIEWBOX_SIZE * logicalScale) / 2;
      const verticalOffset = (canvasHeight - VIEWBOX_SIZE * logicalScale) / 2;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      context.fillStyle = p.color;
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      const family = p.fontFamily || 'Inter, sans-serif';
      const weight = p.fontWeight || 500;
      const baseFontSize = p.fontSize;
      let activeFont = '';

      for (let i = 0; i < projected.length; i++) {
        const glyph = projected[i];
        const rawGlyphSize = baseFontSize * glyph.scale * logicalScale;
        const size = Math.max(1, Math.round(rawGlyphSize * 2) / 2);
        const opacity = clamp((0.12 + Math.pow(glyph.depth, 1.35) * 0.88) * glyph.opacityVariation, 0.04, 1);

        context.globalAlpha = opacity;
        const nextFont = `${weight} ${size.toFixed(1)}px ${family}`;
        if (nextFont !== activeFont) {
          activeFont = nextFont;
          context.font = nextFont;
        }

        context.fillText(
          glyph.character,
          horizontalOffset + glyph.x * logicalScale,
          verticalOffset + glyph.y * logicalScale
        );
      }

      context.globalAlpha = 1;
    };

    const syncCanvasSize = () => {
      const bounds = container.getBoundingClientRect();
      canvasWidth = bounds.width || 300;
      canvasHeight = bounds.height || 300;
      // Cap the DRAWING BUFFER, never the CSS box. Only `canvas.width/height`
      // moves; the element keeps the size CSS gave it, and the context
      // transform below still maps CSS units into it — so every feature this
      // effect draws keeps the size the operator configured, at a lower
      // sampling density. See `render-scale.ts`.
      pixelRatio = resolveBufferRatio(canvasWidth, canvasHeight, Math.min(window.devicePixelRatio || 1, 2));

      const pixelWidth = Math.max(1, Math.round(canvasWidth * pixelRatio));
      const pixelHeight = Math.max(1, Math.round(canvasHeight * pixelRatio));

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const resizeObserver = new ResizeObserver(syncCanvasSize);
    resizeObserver.observe(container);
    syncCanvasSize();

    // Not a network request: this only observes fonts the app has already
    // declared, so glyph widths are remeasured once they are usable.
    void document.fonts.ready.then(() => {
      if (disposed) return;
      geometrySignature = '';
    });

    frameId = requestAnimationFrame(renderFrame);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(frameId);
      geometry = [];
      projected = [];
    };
  }, []);

  return (
    <div ref={containerRef} className="absolute inset-0 h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

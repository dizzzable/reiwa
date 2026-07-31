/**
 * Applies the browser's last-known-good visual tokens before the application
 * bundle is downloaded. This prevents the built-in Reiwa palette from
 * flashing while React restores the operator theme.
 *
 * Keep this dependency-free: it runs synchronously in <head> and is allowed
 * by the production CSP as a same-origin script.
 */
(function bootstrapStoredTheme() {
  "use strict";

  var STORAGE_KEY = "reiwa_public_config_snapshot_v1";
  var MAX_SNAPSHOT_LENGTH = 512000;
  var MAX_CSS_IMAGE_LENGTH = 8192;
  var HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var RADII = {
    "rounded-none": ["0px", "0px", "0px"],
    "rounded-lg": ["0.75rem", "0.5rem", "0.75rem"],
    "rounded-xl": ["1rem", "0.75rem", "9999px"],
    "rounded-2xl": ["1.5rem", "0.875rem", "9999px"],
    "rounded-3xl": ["2rem", "1.125rem", "9999px"],
    "rounded-full": ["2.5rem", "1.5rem", "9999px"],
  };

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isHex(value) {
    return typeof value === "string" && HEX.test(value.trim());
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  /**
   * Accept CSS gradients only. The snapshot lives in localStorage and can be
   * edited by the browser owner, so it must never turn into a pre-paint
   * external `url()` request. This deliberately supports nested colour
   * functions and multiple gradient layers, while rejecting image loaders,
   * escapes, comments and attempts to break out of the property value.
   */
  function isSafeGradient(value) {
    if (typeof value !== "string") return false;
    var input = value.trim();
    if (!input || input.length > MAX_CSS_IMAGE_LENGTH) return false;
    if (
      /(?:url|image-set|-webkit-image-set|cross-fade|element|paint)\s*\(/i.test(
        input,
      ) ||
      /[;{}@\\]/.test(input) ||
      /\/\*|\*\//.test(input) ||
      /[\u0000-\u001f\u007f]/.test(input)
    ) {
      return false;
    }

    var index = 0;
    while (index < input.length) {
      while (index < input.length && /\s/.test(input.charAt(index))) index += 1;
      var match = /^(?:(?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(/i.exec(
        input.slice(index),
      );
      if (!match) return false;
      index += match[0].length;

      var depth = 1;
      while (index < input.length && depth > 0) {
        var character = input.charAt(index);
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        index += 1;
      }
      if (depth !== 0) return false;

      while (index < input.length && /\s/.test(input.charAt(index))) index += 1;
      if (index === input.length) return true;
      if (input.charAt(index) !== ",") return false;
      index += 1;
    }
    return false;
  }

  function toRgba(hex, opacity) {
    var raw = hex.trim().replace(/^#/, "");
    var normalized =
      raw.length === 3 || raw.length === 4
        ? raw
            .slice(0, 3)
            .split("")
            .map(function duplicate(character) {
              return character + character;
            })
            .join("")
        : raw.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return hex;
    var alpha = Math.min(1, Math.max(0, opacity));
    return (
      "rgba(" +
      parseInt(normalized.slice(0, 2), 16) +
      ", " +
      parseInt(normalized.slice(2, 4), 16) +
      ", " +
      parseInt(normalized.slice(4, 6), 16) +
      ", " +
      alpha +
      ")"
    );
  }

  function luminance(hex) {
    var raw = hex.trim().replace(/^#/, "");
    var normalized =
      raw.length === 3
        ? raw
            .split("")
            .map(function duplicate(character) {
              return character + character;
            })
            .join("")
        : raw.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return 0;
    function channel(offset) {
      var value = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  }

  function contrastRatio(left, right) {
    var a = relativeLuminance(left);
    var b = relativeLuminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function relativeLuminance(rgb) {
    function channel(value) {
      var normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }
    return (
      0.2126 * channel(rgb[0]) +
      0.7152 * channel(rgb[1]) +
      0.0722 * channel(rgb[2])
    );
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundOpacity(value) {
    return Math.round(value * 1000) / 1000;
  }

  function rgbChannels(rgb) {
    return rgb.join(" ");
  }

  function compositeRgb(foreground, background, alpha) {
    return [
      Math.round(foreground[0] * alpha + background[0] * (1 - alpha)),
      Math.round(foreground[1] * alpha + background[1] * (1 - alpha)),
      Math.round(foreground[2] * alpha + background[2] * (1 - alpha)),
    ];
  }

  function parseCssColor(value) {
    var trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return null;
    if (trimmed.toLowerCase() === "black") {
      return { rgb: [0, 0, 0], alpha: 1 };
    }
    if (trimmed.toLowerCase() === "white") {
      return { rgb: [255, 255, 255], alpha: 1 };
    }
    if (trimmed.charAt(0) === "#") return parseHexColor(trimmed);
    var rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
    if (rgbMatch) return parseRgbFunction(rgbMatch[1]);
    var hslMatch = /^hsla?\(([^)]+)\)$/i.exec(trimmed);
    if (hslMatch) return parseHslFunction(hslMatch[1]);
    return null;
  }

  function parseHexColor(value) {
    var body = value.trim().slice(1);
    if (![3, 4, 6, 8].includes(body.length) || !/^[\da-f]+$/i.test(body)) {
      return null;
    }
    var expanded =
      body.length === 3 || body.length === 4
        ? body
            .split("")
            .map(function duplicate(character) {
              return character + character;
            })
            .join("")
        : body;
    return {
      rgb: [
        parseInt(expanded.slice(0, 2), 16),
        parseInt(expanded.slice(2, 4), 16),
        parseInt(expanded.slice(4, 6), 16),
      ],
      alpha:
        expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  function parseRgbFunction(value) {
    var normalized = value.replace(/\s*\/\s*/g, ",");
    var parts = normalized.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    var rgb = parts.slice(0, 3).map(parseRgbChannel);
    if (rgb.some(function isNull(channel) { return channel === null; })) {
      return null;
    }
    var alpha = parts[3] ? parseAlpha(parts[3]) : 1;
    if (alpha === null) return null;
    return { rgb: rgb, alpha: alpha };
  }

  function parseHslFunction(value) {
    var normalized = value.replace(/\s*\/\s*/g, ",");
    var parts = normalized.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    var hue = parseFloat(parts[0] || "");
    var saturation = parsePercentage(parts[1] || "");
    var lightness = parsePercentage(parts[2] || "");
    var alpha = parts[3] ? parseAlpha(parts[3]) : 1;
    if (
      !Number.isFinite(hue) ||
      saturation === null ||
      lightness === null ||
      alpha === null
    ) {
      return null;
    }

    var chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    var hueSegment = (((hue % 360) + 360) % 360) / 60;
    var secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
    var match = lightness - chroma / 2;
    var triplet =
      hueSegment < 1
        ? [chroma, secondary, 0]
        : hueSegment < 2
          ? [secondary, chroma, 0]
          : hueSegment < 3
            ? [0, chroma, secondary]
            : hueSegment < 4
              ? [0, secondary, chroma]
              : hueSegment < 5
                ? [secondary, 0, chroma]
                : [chroma, 0, secondary];

    return {
      rgb: [
        Math.round((triplet[0] + match) * 255),
        Math.round((triplet[1] + match) * 255),
        Math.round((triplet[2] + match) * 255),
      ],
      alpha: alpha,
    };
  }

  function parseRgbChannel(value) {
    if (/%$/.test(value)) {
      var percentage = parsePercentage(value);
      return percentage === null ? null : Math.round(percentage * 255);
    }
    var numeric = parseFloat(value);
    if (!Number.isFinite(numeric)) return null;
    return clamp(Math.round(numeric), 0, 255);
  }

  function parsePercentage(value) {
    if (!/%$/.test(value)) return null;
    var numeric = parseFloat(value.slice(0, -1));
    if (!Number.isFinite(numeric)) return null;
    return clamp(numeric / 100, 0, 1);
  }

  function parseAlpha(value) {
    if (/%$/.test(value)) return parsePercentage(value);
    var numeric = parseFloat(value);
    if (!Number.isFinite(numeric)) return null;
    return clamp(numeric, 0, 1);
  }

  function extractCssColors(value) {
    if (typeof value !== "string" || !value) return [];
    var samples = [];
    var match;

    var hexPattern = /#[\da-f]{3,8}(?![\da-f])/gi;
    while ((match = hexPattern.exec(value)) !== null) {
      var parsedHex = parseHexColor(match[0]);
      if (parsedHex) samples.push(parsedHex);
    }

    var rgbPattern = /\brgba?\(([^)]+)\)/gi;
    while ((match = rgbPattern.exec(value)) !== null) {
      var parsedRgb = parseRgbFunction(match[1]);
      if (parsedRgb) samples.push(parsedRgb);
    }

    var hslPattern = /\bhsla?\(([^)]+)\)/gi;
    while ((match = hslPattern.exec(value)) !== null) {
      var parsedHsl = parseHslFunction(match[1]);
      if (parsedHsl) samples.push(parsedHsl);
    }

    var namedPattern = /\b(?:black|white)\b/gi;
    while ((match = namedPattern.exec(value)) !== null) {
      samples.push({
        rgb: match[0].toLowerCase() === "black" ? [0, 0, 0] : [255, 255, 255],
        alpha: 1,
      });
    }

    return samples;
  }

  function requiredVeilOpacity(samples, textColors, veil) {
    var required = 0;
    for (var sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      var sample = samples[sampleIndex];
      for (var textIndex = 0; textIndex < textColors.length; textIndex += 1) {
        var textColor = textColors[textIndex];
        if (contrastRatio(textColor, sample) >= 4.5) continue;
        var low = 0;
        var high = 1;
        for (var iteration = 0; iteration < 18; iteration += 1) {
          var midpoint = (low + high) / 2;
          var supported = compositeRgb(veil, sample, midpoint);
          if (contrastRatio(textColor, supported) >= 4.5) {
            high = midpoint;
          } else {
            low = midpoint;
          }
        }
        required = Math.max(required, high);
      }
    }
    return required;
  }

  function resolveAppBackgroundReadability(branding, appBackground, appBackgroundKind) {
    if (
      !isRecord(branding) ||
      !isRecord(appBackground) ||
      !isRecord(branding.surfaceTheme) ||
      appBackgroundKind === "none" ||
      appBackgroundKind === "effect"
    ) {
      return null;
    }

    var foreground = parseCssColor(branding.surfaceTheme.foreground);
    var mutedForeground = parseCssColor(branding.surfaceTheme.mutedForeground);
    if (!foreground || !mutedForeground) return null;

    var fallback =
      parseCssColor(
        appBackgroundKind === "texture" && isRecord(appBackground.texture)
          ? appBackground.texture.background
          : branding.bgPrimary,
      ) || parseCssColor(branding.bgPrimary);

    if (appBackgroundKind === "texture" && isRecord(appBackground.texture)) {
      var textureBackground = parseCssColor(appBackground.texture.background);
      var textureColor = parseCssColor(appBackground.texture.color);
      if (!textureBackground) return null;
      var texturedSamples = textureColor
        ? uniqueRgb([
            textureBackground.rgb,
            compositeRgb(
              textureColor.rgb,
              textureBackground.rgb,
              clamp(appBackground.texture.opacity, 0, 1),
            ),
          ])
        : [textureBackground.rgb];
      return resolveReadabilityOverlay(texturedSamples, [foreground.rgb, mutedForeground.rgb]);
    } else {
      var gradientSamples = resolveGradientSamples(
        extractCssColors(appBackground.gradient),
        fallback ? fallback.rgb : null,
      );
      var samples = gradientSamples.slice();
      if (
        appBackgroundKind === "gradient" &&
        typeof branding.themePresetId === "string" &&
        branding.themePresetId.indexOf("concept-") === 0 &&
        isRecord(appBackground.texture)
      ) {
        var conceptColor = parseCssColor(appBackground.texture.color);
        if (conceptColor) {
          samples = samples.concat(
            resolveSoftLightTextureSamples(
              gradientSamples,
              conceptColor.rgb,
              clamp(appBackground.texture.opacity, 0, 1),
            ),
          );
        }
      }
      return resolveReadabilityOverlay(uniqueRgb(samples), [foreground.rgb, mutedForeground.rgb]);
    }
  }

  function resolveVeilCandidate(samples, textColors, veilRgb) {
    var rawOpacity = requiredVeilOpacity(samples, textColors, veilRgb);
    if (rawOpacity <= 0) return null;
    var veilOpacity = roundOpacity(clamp(rawOpacity + 0.03, 0, 0.88));
    if (!supportsContrast(samples, textColors, veilRgb, veilOpacity)) {
      return null;
    }
    return { veilRgb: veilRgb, rawOpacity: rawOpacity, veilOpacity: veilOpacity };
  }

  function supportsContrast(samples, textColors, veilRgb, veilOpacity) {
    for (var sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      var supported = compositeRgb(veilRgb, samples[sampleIndex], veilOpacity);
      for (var textIndex = 0; textIndex < textColors.length; textIndex += 1) {
        if (contrastRatio(textColors[textIndex], supported) < 4.5) {
          return false;
        }
      }
    }
    return true;
  }

  function resolveReadabilityOverlay(samples, textColors) {
    if (samples.length === 0) return null;
    var candidates = [
      resolveVeilCandidate(samples, textColors, [0, 0, 0]),
      resolveVeilCandidate(samples, textColors, [255, 255, 255]),
    ].filter(Boolean);
    if (candidates.length === 0) return null;
    candidates.sort(function sortByRequirement(left, right) {
      return left.rawOpacity - right.rawOpacity;
    });
    var chosen = candidates[0];
    var channels = rgbChannels(chosen.veilRgb);
    var edgeOpacity = roundOpacity(clamp(chosen.veilOpacity + 0.12, 0, 0.88));

    return (
      "linear-gradient(180deg, " +
      "rgb(" +
      channels +
      " / " +
      edgeOpacity +
      ") 0%, " +
      "rgb(" +
      channels +
      " / " +
      chosen.veilOpacity +
      ") 16%, " +
      "rgb(" +
      channels +
      " / " +
      chosen.veilOpacity +
      ") 28%, " +
      "rgb(" +
      channels +
      " / " +
      chosen.veilOpacity +
      ") 40%, " +
      "rgb(" +
      channels +
      " / " +
      chosen.veilOpacity +
      ") 60%, " +
      "rgb(" +
      channels +
      " / " +
      chosen.veilOpacity +
      ") 72%, " +
      "rgb(" +
      channels +
      " / " +
      chosen.veilOpacity +
      ") 84%, " +
      "rgb(" +
      channels +
      " / " +
      edgeOpacity +
      ") 100%)"
    );
  }

  function resolveGradientSamples(samples, fallback) {
    var opaqueBackdrops = uniqueRgb(
      samples
        .filter(function isOpaque(sample) {
          return sample.alpha >= 1;
        })
        .map(function pickRgb(sample) {
          return sample.rgb;
        })
        .concat(fallback ? [fallback] : []),
    );
    var backdrops =
      opaqueBackdrops.length > 0 ? opaqueBackdrops : fallback ? [fallback] : [];
    var translucent = samples.filter(function isTranslucent(sample) {
      return sample.alpha < 1;
    });
    var resolved = samples.flatMap(function resolve(sample) {
      if (sample.alpha >= 1) return [sample.rgb];
      return backdrops.map(function compositeBackdrop(backdrop) {
        return compositeRgb(sample.rgb, backdrop, sample.alpha);
      });
    });
    var stacked = backdrops.flatMap(function resolveBackdrop(backdrop) {
      return translucent.flatMap(function resolveLower(lower) {
        var lowerComposite = compositeRgb(lower.rgb, backdrop, lower.alpha);
        return translucent.map(function resolveUpper(upper) {
          return compositeRgb(upper.rgb, lowerComposite, upper.alpha);
        });
      });
    });
    return uniqueRgb(
      resolved
        .concat(stacked)
        .concat(interpolateRgbStates(resolved))
        .concat(interpolateRgbStates(stacked)),
    );
  }

  function resolveSoftLightTextureSamples(baseSamples, textureColor, opacity) {
    if (opacity <= 0) return [];
    var alphaStates = [0.25, 0.5, 0.75, 1]
      .map(function alphaStep(step) {
        return roundOpacity(clamp(opacity * step, 0, 1));
      })
      .filter(function uniqueAlpha(alpha, index, values) {
        return alpha > 0 && values.indexOf(alpha) === index;
      });
    var textured = baseSamples.flatMap(function resolveBase(base) {
      return alphaStates.map(function resolveAlpha(alpha) {
        return compositeRgb(softLightBlend(textureColor, base), base, alpha);
      });
    });
    return uniqueRgb(textured.concat(interpolateRgbStates(textured)));
  }

  function interpolateRgbStates(samples) {
    var blended = [];
    for (var left = 0; left < samples.length; left += 1) {
      for (var right = left + 1; right < samples.length; right += 1) {
        blended.push(mixRgb(samples[left], samples[right], 0.25));
        blended.push(mixRgb(samples[left], samples[right], 0.5));
        blended.push(mixRgb(samples[left], samples[right], 0.75));
      }
    }
    return uniqueRgb(blended);
  }

  function softLightBlend(source, backdrop) {
    return [
      softLightChannel(source[0], backdrop[0]),
      softLightChannel(source[1], backdrop[1]),
      softLightChannel(source[2], backdrop[2]),
    ];
  }

  function softLightChannel(source, backdrop) {
    var s = source / 255;
    var b = backdrop / 255;
    var value =
      s <= 0.5
        ? b - (1 - 2 * s) * b * (1 - b)
        : b + (2 * s - 1) * (softLightCurve(b) - b);
    return Math.round(clamp(value, 0, 1) * 255);
  }

  function softLightCurve(value) {
    if (value <= 0.25) {
      return ((16 * value - 12) * value + 4) * value;
    }
    return Math.sqrt(value);
  }

  function mixRgb(left, right, alpha) {
    return [
      Math.round(left[0] * (1 - alpha) + right[0] * alpha),
      Math.round(left[1] * (1 - alpha) + right[1] * alpha),
      Math.round(left[2] * (1 - alpha) + right[2] * alpha),
    ];
  }

  function uniqueRgb(samples) {
    var seen = new Set();
    var unique = [];
    for (var index = 0; index < samples.length; index += 1) {
      var sample = samples[index];
      var key = sample.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(sample);
    }
    return unique;
  }

  function texturePattern(pattern, stroke, opacity) {
    switch (pattern) {
      case "dots":
        return '<circle cx="20" cy="20" r="2.4" fill="' + stroke + '"/>';
      case "grid":
        return '<path d="M0 0H40M0 0V40" stroke="' + stroke + '" stroke-width="1.2" fill="none"/>';
      case "diagonal":
        return '<path d="M-4 4L4 -4M0 40L40 0M36 44L44 36" stroke="' + stroke + '" stroke-width="1.4" fill="none"/>';
      case "cross":
        return '<path d="M20 14V26M14 20H26" stroke="' + stroke + '" stroke-width="1.4" fill="none"/>';
      case "waves":
        return '<path d="M0 30 Q10 18 20 30 T40 30" stroke="' + stroke + '" stroke-width="1.4" fill="none"/>';
      case "carbon":
        return '<path d="M0 10H20V30H40M0 30H20V10H40" stroke="' + stroke + '" stroke-width="1.2" fill="none"/>';
      case "triangles":
        return '<path d="M20 8L32 30H8Z" stroke="' + stroke + '" stroke-width="1.2" fill="none"/>';
      case "noise":
        return (
          '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise"/>' +
          '<feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.75 0" result="mask"/>' +
          '<feFlood flood-color="' +
          stroke +
          '" flood-opacity="' +
          Math.min(1, Math.max(0, opacity)) +
          '" result="tint"/><feComposite in="tint" in2="mask" operator="in"/></filter>' +
          '<rect width="40" height="40" filter="url(#n)"/>'
        );
      default:
        return null;
    }
  }

  function buildTextureBackground(texture) {
    if (
      !isRecord(texture) ||
      !isHex(texture.color) ||
      !isHex(texture.background) ||
      typeof texture.pattern !== "string" ||
      !isFiniteNumber(texture.opacity) ||
      !isFiniteNumber(texture.scale)
    ) {
      return null;
    }
    var opacity = Math.min(1, Math.max(0.05, texture.opacity));
    var stroke =
      texture.pattern === "noise"
        ? texture.color
        : toRgba(texture.color, opacity);
    var inner = texturePattern(texture.pattern, stroke, opacity);
    if (inner === null) return null;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
      inner +
      "</svg>";
    return {
      color: texture.background,
      image:
        'url("data:image/svg+xml,' +
        encodeURIComponent(svg).replace(/'/g, "%27").replace(/"/g, "%22") +
        '")',
      size:
        Math.min(256, Math.max(8, Math.round(texture.scale))) +
        "px " +
        Math.min(256, Math.max(8, Math.round(texture.scale))) +
        "px",
    };
  }

  try {
    var rawSnapshot = window.localStorage.getItem(STORAGE_KEY);
    if (!rawSnapshot || rawSnapshot.length > MAX_SNAPSHOT_LENGTH) return;

    var snapshot = JSON.parse(rawSnapshot);
    if (!isRecord(snapshot) || !isRecord(snapshot.branding)) return;

    var branding = snapshot.branding;
    if (
      !isHex(branding.primary) ||
      !isHex(branding.primaryFg) ||
      !isHex(branding.bgPrimary) ||
      !isHex(branding.bgSecondary) ||
      typeof branding.fontFamily !== "string"
    ) {
      return;
    }

    var root = document.documentElement;
    var style = root.style;
    var set = style.setProperty.bind(style);
    set("--brand-primary", branding.primary);
    set("--brand-primary-fg", branding.primaryFg);
    set("--brand-bg-primary", branding.bgPrimary);
    set("--brand-bg-secondary", branding.bgSecondary);
    set("--brand-font", branding.fontFamily);

    if (isSafeGradient(branding.cardGradient)) {
      set("--brand-card-gradient", branding.cardGradient);
    }
    if (
      branding.cardPattern === "none" ||
      isSafeGradient(branding.cardPattern)
    ) {
      set("--brand-card-pattern", branding.cardPattern);
    }

    var surface = branding.surfaceTheme;
    if (
      isRecord(surface) &&
      isHex(surface.foreground) &&
      isHex(surface.mutedForeground) &&
      isHex(surface.surface) &&
      isHex(surface.surfaceHigh) &&
      isHex(surface.borderSoft) &&
      isHex(surface.borderStrong) &&
      isFiniteNumber(surface.surfaceOpacity) &&
      isFiniteNumber(surface.surfaceHighOpacity) &&
      isFiniteNumber(surface.borderSoftOpacity) &&
      isFiniteNumber(surface.borderStrongOpacity) &&
      isFiniteNumber(surface.glassBlurPx)
    ) {
      set("--brand-foreground", surface.foreground);
      set("--brand-muted-foreground", surface.mutedForeground);
      set("--brand-surface", surface.surface);
      set("--brand-surface-high", surface.surfaceHigh);
      set("--color-surface", toRgba(surface.surface, surface.surfaceOpacity));
      set(
        "--color-surface-high",
        toRgba(surface.surfaceHigh, surface.surfaceHighOpacity),
      );
      set(
        "--color-border-soft",
        toRgba(surface.borderSoft, surface.borderSoftOpacity),
      );
      set(
        "--color-border-strong",
        toRgba(surface.borderStrong, surface.borderStrongOpacity),
      );
      set("--foreground", surface.foreground);
      set("--card-foreground", surface.foreground);
      set("--popover-foreground", surface.foreground);
      set("--secondary-foreground", surface.foreground);
      set("--accent-foreground", surface.foreground);
      set("--sidebar-foreground", surface.foreground);
      set("--muted-foreground", surface.mutedForeground);
      set("--glass-blur", Math.min(40, Math.max(0, surface.glassBlurPx)) + "px");
    }

    var radii = RADII[branding.borderRadius] || RADII["rounded-2xl"];
    if (
      isRecord(branding.cornerRadii) &&
      isFiniteNumber(branding.cornerRadii.cardPx) &&
      branding.cornerRadii.cardPx >= 0 &&
      branding.cornerRadii.cardPx <= 48 &&
      isFiniteNumber(branding.cornerRadii.itemPx) &&
      branding.cornerRadii.itemPx >= 0 &&
      branding.cornerRadii.itemPx <= 32 &&
      isFiniteNumber(branding.cornerRadii.pillPx) &&
      branding.cornerRadii.pillPx >= 0 &&
      branding.cornerRadii.pillPx <= 9999
    ) {
      radii = [
        branding.cornerRadii.cardPx + "px",
        branding.cornerRadii.itemPx + "px",
        branding.cornerRadii.pillPx + "px",
      ];
    }
    set("--radius-card", radii[0]);
    set("--radius-item", radii[1]);
    set("--radius-pill", radii[2]);
    set("--radius", radii[1]);

    var appBackground = branding.appBackground;
    if (isRecord(appBackground)) {
      var bootstrapBackground = null;
      var appBackgroundKind = appBackground.kind;
      if (typeof appBackgroundKind !== "string") {
        appBackgroundKind =
          typeof appBackground.effect === "string" &&
          appBackground.effect !== "NONE"
            ? "effect"
            : "none";
      }
      var usesStaticGradient =
        appBackgroundKind === "gradient" ||
        (appBackgroundKind === "effect" &&
          typeof appBackground.effect === "string" &&
          appBackground.effect !== "NONE");
      var readabilityOverlay = resolveAppBackgroundReadability(
        branding,
        appBackground,
        appBackgroundKind,
      );
      if (usesStaticGradient && isSafeGradient(appBackground.gradient)) {
        var conceptTexture =
          appBackgroundKind === "gradient" &&
          typeof branding.themePresetId === "string" &&
          branding.themePresetId.indexOf("concept-") === 0
            ? buildTextureBackground(appBackground.texture)
            : null;
        bootstrapBackground = {
          color: branding.bgPrimary,
          image:
            readabilityOverlay !== null && conceptTexture !== null
              ? readabilityOverlay +
                ", " +
                conceptTexture.image +
                ", " +
                appBackground.gradient
              : readabilityOverlay !== null
                ? readabilityOverlay + ", " + appBackground.gradient
                : conceptTexture !== null
                  ? conceptTexture.image + ", " + appBackground.gradient
                  : appBackground.gradient,
          size:
            readabilityOverlay !== null && conceptTexture !== null
              ? "cover, " + conceptTexture.size + ", cover"
              : readabilityOverlay !== null
                ? "cover, cover"
                : conceptTexture !== null
                  ? conceptTexture.size + ", cover"
                  : "cover",
          blend:
            readabilityOverlay !== null && conceptTexture !== null
              ? "normal, soft-light, normal"
              : readabilityOverlay !== null
                ? "normal, normal"
                : conceptTexture !== null
                  ? "soft-light, normal"
                  : "normal",
        };
      } else if (appBackgroundKind === "texture") {
        var textureBackground = buildTextureBackground(appBackground.texture);
        if (textureBackground !== null && readabilityOverlay !== null) {
          bootstrapBackground = {
            color: textureBackground.color,
            image: readabilityOverlay + ", " + textureBackground.image,
            size: "cover, " + textureBackground.size,
            blend: "normal, normal",
          };
        } else {
          bootstrapBackground = textureBackground;
        }
      }
      if (bootstrapBackground !== null) {
        set("--bootstrap-app-background-color", bootstrapBackground.color);
        set("--bootstrap-app-background-image", bootstrapBackground.image);
        set("--bootstrap-app-background-size", bootstrapBackground.size);
        set(
          "--bootstrap-app-background-blend",
          bootstrapBackground.blend || "normal",
        );
        root.dataset.bootstrapAppBackground = "true";
        root.dataset.bootstrapAppBackgroundKind = appBackgroundKind;
      }
    }

    var scheme = luminance(branding.bgPrimary) >= 0.42 ? "light" : "dark";
    style.colorScheme = scheme;
    root.classList.toggle("dark", scheme === "dark");
    root.dataset.themeScheme = scheme;
    if (typeof branding.themePresetId === "string" && branding.themePresetId) {
      root.dataset.themePreset = branding.themePresetId;
      root.dataset.themePresetVersion = String(branding.themePresetVersion || 1);
    }

    var themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = branding.bgPrimary;
    if (typeof branding.brandName === "string" && branding.brandName.trim()) {
      document.title = branding.brandName.trim();
    }
  } catch (_error) {
    // Storage access and corrupt snapshots are non-fatal; the built-in theme
    // remains the deterministic fallback.
  }
})();

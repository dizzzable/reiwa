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
      if (usesStaticGradient && isSafeGradient(appBackground.gradient)) {
        bootstrapBackground = {
          color: branding.bgPrimary,
          image: appBackground.gradient,
          size: "cover",
        };
      } else if (appBackgroundKind === "texture") {
        bootstrapBackground = buildTextureBackground(appBackground.texture);
      }
      if (bootstrapBackground !== null) {
        set("--bootstrap-app-background-color", bootstrapBackground.color);
        set("--bootstrap-app-background-image", bootstrapBackground.image);
        set("--bootstrap-app-background-size", bootstrapBackground.size);
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

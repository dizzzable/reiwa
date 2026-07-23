/**
 * Parses a hex colour (`#rgb` / `#rrggbb`) into an `[r, g, b]` triple of
 * 0-255 integers. Returns the brand emerald as a safe fallback.
 *
 * Keep this module dependency-free: card lifecycle policies are exercised by
 * the root test suite, where frontend-only packages are intentionally absent.
 */
function hexToRgb(hex: string): [number, number, number] {
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((character) => character + character)
      .join("");
  }
  if (value.length !== 6 || /[^0-9a-fA-F]/.test(value)) {
    return [34, 197, 94];
  }
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(red: number, green: number, blue: number): string {
  const clamp = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)));
  return `#${[clamp(red), clamp(green), clamp(blue)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Lightens (positive amount) or darkens (negative amount) a hex colour by
 * mixing it toward white/black. `amount` is 0-1.
 */
function shadeHex(hex: string, amount: number): string {
  const [red, green, blue] = hexToRgb(hex);
  if (amount >= 0) {
    return rgbToHex(
      red + (255 - red) * amount,
      green + (255 - green) * amount,
      blue + (255 - blue) * amount,
    );
  }
  const coefficient = 1 + amount;
  return rgbToHex(
    red * coefficient,
    green * coefficient,
    blue * coefficient,
  );
}

/**
 * Derives a three-stop aurora ramp from a single brand colour.
 */
export function brandAuroraStops(
  primary: string,
): [string, string, string] {
  return [
    shadeHex(primary, -0.25),
    shadeHex(primary, 0.35),
    shadeHex(primary, -0.1),
  ];
}

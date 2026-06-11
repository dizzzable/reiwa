/**
 * FlagIcon — tiny inline SVG country flags.
 *
 * Emoji flags (🇷🇺/🇬🇧) don't render on Windows/some desktops — they fall back
 * to the two regional-indicator letters ("RU"/"GB"), which looks broken. These
 * hand-rolled SVGs render identically everywhere (web + Mini App).
 */
type FlagCode = "RU" | "GB";

export function FlagIcon({
  code,
  className = "h-5 w-7",
}: {
  code: FlagCode;
  className?: string;
}) {
  return (
    <span
      className={`inline-block overflow-hidden rounded-[3px] ring-1 ring-white/10 ${className}`}
      aria-hidden="true"
    >
      {code === "RU" ? <RuFlag /> : <GbFlag />}
    </span>
  );
}

function RuFlag() {
  return (
    <svg viewBox="0 0 9 6" className="h-full w-full" preserveAspectRatio="none">
      <rect width="9" height="6" fill="#fff" />
      <rect width="9" height="4" y="2" fill="#0039a6" />
      <rect width="9" height="2" y="4" fill="#d52b1e" />
    </svg>
  );
}

function GbFlag() {
  return (
    <svg viewBox="0 0 60 30" className="h-full w-full" preserveAspectRatio="none">
      <clipPath id="flag-gb-a">
        <path d="M0 0v30h60V0z" />
      </clipPath>
      <clipPath id="flag-gb-b">
        <path d="M30 15h30v15zv15H0zH0V0zV0h30z" />
      </clipPath>
      <g clipPath="url(#flag-gb-a)">
        <path d="M0 0v30h60V0z" fill="#012169" />
        <path d="M0 0 60 30m0-30L0 30" stroke="#fff" strokeWidth="6" />
        <path
          d="M0 0 60 30m0-30L0 30"
          clipPath="url(#flag-gb-b)"
          stroke="#c8102e"
          strokeWidth="4"
        />
        <path d="M30 0v30M0 15h60" stroke="#fff" strokeWidth="10" />
        <path d="M30 0v30M0 15h60" stroke="#c8102e" strokeWidth="6" />
      </g>
    </svg>
  );
}

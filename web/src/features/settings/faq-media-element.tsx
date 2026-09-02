import type { FaqMediaKind } from "./faq-media";

export function FaqMediaElement({
  kind,
  url,
  label,
  onError,
}: {
  kind: Exclude<FaqMediaKind, "unsupported">;
  url: string;
  label: string;
  onError: () => void;
}) {
  // `aspect-video`, and not just a max height, because the operator's file has
  // no dimensions we know before it arrives. Without a reserved box the slot is
  // 0 tall until the bytes land and then jumps to 320, moving the answer text
  // the reader is in the middle of. `object-contain` keeps the reservation from
  // cropping or stretching anything that is not 16/9.
  if (kind === "image") {
    return (
      <img
        src={url}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={onError}
        className="aspect-video max-h-80 w-full object-contain"
      />
    );
  }

  return (
    <video
      src={url}
      aria-label={label}
      controls
      playsInline
      preload="metadata"
      onError={onError}
      className="aspect-video max-h-80 w-full bg-black object-contain"
    />
  );
}

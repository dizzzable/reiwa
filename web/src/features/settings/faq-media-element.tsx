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
  if (kind === "image") {
    return (
      <img
        src={url}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={onError}
        className="max-h-80 w-full object-contain"
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
      className="max-h-80 w-full bg-black object-contain"
    />
  );
}

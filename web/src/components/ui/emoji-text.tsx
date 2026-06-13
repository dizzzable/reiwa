import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AnimationItem } from "lottie-web";

import { getCustomEmojiPacks, type CustomEmojiItem } from "@/lib/api-client";

/**
 * EmojiText
 * ─────────
 * Renders text that may contain custom-emoji shortcodes (`:slug:`), replacing
 * each known shortcode with the operator-uploaded emoji. Static emojis render
 * as an `<img>`; animated ones (with a `lottieUrl`) render via lottie-web,
 * lazily mounted and autoplaying on a loop only while on screen. Unknown
 * shortcodes are left as plain text. Used by the cabinet notification feed.
 */
function useEmojiMap(): Map<string, CustomEmojiItem> {
  const { data } = useQuery({
    queryKey: ["custom-emoji-packs"],
    queryFn: getCustomEmojiPacks,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const map = new Map<string, CustomEmojiItem>();
    for (const pack of data ?? []) {
      for (const emoji of pack.emojis) map.set(emoji.slug, emoji);
    }
    return map;
  }, [data]);
}

const SHORTCODE_RE = /:([a-z0-9_]+):/g;

const EMOJI_CLASS = "inline-block h-[1.15em] w-[1.15em] align-[-0.2em]";

/**
 * Animated custom emoji. Loads the Lottie JSON (gunzipped server-side from the
 * Telegram `.tgs`) and plays it on a loop, but only mounts the player once the
 * element scrolls into view to keep long feeds light. Falls back to the static
 * preview image until then (and if the animation fails to load).
 */
function LottieEmoji({ emoji }: { readonly emoji: CustomEmojiItem }) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !emoji.lottieUrl) return;
    const node = containerRef.current;
    if (!node) return;
    let anim: AnimationItem | null = null;
    let cancelled = false;
    void import("lottie-web/build/player/lottie_light").then((mod) => {
      if (cancelled || !containerRef.current) return;
      anim = (mod.default ?? mod).loadAnimation({
        container: containerRef.current,
        renderer: "svg",
        loop: true,
        autoplay: true,
        path: emoji.lottieUrl!,
      });
      anim.addEventListener("DOMLoaded", () => setReady(true));
    });
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [visible, emoji.lottieUrl]);

  return (
    <span
      ref={containerRef}
      className={`${EMOJI_CLASS} relative`}
      title={emoji.name}
      role="img"
      aria-label={emoji.fallback ?? emoji.name}
    >
      {!ready && (
        <img
          src={emoji.imageUrl}
          alt={emoji.fallback ?? emoji.name}
          className="absolute inset-0 h-full w-full object-contain"
        />
      )}
    </span>
  );
}

export function EmojiText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const map = useEmojiMap();

  const nodes = useMemo(() => {
    const out: Array<string | CustomEmojiItem> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    SHORTCODE_RE.lastIndex = 0;
    while ((match = SHORTCODE_RE.exec(text)) !== null) {
      const emoji = map.get(match[1]!);
      if (!emoji) continue;
      if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
      out.push(emoji);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) out.push(text.slice(lastIndex));
    return out;
  }, [text, map]);

  // Fast path: no custom emoji matched — render plain text.
  if (nodes.length <= 1 && typeof nodes[0] !== "object") {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={className}>
      {nodes.map((node, i) =>
        typeof node === "string" ? (
          <span key={i}>{node}</span>
        ) : node.lottieUrl ? (
          <LottieEmoji key={i} emoji={node} />
        ) : (
          <img
            key={i}
            src={node.imageUrl}
            alt={node.fallback ?? node.name}
            title={node.name}
            className={EMOJI_CLASS}
            loading="lazy"
          />
        ),
      )}
    </span>
  );
}

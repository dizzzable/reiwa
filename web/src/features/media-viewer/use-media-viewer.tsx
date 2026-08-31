import { useCallback, useState } from "react";

import { MediaViewer } from "./media-viewer";
import type { MediaViewerItem } from "./media-viewer-item";
import { clampIndex } from "./media-viewer-nav";

/**
 * Opens the media viewer from anywhere, without every caller re-plumbing the
 * same four props.
 *
 * ── Why the list is a parameter and not an argument to `open` ─────────────
 *
 * It used to be frozen at the moment of opening, and that was wrong wherever
 * the list is still filling in. The panel fetches ticket screenshots one after
 * another; an operator who tapped the first thumbnail the moment it appeared
 * got a viewer holding a one-item list — no counter, no arrows, no paging —
 * that never recovered, which is precisely the complaint the viewer exists to
 * answer. Keeping the list a live prop means the viewer grows as the thread
 * loads.
 *
 * The paging callback is why this is a hook rather than four props per caller:
 * a caller that renders the viewer but forgets `onIndexChange` gets a viewer
 * that looks right and simply refuses to turn the page — a failure nothing
 * about the call site would reveal.
 *
 * Returns the element to render — `null` while closed — so the caller drops it
 * anywhere in its tree and the viewer portals itself out from there.
 */
export function useMediaViewer(items: readonly MediaViewerItem[]): {
  readonly open: (index: number) => void;
  readonly element: React.JSX.Element | null;
} {
  const [index, setIndex] = useState<number | null>(null);

  const open = useCallback((at: number) => {
    // An empty list would open a black screen with nothing but a close button;
    // the index is clamped on render, against the list as it is by then.
    setIndex(at);
  }, []);

  const current = index === null ? -1 : clampIndex(index, items.length);
  const element =
    current >= 0 ? (
      <MediaViewer
        items={items}
        index={current}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
      />
    ) : null;

  return { open, element };
}

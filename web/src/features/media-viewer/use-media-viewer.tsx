import { useCallback, useState } from "react";

import { MediaViewer } from "./media-viewer";
import type { MediaViewerItem } from "./media-viewer-item";
import { clampIndex } from "./media-viewer-nav";

/**
 * Opens the media viewer from anywhere, without every caller re-plumbing the
 * same four props.
 *
 * The paging callback is the reason this exists rather than four copies of a
 * `useState`: a caller that renders the viewer but forgets `onIndexChange` gets
 * a viewer that looks right and simply refuses to turn the page, which is a
 * failure nothing about the call site would reveal.
 *
 * Returns the element to render — `null` while closed — so the caller drops it
 * anywhere in its tree and the viewer portals itself out from there.
 */
export function useMediaViewer(): {
  readonly open: (items: readonly MediaViewerItem[], index: number) => void;
  readonly element: React.JSX.Element | null;
} {
  const [state, setState] = useState<{
    items: readonly MediaViewerItem[];
    index: number;
  } | null>(null);

  const open = useCallback((items: readonly MediaViewerItem[], index: number) => {
    // An empty list would open an empty black screen with no way back except
    // the close button; refusing here keeps that off the screen entirely.
    if (items.length === 0) return;
    setState({ items, index: clampIndex(index, items.length) });
  }, []);

  const element = state ? (
    <MediaViewer
      items={state.items}
      index={state.index}
      onIndexChange={(index) => setState((prev) => (prev ? { ...prev, index } : prev))}
      onClose={() => setState(null)}
    />
  ) : null;

  return { open, element };
}

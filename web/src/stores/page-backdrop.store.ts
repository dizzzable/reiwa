import { create } from "zustand";

/**
 * page-backdrop
 * ─────────────
 * A route asking the shell to paint the whole content area, not just its own
 * column.
 *
 * ── Why a route cannot do this itself ────────────────────────────────────────
 *
 * The connect screen wears a concept the operator picked for it, and a concept
 * is a palette AND a ground. The palette travels fine: the screen declares the
 * tokens on its own element and everything under it reads them. The ground does
 * not — the screen is rendered inside `<main>`'s centred `max-w-[46rem]` column,
 * so painting it there produces a themed rectangle floating in the cabinet's own
 * black, with two visible seams down the sides. Reported as exactly that:
 * "что за обрубки по бокам".
 *
 * There is no CSS from inside the column that reaches the column's parent. So
 * the route publishes its ground here and the shell paints it on `<main>`.
 *
 * ── Why this cannot reach the sidebar ────────────────────────────────────────
 *
 * By construction, and that is the point. `<main>` is a sibling of the
 * navigation, so a background on it stops where the navigation begins — the
 * sidebar on a desktop, the floating capsule on a phone. Both keep the
 * cabinet's own appearance, which is what was asked for: the page is painted,
 * the navigation is not.
 *
 * ── Why it is a store and not a context ──────────────────────────────────────
 *
 * The publisher is a lazily-loaded route and the consumer is the shell above
 * it, so the value travels UP. A context would have to be provided by the shell
 * and written by the route through a callback, which is the same thing with
 * more plumbing — and it would make the screen unrenderable outside the shell,
 * which is how its own tests render it.
 */
export interface PageBackdrop {
  /** The flat ground under the artwork. */
  readonly backgroundColor: string | null;
  /** Gradient layers. Validated by the route before it gets here. */
  readonly backgroundImage: string | null;
  /**
   * The 4px accent rail down the left edge of the content area.
   *
   * The concept draws it at the edge of the SCREEN, and in the cabinet the
   * screen begins where the sidebar ends — so it belongs to the shell for the
   * same reason the ground does.
   */
  readonly rail: string | null;
}

interface PageBackdropState {
  backdrop: PageBackdrop | null;
  /** Publish, or clear with `null`. A route clears on its way out. */
  setBackdrop: (backdrop: PageBackdrop | null) => void;
}

export const usePageBackdropStore = create<PageBackdropState>((set) => ({
  backdrop: null,
  setBackdrop: (backdrop) => set({ backdrop }),
}));

/**
 * The order in which the servers screen arrives.
 *
 * The gesture is a double tap on a card, and what it was for is the planet — so
 * the planet leads and everything else follows it in. The numbers live here
 * rather than inline for the same reason `SUBSCRIPTION_DELETION_TIMING` does:
 * the sequence IS the design, and a sequence spread across six `delay:` props
 * cannot be read in one place or checked at all.
 *
 * Everything animates `opacity` and `transform` and nothing else. The backdrop's
 * blur is set once and never animated — animating `backdrop-filter` re-rasterises
 * the whole page underneath on every frame, which on a phone is the difference
 * between a reveal and a stutter.
 *
 * Under `prefers-reduced-motion` none of this runs: the screen is simply there.
 * The reader who asked not to be moved still gets the planet and the list, at
 * rest, in the same places.
 */
export const SERVERS_SHEET_MOTION = {
  /** The blurred page behind. First and quick — nothing is waiting on it. */
  backdrop: { duration: 0.26 },
  /** Title and close, straight after, so there is something to read at once. */
  header: { duration: 0.26, delay: 0.04 },
  /**
   * The planet.
   *
   * The longest and the slowest of them, because it is the answer to the
   * gesture. It grows from slightly small rather than sliding: a sphere that
   * arrives by settling into place reads as an object, one that arrives by
   * sliding reads as a panel.
   */
  planet: { duration: 0.55, delay: 0.08, scaleFrom: 0.9 },
  /**
   * How long the WebGL canvas takes to fade up once it has drawn its first
   * frame.
   *
   * The globe component reveals itself by flipping an inline `opacity` from 0
   * to 1 the moment the scene is built. Left alone that is a pop, and it lands
   * whenever the lazily-loaded chunk happens to finish — which is exactly when
   * the box around it has finished its own animation. The transition in
   * `servers-sheet-motion.css` turns that flip into this fade, so the planet
   * arrives smoothly however late it is ready.
   */
  canvasRevealMs: 420,
  /** The one to use now, once there is a planet to read it against. */
  recommended: { duration: 0.3, delay: 0.3 },
  /** And the list behind it, one row after another. */
  list: { duration: 0.28, delay: 0.36, stagger: 0.035 },
  /**
   * The stagger stops compounding here.
   *
   * Fourteen servers at 35ms each is half a second of list; forty would be a
   * second and a half of a customer watching rows arrive. Past this many, the
   * remainder come in together — the effect has already been made.
   */
  maxStaggeredRows: 10,
} as const;

/** When row `index` starts, in seconds from the screen opening. */
export function rowDelay(index: number): number {
  const stepped = Math.min(index, SERVERS_SHEET_MOTION.maxStaggeredRows);
  return SERVERS_SHEET_MOTION.list.delay + stepped * SERVERS_SHEET_MOTION.list.stagger;
}

/** Everything is on screen by this point, in seconds. */
export function totalDuration(rows: number): number {
  const last = rows > 0 ? rowDelay(rows - 1) + SERVERS_SHEET_MOTION.list.duration : 0;
  const planet = SERVERS_SHEET_MOTION.planet.delay + SERVERS_SHEET_MOTION.planet.duration;
  return Math.max(planet, last);
}

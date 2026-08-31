/**
 * Which item the viewer is showing.
 *
 * Small enough to look obvious and separate anyway, because "obvious" index
 * arithmetic is where an empty list renders item -1 and a stale index outlives
 * the list it pointed into.
 */

/** Forces an index onto a list, or `-1` when there is no list to point at. */
export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isInteger(count) || count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

/**
 * Moves by `delta`, stopping at the ends.
 *
 * Deliberately does NOT wrap. With the two or three pictures an operator
 * attaches to an answer, arriving back at the first one after the last reads as
 * a glitch rather than a loop, and there is no page indicator big enough to
 * explain it.
 */
export function stepIndex(index: number, count: number, delta: number): number {
  const current = clampIndex(index, count);
  if (current < 0) return -1;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return clampIndex(current + step, count);
}

/** Whether a step in this direction would go anywhere. */
export function canStep(index: number, count: number, delta: number): boolean {
  const current = clampIndex(index, count);
  return current >= 0 && stepIndex(index, count, delta) !== current;
}

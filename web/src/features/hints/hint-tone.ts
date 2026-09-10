import type { CabinetHint } from "@/lib/api-client/hints";

/**
 * Which severity a tone is drawn as — separate from the toast library.
 *
 * The tone IS the message's colour and icon; nothing else carries it. A
 * mapping that sends DANGER to the calm blue info toast does not fail, does
 * not warn, and looks like a working hint in every screenshot: the operator
 * wrote "your subscription has ended" and the customer reads it in the same
 * voice as "here is what is new".
 *
 * It lives in its own file so it can be checked without pulling `sonner` into
 * the graph. The cabinet installs its front-end packages under `web/`, and the
 * test runner lives at the repository root — a `vi.mock("sonner")` there
 * resolves to a different module id than the one `hint-toast.ts` imports, so
 * the mock silently does not apply and every assertion about the real mapping
 * passes against the real library having been called with nothing recorded.
 */
export type HintToastSeverity = "info" | "success" | "warning" | "error";

export const HINT_TONE_SEVERITY: Record<CabinetHint["tone"], HintToastSeverity> = {
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  DANGER: "error",
};

/**
 * The stripe a modal draws above its title, by tone.
 *
 * Lives HERE, beside the toast's severity, because the two are one decision
 * made twice — "what does this build do with a tone it does not recognise?" —
 * and they were answering it differently. The modal had `?? TONE_RULE.INFO`
 * written inline, which covers an unknown tone but NOT a tone that happens to
 * name something on `Object.prototype`: `TONE_RULE["constructor"]` is not
 * `undefined`, it is a function inherited from the prototype chain, so `??`
 * never fires. The modal then drew a stripe with no colour class at all, while
 * the same tone made the toast throw before it reached the screen (its lookup
 * fed that function to sonner's table and got `undefined` back).
 *
 * `lookup` below is the shared answer: OWN properties only, so the prototype
 * chain cannot supply a value, and one fallback for everything else.
 *
 * The tone IS a hint's colour — nothing else carries it — and a modal painted
 * entirely in a warning colour reads as an error the customer caused, so it is
 * a rule above the title: enough to set the register, not enough to alarm.
 */
export const HINT_TONE_RAIL: Record<CabinetHint["tone"], string> = {
  INFO: "bg-blue-500/70",
  SUCCESS: "bg-emerald-500/70",
  WARNING: "bg-amber-500/70",
  DANGER: "bg-(--brand-primary)/70",
};

function lookup<T>(table: Record<CabinetHint["tone"], T>, tone: string, fallback: T): T {
  return Object.hasOwn(table, tone) ? table[tone as CabinetHint["tone"]] : fallback;
}

/**
 * The severity for a tone, including one this build has not heard of.
 *
 * The panel's vocabulary is not frozen and the cabinet ships as its own image,
 * so a newer panel can send a tone that is not in the table. Falling back is
 * the only option that keeps the hint on screen — but it falls back to the
 * QUIETEST severity, which means an unknown tone can only ever under-state.
 * That is the safe direction: a warning drawn calmly is a missed emphasis, a
 * routine notice drawn as an error is a false alarm.
 */
export function severityForTone(tone: string): HintToastSeverity {
  return lookup(HINT_TONE_SEVERITY, tone, "info");
}

/** The same fallback, in the same direction, for the modal's stripe. */
export function railForTone(tone: string): string {
  return lookup(HINT_TONE_RAIL, tone, HINT_TONE_RAIL.INFO);
}

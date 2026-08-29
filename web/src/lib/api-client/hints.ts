/**
 * In-cabinet hints — the customer-facing half of the operator's hint library.
 *
 * A hint is raised when something happens (a payment clears, a device is
 * unbound) and shown when the customer next appears, because those are not the
 * same moment. Everything here is best-effort: a failed call means no hint this
 * visit, never an error on a page the customer actually asked for.
 */
import { apiClient } from "./transport.js";

/** One hint, already resolved for this viewer's locale by the panel. */
export interface CabinetHint {
  readonly deliveryId: string;
  readonly key: string;
  readonly mode: string;
  readonly tone: "INFO" | "SUCCESS" | "WARNING" | "DANGER";
  readonly title: string;
  readonly body: string;
  readonly ctaKind: "NONE" | "ROUTE" | "EXTERNAL";
  readonly ctaLabel: string | null;
  readonly ctaTarget: string | null;
}

/**
 * What the panel needs in order to decide whether a hint suits this viewer.
 *
 * The DEVICE half is settled by the layout, which already probes it for the
 * surface report; the LANGUAGE half is added by the controller, which is where
 * i18n lives. Split so neither side carries a field the other overwrites.
 */
export interface HintDevice {
  readonly surface: "tma" | "pwa" | "browser";
  readonly formFactor: "mobile" | "tablet" | "desktop";
}

export type HintAudience = HintDevice & { readonly locale: "ru" | "en" };

/**
 * The next hint to show, or `null`.
 *
 * The audience travels with the question so the panel can filter before
 * answering: several obvious hints are actively wrong on the wrong surface
 * ("install the app" to somebody in the installed app), and deciding that here
 * would mean burning a delivery to discard it.
 */
export const getNextHint = (audience: HintAudience) =>
  apiClient
    .post<{ hint: CabinetHint | null }>("/hints/next", audience)
    .then((r) => r.data.hint)
    .catch(() => null);

/**
 * Tells the panel about a moment only the browser can see.
 *
 * `subscription-ready` is the end of the provisioning poll — the instant a
 * freshly bought subscription's profile becomes usable. There is no server
 * event for it, and "once" in the queue is what makes a page refresh harmless.
 */
export const reportHintMoment = (moment: "subscription-ready") =>
  apiClient
    .post<{ raised: boolean }>("/hints/moment", { moment })
    .then((r) => r.data.raised)
    .catch(() => false);

/** Stamped when it reaches the screen. Losing it re-shows once — no worse. */
export const markHintShown = (deliveryId: string) =>
  apiClient.post("/hints/shown", { deliveryId }).catch(() => undefined);

/**
 * How it ended — followed, or closed.
 *
 * Kept apart because collapsing them makes "this hint helps" indistinguishable
 * from "people close it to be rid of it", which is the only question worth
 * asking of a hint.
 */
export const closeHint = (deliveryId: string, outcome: "acted" | "dismissed") =>
  apiClient.post("/hints/closed", { deliveryId, outcome }).catch(() => undefined);

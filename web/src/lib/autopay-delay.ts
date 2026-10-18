/**
 * «Отсрочка первого списания по СБП» (Antilopay), as the cabinet says it.
 *
 * The operator can give an SBP subscription a delay: nothing is charged when the
 * customer signs up, the first charge comes after it, then every term. Since
 * 18.10.2026 the plan comes with that first charge and not before (the owner's
 * «без доступа на время отсрочки»), and the consent says so
 * (`web.autopay-delay-access-after-charge`, declared beside the capability
 * below). The panel names the delay on the Antilopay entry of its list of
 * gateways (`autopayDelay`), and only for a customer who may still use it — it
 * is given once.
 *
 * This is what makes it safe to give: the consent must be true. A cabinet that
 * wrote «эта сумма спишется сейчас» over a charge that does not come would have
 * the customer agree to something else than they get. So the panel offers the
 * delay only to a cabinet that declares `web.autopay-first-charge-delay`
 * (`src/core/capabilities.ts`, this file is its `implementedBy`), and the
 * checkout carries back exactly the delay the customer was shown
 * (`autopayDelayCount`, `autopayDelayUnit`): the panel makes the checkout with
 * that delay or refuses it (`DELAY_CHANGED`), and charges nobody at once after
 * telling them they would not be charged.
 *
 * A delay this file cannot read is none: the consent then says the charge is
 * made now, which is what the panel does without one.
 */
import type { TFunction } from "i18next";

import type { AutopayMethod } from "@/lib/autopay-offer";

/** Antilopay's own words for the unit, upper-case: the panel is case-sensitive, and so is the wire. */
export const AUTOPAY_DELAY_UNITS = ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"] as const;
export type AutopayDelayUnit = (typeof AUTOPAY_DELAY_UNITS)[number];

/** As the panel lists it: the count, the unit, and the days it is worth. */
export interface AutopayDelay {
  readonly count: number;
  readonly unit: AutopayDelayUnit;
  readonly days: number;
}

/** The panel's days in a unit: a day 1, a week 7, a month 30, a quarter 90, a year 365. */
const UNIT_DAYS: Readonly<Record<AutopayDelayUnit, number>> = { DAY: 1, WEEK: 7, MONTH: 30, QUARTER: 90, YEAR: 365 };

/** The longest delay the panel gives: a year (it refuses a longer one when the operator saves it). */
const MAX_DELAY_DAYS = 366;

/**
 * The delay in what the panel sent, or null for anything that is not one: a
 * count that is not a whole number of at least 1, a unit in the wrong case or
 * not Antilopay's, days that disagree with them, or more than a year.
 */
export function readAutopayDelay(value: unknown): AutopayDelay | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { count, unit, days } = value as Record<string, unknown>;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
  if (typeof unit !== "string" || !(AUTOPAY_DELAY_UNITS as readonly string[]).includes(unit)) return null;
  const worth = count * UNIT_DAYS[unit as AutopayDelayUnit];
  if (days !== worth || worth > MAX_DELAY_DAYS) return null;
  return { count, unit: unit as AutopayDelayUnit, days: worth };
}

/**
 * The delay of the option a customer picks: only an Antilopay SBP sign-up has
 * one (a card's first payment is charged on the form).
 */
export function autopayDelayFor(
  gateway: { readonly type: string; readonly autopayDelay?: unknown },
  method: AutopayMethod | null | undefined,
): AutopayDelay | null {
  if (gateway.type !== "ANTILOPAY" || method !== "SBP") return null;
  return readAutopayDelay(gateway.autopayDelay);
}

/** What the checkout sends back: the count and the word the customer was shown. */
export interface AutopayDelayShown {
  readonly count: number;
  readonly unit: AutopayDelayUnit;
}

/**
 * What a checkout call that signs up for automatic charging sends after the
 * consent, as its trailing arguments: nothing, the method, or the method and the
 * delay the customer was shown beside it. A call keeps its shorter form for every
 * payment that is not that, and for a card or a sign-up that was shown no delay,
 * which the panel then charges at activation.
 */
export type AutopayTail = [] | [AutopayMethod] | [AutopayMethod, AutopayDelayShown];

export function autopayTail(method: AutopayMethod | undefined, delay: AutopayDelay | undefined | null): AutopayTail {
  if (method === undefined) return [];
  return delay === undefined || delay === null ? [method] : [method, { count: delay.count, unit: delay.unit }];
}

/** «7 дней», «1 неделю», «2 квартала»: the delay in words, the number agreeing with the unit. */
export function describeAutopayDelay(t: TFunction, delay: AutopayDelay): string {
  return t(`autopayDelay.duration.${delay.unit}`, { count: delay.count });
}

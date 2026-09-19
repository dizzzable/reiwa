/**
 * The feed now hands `resolveNotificationTarget` the row's payload as well as
 * its type — and for every type but «Помощь с подключением» that must change
 * NOTHING.
 *
 * The payload is there for one reason: a connect-help notice names its
 * subscription in it, and the dashboard's deep link should open that card.
 * Other families carry ids too — an expiry reminder names its subscription, a
 * support reply its ticket — and a mapping that started reading them would
 * quietly move a tap on «Подписка скоро закончится» somewhere new. So the table
 * below is every family the feed can show, each with the payloads it really
 * carries and some it does not, and each is held to what the type alone
 * decided before the payload was passed.
 */
import { describe, expect, it } from "vitest";

import { resolveNotificationTarget, type NotificationTarget } from "../src/lib/notification-target";

const ROUTE = (path: string): NotificationTarget => ({ kind: "route", path });
const MODAL: NotificationTarget = { kind: "modal" };

/** Payloads a row may carry, from none at all to ones that name things. */
const PAYLOADS: ReadonlyArray<Record<string, unknown> | null | undefined> = [
  undefined,
  null,
  {},
  { subscriptionId: "cmsub0001abcdefghijklmno" },
  { subscriptionId: "cmsub0001abcdefghijklmno", daysLeft: 3, planName: "Стандарт" },
  { ticketId: "t1", subject: "Не работает" },
  { title: "Заголовок", text: "Текст", url: "https://evil.example/phish" },
  { subscriptionId: 42 },
];

/** Every non-connect-help type the feed shows, and where a tap went before. */
const BEFORE: ReadonlyArray<readonly [string, NotificationTarget]> = [
  ["support_reply", ROUTE("/support")],
  ["SUPPORT_TICKET_CLOSED", ROUTE("/support")],
  ["referral.reward_issued", ROUTE("/referrals")],
  ["referral_joined", ROUTE("/referrals")],
  ["expires_in_3_days", ROUTE("/renew")],
  ["expires_in_2_days", ROUTE("/renew")],
  ["expires_in_1_days", ROUTE("/renew")],
  ["expired", ROUTE("/renew")],
  ["expired_1_day_ago", ROUTE("/renew")],
  ["limited", ROUTE("/renew")],
  ["subscription_limited", ROUTE("/renew")],
  ["broadcast", MODAL],
  ["ADMIN_MESSAGE", MODAL],
  ["cashback_credited", MODAL],
  ["partner_payout", MODAL],
  ["connect", MODAL],
  ["help", MODAL],
  ["connect_helper", MODAL],
  ["", MODAL],
];

describe("every other type, with any payload, goes exactly where it went before", () => {
  for (const [type, before] of BEFORE) {
    it(`${type || "(empty type)"} → ${before.kind === "route" ? before.path : "modal"}`, () => {
      // The old call: the type alone.
      expect(resolveNotificationTarget(type)).toEqual(before);
      for (const payload of PAYLOADS) {
        expect(resolveNotificationTarget(type, payload), JSON.stringify(payload)).toEqual(before);
      }
    });
  }
});

describe("«Помощь с подключением» reads its subscription from the payload", () => {
  const TYPES = ["connect_help", "connect_help_trial", "CONNECT_HELP"];

  it("opens the named card", () => {
    for (const type of TYPES) {
      expect(resolveNotificationTarget(type, { subscriptionId: "cmsub0001abcdefghijklmno" })).toEqual(
        ROUTE("/dashboard?connect=help&subscriptionId=cmsub0001abcdefghijklmno"),
      );
    }
  });

  it("opens the deep link with no card named when the payload names none it can trust", () => {
    for (const type of TYPES) {
      for (const payload of [undefined, null, {}, { subscriptionId: 42 }, { subscriptionId: "../../renew" }]) {
        expect(resolveNotificationTarget(type, payload), JSON.stringify(payload)).toEqual(
          ROUTE("/dashboard?connect=help"),
        );
      }
    }
  });
});

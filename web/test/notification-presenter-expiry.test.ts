/**
 * The feed row of an expiry reminder, which the cabinet words itself.
 *
 * The reminders 3 hours and 1 hour before the end (Rezeis Admin 0.9.7.76)
 * carry `hoursLeft` and no `daysLeft`: as `daysLeft: 0` they read
 * «истекает через 0 дней». A panel without `hoursLeft` gets the «скоро
 * истекает» line, never a zero.
 */
import i18next, { type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { en } from "../src/i18n/en";
import { ru } from "../src/i18n/ru";
import { presentExpiryBody, presentNotification } from "../src/lib/notification-presenter";

let tRu: TFunction;
let tEn: TFunction;

beforeAll(async () => {
  const ruInstance = i18next.createInstance();
  await ruInstance.init({ lng: "ru", resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } });
  tRu = ruInstance.t.bind(ruInstance);
  const enInstance = i18next.createInstance();
  await enInstance.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  tEn = enInstance.t.bind(enInstance);
});

describe("the last-hours reminders in the feed", () => {
  it("say how many hours are left, in both languages", () => {
    expect(presentExpiryBody({ hoursLeft: 3, planName: "Год" }, tRu)).toBe(
      "Подписка «Год» закончится меньше чем через 3 часа. Продлите, чтобы VPN не отключился.",
    );
    expect(presentExpiryBody({ hoursLeft: 1 }, tRu)).toBe(
      "Подписка закончится меньше чем через 1 час. Продлите, чтобы VPN не отключился.",
    );
    expect(presentExpiryBody({ hoursLeft: 3 }, tEn)).toBe(
      "Your subscription ends in less than 3 hours. Renew so the VPN does not switch off.",
    );
    expect(presentExpiryBody({ hoursLeft: 1 }, tEn)).toBe(
      "Your subscription ends in less than 1 hour. Renew so the VPN does not switch off.",
    );
  });

  it("are an expiry row with that sentence, never «0 дней»", () => {
    const row = presentNotification(
      { id: "n-1", type: "expires_in_3_hours", payload: { hoursLeft: 3 }, readAt: null, createdAt: "2026-10-17T10:00:00.000Z" },
      tRu,
    );
    expect(row.title).toBe(tRu("notifications.types.expiry"));
    expect(row.body).toContain("меньше чем через 3 часа");
    expect(row.body).not.toContain("0 дн");
  });

  it("leave the day reminders as they were", () => {
    expect(presentExpiryBody({ daysLeft: 3 }, tRu)).toBe("Подписка истекает через 3 дня. Продлите, чтобы не потерять доступ.");
    expect(presentExpiryBody({}, tRu)).toBe("Подписка скоро истекает. Продлите, чтобы не потерять доступ.");
  });
});

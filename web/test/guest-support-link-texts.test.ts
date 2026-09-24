/**
 * What the guest support page says about the button in a support letter.
 *
 * The panel writes a guest's letter in the language the guest wrote in last
 * (since 24.09.2026): an English one, whose button is «Open conversation», or
 * a Russian one, «Открыть переписку». The English page still sent its readers
 * to look for «Открыть переписку» in a letter it called Russian — a letter an
 * English guest no longer gets. Both pages now name the button as their own
 * letter has it, and the other letter's as well: a guest who wrote from the
 * other language last, or a panel older than that change (Russian letters
 * only), still finds it.
 */
import { describe, expect, it } from "vitest";

import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";

const EN_BUTTON = "Open conversation";
const RU_BUTTON = "Открыть переписку";

describe("the guest page on the letter’s button", () => {
  it("names the English letter’s button on the English page, and the Russian one beside it", () => {
    for (const text of [en.guestSupport.link.staleNone, en.guestSupport.link.confirmWayBack]) {
      expect(text).toContain(`“${EN_BUTTON}”`);
      expect(text).toContain(`“${RU_BUTTON}”`);
      expect(text).not.toMatch(/the letter is in Russian/);
    }
  });

  it("names the Russian letter’s button on the Russian page, and the English one beside it", () => {
    for (const text of [ru.guestSupport.link.staleNone, ru.guestSupport.link.confirmWayBack]) {
      expect(text).toContain(`«${RU_BUTTON}»`);
      expect(text).toContain(`«${EN_BUTTON}»`);
    }
  });
});

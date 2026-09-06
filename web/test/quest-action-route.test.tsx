import { describe, expect, it } from "vitest";

import { questAction } from "../src/features/dashboard/components/quests-icon";

/**
 * A linking quest must land on the linking form, not the settings hub.
 * Support watched a user click "Привязать" on the Telegram quest, arrive at
 * /settings, and stop — the row they needed was one unlabelled tap away.
 */
describe("quest action routes", () => {
  it("sends the Telegram quest into the privacy deep link", () => {
    expect(questAction("LINK_TELEGRAM")?.route).toBe("/settings/privacy?link=telegram");
  });

  it("sends the Email quest into the privacy deep link", () => {
    expect(questAction("LINK_EMAIL")?.route).toBe("/settings/privacy?link=email");
  });

  it("never drops a linking quest on the settings hub", () => {
    for (const type of ["LINK_TELEGRAM", "LINK_EMAIL"] as const) {
      expect(questAction(type)?.route).not.toBe("/settings");
    }
  });

  it("keeps the invite quest on the referrals page", () => {
    expect(questAction("INVITE_FRIENDS")?.route).toBe("/referrals");
  });

  it("sends the install quest to the settings sheet, not the settings hub", () => {
    // Same lesson as the linking rows above: the hub has twelve entries and
    // "Install the app" is one of them. The parameter is what opens the sheet
    // on arrival — a bare `/settings` would repeat the stall it cost support
    // a ticket to find.
    expect(questAction("INSTALL_PWA")?.route).toBe("/settings?install=1");
    expect(questAction("INSTALL_PWA")?.route).not.toBe("/settings");
  });

  it("gives the install quest a CTA at all", () => {
    // `questAction` returning null renders NO button on the row — the quest
    // would sit there naming an action with nothing to press.
    expect(questAction("INSTALL_PWA")).not.toBeNull();
  });

  it("has no inline route for quests resolved by their own controls", () => {
    expect(questAction("SUBSCRIBE_CHANNEL")).toBeNull();
    expect(questAction("PARTNER_TASK")).toBeNull();
    expect(questAction("CUSTOM")).toBeNull();
  });
});

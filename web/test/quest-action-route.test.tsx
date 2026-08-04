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

  it("has no inline route for quests resolved by their own controls", () => {
    expect(questAction("SUBSCRIBE_CHANNEL")).toBeNull();
    expect(questAction("PARTNER_TASK")).toBeNull();
    expect(questAction("CUSTOM")).toBeNull();
  });
});

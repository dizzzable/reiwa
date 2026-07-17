import { describe, expect, it } from "vitest";

import { getMissingBotTokenError } from "../src/bot/startup-policy.js";

describe("bot startup policy", () => {
  it("returns a clear production error when BOT_TOKEN is missing", () => {
    expect(getMissingBotTokenError({ nodeEnv: "production", botToken: undefined })).toBe(
      "BOT_TOKEN is required in production. Set BOT_TOKEN before starting reiwa-bot.",
    );
  });

  it("treats whitespace-only BOT_TOKEN as missing in production", () => {
    expect(getMissingBotTokenError({ nodeEnv: "production", botToken: "   " })).toContain(
      "BOT_TOKEN is required in production",
    );
  });

  it("keeps development mode allowed to run without a bot token", () => {
    expect(getMissingBotTokenError({ nodeEnv: "development", botToken: undefined })).toBeNull();
  });
});

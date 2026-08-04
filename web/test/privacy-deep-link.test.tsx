import { describe, expect, it } from "vitest";

import { resolvePrivacyDeepLink } from "../src/lib/privacy-deep-link";

const READY = { emailEnabled: true, brandingLoading: false };
const COLD = { emailEnabled: false, brandingLoading: true };

/**
 * A "Привязать" button must land on the linking form, not a menu. Support
 * watched a user click the Telegram quest, arrive at the settings list, and
 * stop — the row they needed was one unlabelled tap away.
 *
 * These cases pin the decision only. `COLD` was for a long time a state the
 * application could not produce — the branding query always shipped
 * `placeholderData`, so `brandingLoading` was false on every render and this
 * suite stayed green while the email deep link was broken end to end.
 * `privacy-page-deep-link.test.tsx` mounts the page and covers the wiring.
 */
describe("privacy deep link", () => {
  it("opens the Telegram form immediately", () => {
    expect(resolvePrivacyDeepLink("telegram", READY)).toEqual({
      open: "telegram",
      consumed: true,
    });
  });

  it("opens Telegram even while branding is still loading", () => {
    // Telegram linking never depends on operator config, so a cold snapshot
    // must not delay it — this is the path the quest and trial CTA both use.
    expect(resolvePrivacyDeepLink("telegram", COLD)).toEqual({
      open: "telegram",
      consumed: true,
    });
  });

  it("opens the Email form once branding confirms the channel is on", () => {
    expect(resolvePrivacyDeepLink("email", READY)).toEqual({
      open: "email",
      consumed: true,
    });
  });

  it("waits instead of swallowing an email link on a cold snapshot", () => {
    // `emailEnabled` starts false before the branding query resolves. Consuming
    // here would strip the param and leave the user on a page that never opened.
    expect(resolvePrivacyDeepLink("email", COLD)).toEqual({
      open: null,
      consumed: false,
    });
  });

  it("consumes but opens nothing when the operator disabled email", () => {
    expect(
      resolvePrivacyDeepLink("email", { emailEnabled: false, brandingLoading: false }),
    ).toEqual({ open: null, consumed: true });
  });

  it("ignores absent, unknown and password targets", () => {
    for (const target of [null, "", "settings", "password", "Telegram"]) {
      expect(resolvePrivacyDeepLink(target, READY)).toEqual({
        open: null,
        consumed: false,
      });
    }
  });
});

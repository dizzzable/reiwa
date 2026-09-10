import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/sw.ts", import.meta.url), "utf8");
const registrationSource = readFileSync(
  new URL("../src/lib/register-sw.ts", import.meta.url),
  "utf8",
);

describe("service worker lifecycle registration", () => {
  it("registers Workbox cache cleanup during initial script evaluation", () => {
    const cleanupIndex = source.indexOf("cleanupOutdatedCaches()");
    const activateIndex = source.indexOf("self.addEventListener('activate'");
    const activateBody = source.slice(
      activateIndex,
      source.indexOf("// ─── Install:"),
    );

    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeLessThan(activateIndex);
    expect(activateBody).not.toContain("cleanupOutdatedCaches()");
  });

  it("only removes caches owned by Reiwa", () => {
    expect(source).toContain("ownedCachePrefixes");
    expect(source).toContain("name.startsWith(prefix)");
    expect(source).not.toContain("!name.startsWith('workbox-precache')");
  });

  it("leaves update reload ownership to the auto-update registration helper", () => {
    expect(registrationSource).not.toContain("controllerchange");
    expect(registrationSource).toContain("registration.update().catch");
  });

  it("listens for the worker's report that a push re-registration was refused", () => {
    // The worker's half of this is covered behaviourally
    // (`push-subscription-change.test.tsx`) and so is the page's
    // (`push-resync-marker.test.ts`). What neither can see is whether the two
    // are ever joined: unwired, the worker posts into nothing and the tab goes
    // on believing itself healed, which is the whole defect.
    //
    // It belongs HERE and not in the shell, because the message can arrive
    // while nobody is signed in and the shell is not mounted then.
    expect(registrationSource).toContain("watchForPushResyncFailure()");
    expect(registrationSource).toContain("push-resync-marker");
  });
});

// @vitest-environment jsdom

/**
 * The install prompt must survive being captured before anything wants it.
 *
 * Chromium fires `beforeinstallprompt` ONCE, shortly after the document loads,
 * and not again for a client-side navigation — web.dev's installation-prompt
 * guide is explicit that you must "wait until the `beforeinstallprompt` event is
 * fired again", which in an SPA means a real reload. There is no replay.
 *
 * `useInstallPrompt` used to register the listener in its own effect, and its
 * only consumer is the Settings page (`settings-page.tsx:62`). Nobody lands on
 * Settings; they navigate there, several route changes into a session that never
 * reloads. So the listener was created minutes after the event had been
 * dispatched to an empty room, `canInstall` was false for every user on every
 * visit, and the "Install app" row rendered essentially never. Nothing threw and
 * no test noticed.
 *
 * The first case below is therefore the whole point: the event fires while NO
 * component is mounted, and the hook must still find it. Move the capture back
 * into the hook's effect and that case goes red.
 *
 * The `BeforeInstallPromptEvent` interface is Chromium-only and jsdom has no
 * notion of it, so the fixture is a plain `Event` with the two members the spec
 * gives it (`prompt()`, `userChoice`) — which is all the production code ever
 * touches. `preventDefault` is real jsdom behaviour, so `defaultPrevented` is a
 * genuine observation and not a spy's opinion.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInstallPrompt, type InstallPromptState } from "@/hooks/use-install-prompt";
import {
  __resetInstallPromptCaptureForTests,
  captureInstallPromptEvents,
  readDeferredInstallPrompt,
} from "@/lib/install-prompt-capture";

interface PromptFixture {
  readonly event: Event;
  readonly prompt: ReturnType<typeof vi.fn>;
}

/**
 * A `beforeinstallprompt` as Chromium dispatches it: cancelable (otherwise
 * `preventDefault()` is a silent no-op and the deferral being asserted on could
 * not happen), carrying `prompt()` and the `userChoice` promise.
 */
function makeInstallPromptEvent(outcome: "accepted" | "dismissed" = "accepted"): PromptFixture {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(() => Promise.resolve());
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event, prompt };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** The live hook result, refreshed on every render of the probe. */
let state: InstallPromptState | null = null;

function Probe(): ReactNode {
  state = useInstallPrompt();
  return null;
}

async function mountProbe(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetInstallPromptCaptureForTests();
  state = null;
  // Not an installed PWA. `isStandalone` gates `canInstall` off, so a stray
  // standalone verdict would fail every case here for a reason none of them is
  // about. Stated explicitly rather than left to jsdom, which ships no
  // `matchMedia` at all — `isStandalonePwa()` survives that via `?.`, but a case
  // whose premise depends on an absent API is a case that changes meaning the
  // day the environment grows one.
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({ matches: false, media: query }) as MediaQueryList,
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  state = null;
  __resetInstallPromptCaptureForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("an install prompt captured before the hook exists", () => {
  it("is still offered to a hook that mounts long afterwards", async () => {
    // The defect, executed: the entry point starts listening, the browser fires
    // the event into a page with no React on it at all, and only then does the
    // user navigate to Settings.
    captureInstallPromptEvents();
    const { event } = makeInstallPromptEvent();
    window.dispatchEvent(event);

    expect(
      event.defaultPrevented,
      "the mini-infobar was not suppressed, so Chromium consumed the event and there is nothing left to defer",
    ).toBe(true);

    await mountProbe();

    expect(
      state?.canInstall,
      "the event fired before the hook mounted and was lost — this is the defect: the install button never appears for a real user, who reaches Settings by navigating, not by loading it",
    ).toBe(true);
  });

  it("is offered to a hook that was already mounted when it arrives", async () => {
    // The other order, and the one the old code handled: the page is sitting on
    // Settings when Chromium finally decides the app is installable.
    captureInstallPromptEvents();
    await mountProbe();

    expect(state?.canInstall, "nothing has been captured yet").toBe(false);

    const { event } = makeInstallPromptEvent();
    await act(async () => {
      window.dispatchEvent(event);
    });

    expect(
      state?.canInstall,
      "an event arriving while the hook is mounted was ignored — the subscription is not wired up",
    ).toBe(true);
  });
});

describe("appinstalled", () => {
  it("withdraws the offer and reports the app as installed", async () => {
    captureInstallPromptEvents();
    window.dispatchEvent(makeInstallPromptEvent().event);
    await mountProbe();
    expect(state?.canInstall).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event("appinstalled"));
    });

    expect(
      state?.canInstall,
      "the install row still offers to install an app that now exists",
    ).toBe(false);
    // The tab that triggered the install keeps display-mode `browser` — this is
    // exactly the case `isStandalonePwa()` alone cannot answer, which is why
    // `matchMedia` is stubbed to false throughout.
    expect(
      state?.isStandalone,
      "`isStandalone` never flipped, so the whole install section stays on screen after installing",
    ).toBe(true);
  });
});

describe("promptInstall", () => {
  it("reports the user's choice and does not offer a second prompt", async () => {
    captureInstallPromptEvents();
    const { event, prompt } = makeInstallPromptEvent("accepted");
    window.dispatchEvent(event);
    await mountProbe();

    let accepted: boolean | null = null;
    await act(async () => {
      accepted = (await state?.promptInstall()) ?? null;
    });

    expect(accepted, "an accepted install was reported as declined").toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);

    // A `BeforeInstallPromptEvent` may only be prompted with once (MDN), and the
    // native dialog is asynchronous — so the stash must be empty the moment the
    // first tap takes it, not after it resolves.
    expect(
      state?.canInstall,
      "the install row is still armed after a spent prompt; a second tap prompts with the same event twice",
    ).toBe(false);

    let second: boolean | null = null;
    await act(async () => {
      second = (await state?.promptInstall()) ?? null;
    });

    expect(second, "a second prompt claimed to have succeeded with no event to prompt with").toBe(
      false,
    );
    expect(
      prompt,
      "the same spent event was prompted with twice — Chromium allows prompt() once per instance",
    ).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissed prompt as declined", async () => {
    captureInstallPromptEvents();
    window.dispatchEvent(makeInstallPromptEvent("dismissed").event);
    await mountProbe();

    // `false` is also what an ABSENT event returns, so without this the case
    // would pass just as happily against a hook that never received one — it
    // would assert nothing about the outcome it is named for.
    expect(state?.canInstall, "no event was captured, so this proves nothing").toBe(true);

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = (await state?.promptInstall()) ?? null;
    });

    expect(outcome, "a dismissed prompt was reported as an install").toBe(false);
  });
});

describe("the capture registration itself", () => {
  it("is idempotent, so a stray second call cannot double-stash the event", () => {
    const added = vi.spyOn(window, "addEventListener");
    captureInstallPromptEvents();
    captureInstallPromptEvents();

    // `String(type)`: `beforeinstallprompt` is Chromium-only and absent from
    // TypeScript's event maps, so a direct comparison is a type error rather
    // than a false assertion.
    const beforeInstall = added.mock.calls.filter(
      ([type]) => String(type) === "beforeinstallprompt",
    );
    expect(
      beforeInstall,
      "a second registration added a second listener; both would preventDefault and race to stash",
    ).toHaveLength(1);
  });

  it("does not capture anything until it is asked to", () => {
    // Importing the module must stay free of side effects: `stealth-layout.tsx`
    // pulls `isStandalonePwa()` in on every dashboard visit, and capture is an
    // explicit call from the entry point, from nowhere else. Note the absent
    // `captureInstallPromptEvents()` — that is the case.
    const { event } = makeInstallPromptEvent();
    window.dispatchEvent(event);

    expect(
      readDeferredInstallPrompt(),
      "an event was stashed without the entry point ever starting capture — the module listens on import",
    ).toBeNull();
    expect(
      event.defaultPrevented,
      "the mini-infobar was suppressed by a module nobody started",
    ).toBe(false);
  });
});

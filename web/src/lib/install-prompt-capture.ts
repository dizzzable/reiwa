/**
 * install-prompt-capture
 * ──────────────────────
 * Catches Chromium's `beforeinstallprompt` at module scope, before React
 * renders, and holds it until something asks for it.
 *
 * The browser fires that event ONCE, shortly after the document loads, and it
 * does not fire again for a client-side navigation — MDN puts it at "usually
 * on page load", and web.dev's installation-prompt guide is explicit that after
 * a spent or dismissed prompt "you need to wait until the `beforeinstallprompt`
 * event is fired again", which in an SPA means a real reload. There is no
 * replay: a listener registered after the event has fired hears nothing at all.
 *
 * That is precisely how the cabinet lost its "Install app" button. The listener
 * lived in `useInstallPrompt`'s effect, and that hook has exactly one consumer
 * — the Settings page. Nobody lands on Settings; they navigate there, several
 * route changes into a session that never reloads. By the time the effect ran,
 * the event had come and gone minutes earlier, so `canInstall` was false for
 * every user on every visit and the button rendered essentially never. The
 * feature was not broken in the sense of throwing; it simply could not happen.
 *
 * Module scope in the entry chunk is the fix, for the same reason the Telegram
 * launch capture next door lives there (see `telegram-launch-params.ts`): it
 * runs before the first render, before any effect, before any lazy boundary, on
 * every route — there is no ordering left to lose. No React effect can be early
 * enough, because the event does not wait for React.
 *
 * **The console warning is a deliberate trade, not an oversight.**
 * `preventDefault()` below suppresses Chromium's own mini-infobar so the cabinet
 * can show the install affordance in its own design language, and Chromium
 * correctly answers a deferred-but-never-prompted event with a devtools warning
 * ("Banner not shown: beforeinstallpromptevent.preventDefault() called…"). That
 * warning is now paid on every page load rather than only on Settings visits.
 * It is a console message, invisible to the subscriber, and it is the price of
 * the event still existing when the user finally reaches the button. Dropping
 * the `preventDefault()` to silence it brings the mini-infobar back AND, per the
 * spec, forfeits the deferred event — i.e. it re-breaks the button.
 */

/**
 * Chromium's install event. Not in `lib.dom` — the interface is non-standard
 * (Chromium/WebKit-less), so it is declared here rather than imported.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * The event the browser fired, kept until it is used or the app is installed.
 *
 * Module-level rather than React state on purpose: it has to survive being
 * captured while NO component is interested, which is the entire defect. A
 * consumer that mounts ten navigations later reads this and finds the event
 * still here.
 */
let deferredPrompt: BeforeInstallPromptEvent | null = null;

/**
 * Did `appinstalled` fire during THIS document's life?
 *
 * Separate from `isStandalonePwa()`, which reads the display mode and cannot
 * answer this: the tab that triggered the install is still an ordinary browser
 * tab afterwards — the installed window is a different one — so its display mode
 * stays `browser`. Without this flag the install CTA would sit there, still
 * offering to install an app that was just installed.
 */
let installedThisDocument = false;

/** Guards against a second registration; the listeners must be singletons. */
let listening = false;

const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  // Iterate a copy: a subscriber may unsubscribe while being notified (React
  // unmounting the consumer as a result of the very state change being pushed),
  // and mutating the live Set mid-iteration would skip the next listener.
  for (const subscriber of [...subscribers]) subscriber();
}

function onBeforeInstallPrompt(event: Event): void {
  // Suppresses Chromium's mini-infobar so the cabinet's own "Install app" row
  // is the only affordance, and — the part that matters here — hands us an
  // event we may prompt with later instead of one the browser has consumed.
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  notifySubscribers();
}

function onAppInstalled(): void {
  // The event is spent the moment the app exists: prompting with it now would
  // offer to install something already installed. Clearing it also lets it be
  // garbage collected, which is what web.dev's guide does here too.
  deferredPrompt = null;
  installedThisDocument = true;
  notifySubscribers();
}

/**
 * Start listening. Called from `web/src/main.tsx` at module scope, before
 * `createRoot(root).render(…)` — that placement is the whole point and is
 * explained there.
 *
 * Idempotent: a second call is a no-op, so a stray import can never end up with
 * two listeners racing to stash the same event.
 */
export function captureInstallPromptEvents(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);
}

/**
 * Subscribe to capture changes. Returns the unsubscribe function, which is the
 * shape `useSyncExternalStore` wants.
 */
export function subscribeToInstallPromptCapture(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

/** The stashed event, or `null` when none has been captured (or it is spent). */
export function readDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/** Whether `appinstalled` fired during this document's life. */
export function hasInstalledThisDocument(): boolean {
  return installedThisDocument;
}

/**
 * Take the stashed event and forget it in the same breath.
 *
 * The clear happens BEFORE the caller awaits `prompt()`, not after, and the two
 * are one step deliberately. A `BeforeInstallPromptEvent` may only be prompted
 * with once (MDN: "may only be called once on a given `BeforeInstallPromptEvent`
 * instance"), and the native dialog is asynchronous — so a double tap on the
 * install row would otherwise read the same event twice and prompt with it
 * twice. Handing it out exactly once makes that impossible to express.
 */
export function consumeDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  const event = deferredPrompt;
  if (event === null) return null;
  deferredPrompt = null;
  notifySubscribers();
  return event;
}

/**
 * Test-only: return to a cold document — no stash, no listeners, no
 * subscribers. Production code must never call this.
 */
export function __resetInstallPromptCaptureForTests(): void {
  if (listening && typeof window !== 'undefined') {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
  }
  listening = false;
  deferredPrompt = null;
  installedThisDocument = false;
  subscribers.clear();
}

/**
 * wizard-model
 * ────────────
 * What the guided connect walk needs to know, worked out from the catalog the
 * operator already maintains — without asking them for anything new.
 *
 * ── The catalog does not say which step is which, and does not need to ──────
 *
 * The page with every instruction renders an app's steps as the operator wrote
 * them: numbered, in order, buttons and all. The walk instead asks three
 * questions of an app — where do I get it, how does the subscription get into
 * it, and what does the customer do after that — and every catalog already
 * answers them through its BUTTON KINDS, which the panel types and audits:
 *
 *   external      → a store or a download: "where do I get it";
 *   deepLink      → hands the subscription over in one tap;
 *   copyLink      → hands it over through the clipboard;
 *
 * and the first step after the one that hands the subscription over is what
 * the customer does next — "switch it on". That reading needs no new field in
 * the editor, works on every catalog saved since 0.9.7.35 and on everything an
 * operator imported, and cannot disagree with the page with every instruction,
 * because both read the same steps.
 */
import type {
  ConnectApp,
  ConnectButton,
  ConnectPlatform,
  ConnectStep,
  PlatformId,
} from '../connect-catalog'

export type WizardStep = 'select' | 'start' | 'device' | 'app' | 'add' | 'enable' | 'done'

/** The four numbered steps, in order — the progress bar and «Шаг N из 4». */
export const NUMBERED_STEPS = ['device', 'app', 'add', 'enable'] as const satisfies readonly WizardStep[]

/** 1–4 for a numbered step, 0 for the ones before and after the count. */
export function stepNumber(step: WizardStep): number {
  return (NUMBERED_STEPS as readonly WizardStep[]).indexOf(step) + 1
}

export type ExternalButton = Extract<ConnectButton, { kind: 'external' }>
export type DeepLinkButton = Extract<ConnectButton, { kind: 'deepLink' }>

export interface AppPlan {
  /** Every store and download link, in the operator's order, each address once. */
  readonly downloads: readonly ExternalButton[]
  /** The one-tap hand-over, when the app has one. */
  readonly addLink: DeepLinkButton | null
  /** The step that hands the subscription over; its text is the operator's own words for it. */
  readonly addStep: ConnectStep | null
  /** The first step after the hand-over — what to do once the subscription is in. */
  readonly enableStep: ConnectStep | null
}

/**
 * Reads one app the way the walk uses it.
 *
 * Downloads are collected from the steps BEFORE the hand-over: a catalog that
 * puts a «Открыть приложение» external link after the subscription is added is
 * not offering a second download, and showing it on «Поставьте приложение»
 * would send the customer back to a store. An app with no hand-over at all
 * cannot reach the walk — `readCatalog` drops it — so the fallback to "every
 * external button" exists only to keep this function total.
 */
export function planApp(app: ConnectApp): AppPlan {
  const handoverIndex = app.steps.findIndex((step) =>
    step.buttons.some((button) => button.kind === 'deepLink' || button.kind === 'copyLink'),
  )
  const before = handoverIndex < 0 ? app.steps : app.steps.slice(0, handoverIndex + 1)
  const seen = new Set<string>()
  const downloads: ExternalButton[] = []
  for (const step of before) {
    for (const button of step.buttons) {
      if (button.kind !== 'external' || seen.has(button.url)) continue
      seen.add(button.url)
      downloads.push(button)
    }
  }
  const addStep = handoverIndex < 0 ? null : (app.steps[handoverIndex] ?? null)
  const addLink =
    addStep?.buttons.find((button): button is DeepLinkButton => button.kind === 'deepLink') ??
    app.steps
      .flatMap((step) => step.buttons)
      .find((button): button is DeepLinkButton => button.kind === 'deepLink') ??
    null
  const enableStep = handoverIndex < 0 ? null : (app.steps[handoverIndex + 1] ?? null)
  return { downloads, addLink, addStep, enableStep }
}

/**
 * The platform the walk opens on: the device it runs on when the catalog has
 * a section for it, else the first section. `detected` is a guess
 * (`platform-detect.ts`), so the device step shows it as one and offers the
 * rest beside it.
 */
export function initialPlatform(
  platforms: readonly ConnectPlatform[],
  detected: PlatformId | null,
): ConnectPlatform | null {
  return platforms.find((platform) => platform.id === detected) ?? platforms[0] ?? null
}

/**
 * What the walk says about the subscription on the selection card.
 *
 * The device count is read only for the card in front of the customer, so for
 * the rest `used` is `null` — "not known", which says nothing rather than
 * "none". A limit of zero or less is "no limit": the panel sends 0 for that.
 */
export type SubscriptionReadiness =
  | { readonly kind: 'expired' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'full' }
  | { readonly kind: 'first' }
  | { readonly kind: 'free'; readonly free: number }
  | { readonly kind: 'plain' }

export function subscriptionReadiness(input: {
  readonly status: string
  readonly hasLink: boolean
  readonly used: number | null
  readonly limit: number | null
}): SubscriptionReadiness {
  if (input.status === 'EXPIRED' || input.status === 'DISABLED') return { kind: 'expired' }
  if (!input.hasLink) return { kind: 'pending' }
  if (input.used === null) return { kind: 'plain' }
  if (input.used === 0) return { kind: 'first' }
  if (input.limit === null || input.limit <= 0) return { kind: 'plain' }
  const free = input.limit - input.used
  return free <= 0 ? { kind: 'full' } : { kind: 'free', free }
}

/** Whether the walk can carry on with this subscription, or must send it to renewal first. */
export function canConnect(readiness: SubscriptionReadiness): boolean {
  return readiness.kind !== 'expired' && readiness.kind !== 'pending'
}

/**
 * Where the walk starts, once the list is in.
 *
 * Two or more subscriptions: choose — always, even when a card's own
 * «Подключить» brought the customer here; the carousel then opens ON that
 * card. One that can be connected: straight to the start screen. One that
 * cannot (expired, still being set up): the choice screen anyway, because
 * that is where «Продлить» and the reason live. `null` for an empty list.
 */
export function initialPlacement(
  rows: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly url: string | null
    readonly deviceLimit: number | null
  }>,
  wantedId: string | null,
): { readonly step: 'select' | 'start'; readonly focus: number; readonly chosenId: string | null } | null {
  if (rows.length === 0) return null
  const ready = (row: (typeof rows)[number]): boolean =>
    canConnect(
      subscriptionReadiness({
        status: row.status,
        hasLink: (row.url ?? '').length > 0,
        used: null,
        limit: row.deviceLimit,
      }),
    )
  const wanted = wantedId === null ? -1 : rows.findIndex((row) => row.id === wantedId)
  const focus = wanted >= 0 ? wanted : Math.max(rows.findIndex(ready), 0)
  const only = rows.length === 1 ? rows[0] : undefined
  if (only !== undefined && ready(only)) return { step: 'start', focus: 0, chosenId: only.id }
  return { step: 'select', focus, chosenId: null }
}

/**
 * The walk's own history: where it is, how it got there, and which way the
 * last move went (the slide direction). `visit` counts every move, so a
 * second stay on a step is told apart from the first — the connection watch
 * starts its count over, a timer from the last stay cannot fire into this one.
 *
 * `step: null` means the walk has not moved yet and stands where
 * {@link initialPlacement} put it.
 */
export interface WalkState {
  readonly step: WizardStep | null
  readonly history: readonly WizardStep[]
  readonly direction: 1 | -1
  readonly visit: number
}

export type WalkAction =
  | { readonly type: 'go'; readonly from: WizardStep; readonly to: WizardStep }
  | { readonly type: 'back' }
  /** A fresh start from `to`, forgetting the way here («Сменить», «Подключить ещё устройство»). */
  | { readonly type: 'restart'; readonly to: WizardStep; readonly direction: 1 | -1 }

export const INITIAL_WALK: WalkState = { step: null, history: [], direction: 1, visit: 0 }

export function walkReducer(state: WalkState, action: WalkAction): WalkState {
  switch (action.type) {
    case 'go':
      // A move from a step the walk has already left is a stale one — a timer
      // or a listener that outlived its screen — and does nothing.
      if (state.step !== null && state.step !== action.from) return state
      return {
        step: action.to,
        history: [...state.history, action.from],
        direction: 1,
        visit: state.visit + 1,
      }
    case 'back': {
      const previous = state.history[state.history.length - 1]
      if (previous === undefined) return state
      return { step: previous, history: state.history.slice(0, -1), direction: -1, visit: state.visit + 1 }
    }
    case 'restart':
      return { step: action.to, history: [], direction: action.direction, visit: state.visit + 1 }
  }
}

/** Which tips the help sheet shows on each step; `start` shares the selection's. */
export function helpTopic(step: WizardStep): 'Select' | 'Device' | 'App' | 'Add' | 'Enable' | 'Done' {
  switch (step) {
    case 'select':
    case 'start':
      return 'Select'
    case 'device':
      return 'Device'
    case 'app':
      return 'App'
    case 'add':
      return 'Add'
    case 'enable':
      return 'Enable'
    case 'done':
      return 'Done'
  }
}

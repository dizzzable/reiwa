/**
 * The mandatory-channel screen: what a Telegram Mini App user sees INSTEAD of
 * the cabinet while Telegram says they are not in the operator's channel.
 *
 * Presentation only — `channel-gate.tsx` decides when it is shown, owns the
 * checks and the clock. It is built like the entry splashes (`/tma`, `/`): the
 * same backdrop, brand tile and pill buttons, and the same outer shape, because
 * it renders outside `StealthLayout` and `#root` clips — the outermost box is
 * the bounded scroller and the centring lives in the column inside it
 * (`out-of-shell-scroller.test.tsx` explains why that pairing, and not
 * `scroll-area` on a centred root, is what keeps both ends reachable).
 *
 * Accessibility, since this screen is the whole app while it is up:
 *   - focus is moved to the heading when it appears, so a screen reader starts
 *     at «Подпишитесь на канал» instead of wherever the previous page left it;
 *   - «✅ Я подписался» is never natively `disabled`. A focused button that
 *     becomes disabled drops keyboard focus to `<body>` in Chromium webviews,
 *     and nothing gives it back. It is `aria-disabled` instead, carries
 *     `aria-busy` while the user's own check is out, and the gate ignores the
 *     press it cannot act on;
 *   - the live region holds only sentences that do not change while they are
 *     shown. The rate-limit countdown ticks OUTSIDE it, hidden from assistive
 *     technology, and the region carries the same sentence once, with the wait
 *     as it was when the user was told — a ticking node inside a live region,
 *     hidden or not, is one VoiceOver may read out every second;
 *   - text is drawn in the theme's own foreground token, not a fixed red or
 *     amber: an operator's light scheme puts this screen on white, where amber
 *     text is about 1.6:1. The tone lives in the notice's tinted frame;
 *   - the only animation is the button's spinner, and it turns under
 *     `motion-safe:` only.
 */
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import { EntryBrandTile } from "@/components/ui/entry-brand-tile";
import { NetworkBg } from "@/components/ui/network-bg";
import { StadiumButton } from "@/components/ui/stadium-button";
import { cn, openExternalUrl } from "@/lib/utils";

/** What the last check the user asked for concluded, when it did not let them in. */
export type ChannelGateNotice = "not-subscribed" | "failed" | "rate-limited";

interface ChannelGateScreenProps {
  /** `null` hides «📢 Перейти в канал» — there is nothing to open. */
  readonly joinUrl: string | null;
  /** The user's own check is out: the spinner turns, `aria-busy`, «Проверяем подписку…». */
  readonly busy: boolean;
  /** A press would do nothing now: the button is `aria-disabled`. */
  readonly unavailable: boolean;
  readonly notice: ChannelGateNotice | null;
  /** The wait the user was told about, in seconds — the sentence announced once. */
  readonly toldSeconds: number | null;
  /** Whole seconds left in a hold after a 429, from the gate's clock; `null` without one. */
  readonly secondsLeft: number | null;
  readonly onCheck: () => void;
}

/** The theme's own foreground on a tinted frame; see the header for why not a coloured text. */
const NOTICE = "rounded-2xl border px-4 py-3 text-[color:var(--brand-foreground)]";
const NOTICE_TONE: Readonly<Record<ChannelGateNotice, string>> = {
  "not-subscribed": "border-red-500/40 bg-red-500/10",
  failed: "border-amber-500/40 bg-amber-500/10",
  "rate-limited": "border-amber-500/40 bg-amber-500/10",
};

/**
 * The room kept under the buttons for a result, in the result's own units: four
 * lines of this text — the longest sentence wraps to three at 320px, four in a
 * wider brand font — plus the frame's `py-3` and its two 1px borders. Keeping
 * less moves the button the user has just pressed when the result appears.
 */
export const CHANNEL_GATE_RESULT_ROOM = "min-h-[calc(4lh+1.5rem+2px)]";

export function ChannelGateScreen({
  joinUrl,
  busy,
  unavailable,
  notice,
  toldSeconds,
  secondsLeft,
  onCheck,
}: ChannelGateScreenProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="scroll-area relative h-dvh overflow-x-hidden bg-(--brand-bg-primary)">
      <NetworkBg intensity="medium" />

      <main
        aria-labelledby={titleId}
        className="relative z-10 flex min-h-full flex-col items-center justify-center gap-8 px-8 py-8 text-center"
      >
        <EntryBrandTile size="lg" />

        <div className="flex w-full max-w-sm flex-col gap-3">
          <h1
            id={titleId}
            ref={headingRef}
            // Focusable by script only: the heading is where the screen starts,
            // not a stop in the tab order.
            tabIndex={-1}
            className="text-2xl font-bold text-[color:var(--brand-foreground)] outline-none"
          >
            {t("channelGate.title")}
          </h1>
          <p className="text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {t("channelGate.body")}
          </p>
        </div>

        <div className="flex w-full max-w-sm flex-col gap-3">
          {joinUrl !== null ? (
            <StadiumButton
              type="button"
              fullWidth
              // Inside the tap, and through the one helper that knows every
              // Telegram client: a `t.me` link goes to `openTelegramLink` when
              // the SDK is there, and keeps `window.open` when it is not — see
              // `openExternalUrl` for what each client does with it.
              onClick={() => openExternalUrl(joinUrl)}
            >
              {t("channelGate.join")}
            </StadiumButton>
          ) : null}
          <StadiumButton
            type="button"
            fullWidth
            variant={joinUrl !== null ? "secondary" : "primary"}
            aria-busy={busy}
            aria-disabled={unavailable}
            // `disabled:` never applies — the button is not disabled — so the
            // look of an unavailable button follows `aria-disabled`.
            className="aria-disabled:opacity-40"
            onClick={onCheck}
            // Not `loading`: that prop swaps the label for a bare spinner, and a
            // button with no text has no accessible name while it is busy.
            icon={
              busy ? (
                <span
                  aria-hidden="true"
                  className="block size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
                />
              ) : undefined
            }
          >
            {t("channelGate.check")}
          </StadiumButton>
        </div>

        <div className={cn(CHANNEL_GATE_RESULT_ROOM, "w-full max-w-sm text-sm leading-relaxed")} data-result-room="">
          {/* Always mounted, so a screen reader is already watching it when a
              result arrives. */}
          <div role="status" aria-live="polite">
            {busy ? (
              <p className="text-[color:var(--brand-muted-foreground)]">{t("channelGate.checking")}</p>
            ) : notice === "rate-limited" && toldSeconds !== null ? (
              <p className="sr-only" data-announced="">
                {t("channelGate.rateLimited", { seconds: toldSeconds })}
              </p>
            ) : notice === "not-subscribed" || notice === "failed" ? (
              <p className={cn(NOTICE, NOTICE_TONE[notice])} data-notice={notice}>
                {t(notice === "not-subscribed" ? "channelGate.notSubscribed" : "channelGate.checkFailed")}
              </p>
            ) : null}
          </div>
          {notice === "rate-limited" && secondsLeft !== null ? (
            <p aria-hidden="true" className={cn(NOTICE, NOTICE_TONE[notice])} data-notice={notice} data-countdown="">
              {t("channelGate.rateLimited", { seconds: secondsLeft })}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

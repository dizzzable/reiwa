/**
 * PaymentReturnPage
 * ─────────────────
 * Full-screen overlay shown after the user returns from a payment provider.
 * Polls the payment status and renders one of three animated states:
 *
 *   1. **Processing** — pulsing circular progress ring + bouncing dots.
 *   2. **Success** — checkmark SVG path draw + green glow + confetti burst.
 *   3. **Failed** — X-mark SVG path draw + red glow + subtle shake.
 *
 * All animations use Framer Motion (already in deps as `motion`). No extra
 * libraries (Lottie, canvas-confetti) are pulled in — we achieve the effect
 * with pure SVG path animation + CSS keyframes for confetti particles.
 *
 * The page auto-redirects to `/dashboard` 3s after success, or stays on
 * failure until the user taps a button.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";

import { toast } from "sonner";

import { abandonCheckout, getPaymentStatus } from "@/lib/api-client";
import { resolvePaymentResult } from "./payment-result-policy";
import { Button } from "@/components/ui/button";
import { useBranding } from "@/lib/branding-provider";
import { openExternalUrl } from "@/lib/utils";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import { readPendingCheckout, readPendingCheckoutReturnTo, readPendingCheckoutLabel, clearPendingCheckout } from "@/lib/pending-checkout";
import {
  clearSubscriptionProvisioningReceipt,
  ensureSubscriptionProvisioningReceipt,
  readSubscriptionProvisioningReceipt,
  shouldTrackSubscriptionProvisioningReceipt,
} from "@/lib/subscription-provisioning-receipt";

type PaymentState = "processing" | "success" | "failed" | "timeout";

const MAX_POLLS = 30;
const POLL_INTERVAL_MS = 2000;
const AUTO_REDIRECT_MS = 3500;
const PROVISIONING_REDIRECT_MS = 900;
/**
 * Success screens that also announce credited loyalty points hold longer.
 * 3500 ms is sized for "paid, now go back"; the cashback line arrives with a
 * number to read and a button to consider, and at 3500 ms (900 ms for a fresh
 * subscription) the page is gone before either registers. This is the only
 * reason the delay differs — nothing else on the screen changed.
 */
const CASHBACK_REDIRECT_MS = 6000;

/**
 * Every successful payment can change both the subscription snapshot and its
 * exact action policy (notably trial -> ordinary after UPGRADE).
 */
export async function invalidatePaymentReturnSuccessQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.detail }),
    queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all }),
    queryClient.invalidateQueries({
      queryKey: subscriptionQueryKeys.actionPolicyRoot,
    }),
    queryClient.invalidateQueries({ queryKey: ["devices"] }),
    queryClient.invalidateQueries({ queryKey: ["session"] }),
  ]);
}

export default function PaymentReturnPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const { branding } = useBranding();

  const paymentId = searchParams.get("paymentId") ?? "";
  const [state, setState] = useState<PaymentState>("processing");
  // Loyalty points credited for THIS payment, straight from the status object
  // (the only place it exists — it is not on any other query). `null` = the
  // panel said nothing worth showing.
  const [cashbackPoints, setCashbackPoints] = useState<number | null>(null);
  const pollCountRef = useRef(0);
  const provisioningSuccessRef = useRef(false);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The provider URL stashed by the flow that created this checkout. Two
  // different flows arrive here needing the button below, so it is not
  // Telegram-only and must not be narrowed to that case:
  //   - Telegram Desktop, where the auto-open (fired from an async mutation
  //     callback) is blocked because the bridge needs a live user gesture;
  //   - any plain browser paying via a `t.me` gateway (Telegram Stars,
  //     CryptoPay). `startCheckoutRedirect` deliberately refuses to assign a
  //     `t.me` link — it never redirects back here, so it would destroy this
  //     tab mid-poll — which leaves this button as the whole route to payment.
  // Either way the buyer's press is the genuine gesture that lets
  // `openExternalUrl` open a new tab without being pop-up blocked.
  const checkoutUrl = useMemo(() => readPendingCheckout(paymentId), [paymentId]);
  // Where "retry" should send the user — the originating flow (/addons, /renew,
  // /upgrade), captured before the poll clears the pending record. Falls back
  // to the plan catalog for legacy/new purchases.
  const retryTo = useMemo(() => readPendingCheckoutReturnTo(paymentId) ?? "/plans", [paymentId]);
  const purchaseLabel = useMemo(() => readPendingCheckoutLabel(paymentId), [paymentId]);
  const openPayment = () => {
    if (checkoutUrl) openExternalUrl(checkoutUrl);
  };

  // Giving up on an unpaid checkout. Worth a button of its own because a
  // paid-trial draft holds the buyer's trial reservation and the quota counts a
  // reservation as spent — so an abandoned attempt hides the trial from the
  // person who abandoned it until the expiry sweep catches up.
  //
  // The server refuses (409) once the draft exists at the provider: that
  // invoice is still payable and no gateway offers a cancel. On a refusal the
  // button is withdrawn rather than left to fail again.
  const [abandoning, setAbandoning] = useState(false);
  const [abandonRefused, setAbandonRefused] = useState(false);
  const handleAbandon = async (): Promise<void> => {
    if (!paymentId || abandoning) return;
    setAbandoning(true);
    try {
      await abandonCheckout(paymentId);
      clearPendingCheckout(paymentId);
      toast.success(t("payment.abandonDone"));
      navigate(retryTo, { replace: true });
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        setAbandonRefused(true);
        toast.error(t("payment.abandonAtProvider"));
      } else {
        toast.error(t("payment.abandonFailed"));
      }
    } finally {
      setAbandoning(false);
    }
  };

  // ── Polling logic ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!paymentId) {
      navigate("/dashboard", { replace: true });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      if (pollCountRef.current >= MAX_POLLS) {
        setState("timeout");
        return;
      }
      try {
        const status = await getPaymentStatus(paymentId);
        if (cancelled) return;

        const result = resolvePaymentResult({
          status: status.status,
          checkoutUrl,
          errorCode: status.failureReason ?? undefined,
        });
        const existingProvisioningReceipt =
          readSubscriptionProvisioningReceipt(paymentId);
        const provisioningCandidate = {
          purchaseType: status.purchaseType,
          subscriptionProvisioningStatus:
            status.subscriptionProvisioningStatus,
          hasExistingReceipt: existingProvisioningReceipt !== null,
          returnTo: retryTo,
        };
        const isSubscriptionCreation =
          shouldTrackSubscriptionProvisioningReceipt(provisioningCandidate);
        if (
          isSubscriptionCreation &&
          status.status !== "FAILED" &&
          status.status !== "CANCELED"
        ) {
          ensureSubscriptionProvisioningReceipt({
            paymentId: status.paymentId,
            purchaseType: provisioningCandidate.purchaseType,
            // A payment return can open in another tab, where the original
            // subscription count is unavailable. The source marker tells the
            // dashboard to append using its current real-item count.
            slotIndex: 0,
            slotIndexSource: "PAYMENT_STATUS",
            phase:
              status.status === "COMPLETED"
                ? "PROVISIONING"
                : "AWAITING_PAYMENT",
          });
        }
        if (result === "success") {
          clearPendingCheckout(paymentId);
          // Only a real, positive number is worth a sentence. Absent, null, 0
          // and NaN from an older panel all collapse to "say nothing".
          const credited = status.cashbackPoints;
          setCashbackPoints(
            typeof credited === "number" && Number.isFinite(credited) && credited > 0
              ? credited
              : null,
          );
          provisioningSuccessRef.current = isSubscriptionCreation;
          setState("success");
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
          void invalidatePaymentReturnSuccessQueries(queryClient);
          return;
        }
        // Use the policy's verdict, not the raw status: it also settles
        // REFUNDED, which the raw check missed. A refunded payment is done —
        // polling it to the 60s cap only stranded the buyer on the *timeout*
        // screen (with a button reopening a settled invoice) and left the
        // pending-checkout and provisioning receipt behind in storage.
        if (result === "failed") {
          clearPendingCheckout(paymentId);
          clearSubscriptionProvisioningReceipt(paymentId);
          setState("failed");
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
          return;
        }
        pollCountRef.current += 1;
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) {
          pollCountRef.current += 1;
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paymentId, navigate, queryClient, checkoutUrl, retryTo]);

  // ── Auto-redirect on success ──────────────────────────────────────────────
  // The handle is kept in a ref so the cashback button can cancel the pending
  // hop before taking the user somewhere else — otherwise the timer would fire
  // behind the exchange page and replace it with the dashboard.
  useEffect(() => {
    if (state !== "success") return;
    const delay =
      cashbackPoints !== null
        ? CASHBACK_REDIRECT_MS
        : provisioningSuccessRef.current
          ? PROVISIONING_REDIRECT_MS
          : AUTO_REDIRECT_MS;
    const timer = setTimeout(() => {
      redirectTimerRef.current = null;
      navigate("/dashboard", { replace: true });
    }, delay);
    redirectTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (redirectTimerRef.current === timer) redirectTimerRef.current = null;
    };
  }, [state, navigate, cashbackPoints]);

  const handleExchangeCashback = (): void => {
    if (redirectTimerRef.current !== null) {
      clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
    navigate("/referrals/exchange");
  };

  return (
    // Outside `StealthLayout`, so this page has to be its own scroller —
    // same reason as `/legal` and `/support/guest`, see the note there. It
    // was bounded (`h-dvh`) but sealed (`overflow-hidden`), which is the
    // worse half of the defect: the `failed` / `timeout` branch stacks a
    // 96px icon, a title, a hint and up to FOUR full-width buttons, and
    // anything past the viewport was cut with nothing to reach it.
    // Measured in Chrome at 375x360: card 384px, top edge at -12px, last
    // button ending 12px below the fold, user scroll range 0.
    //
    // `scroll-area` ALONE on the old root would not have fixed it, and this
    // is why the shape below is the entry screens’ and not a one-word
    // change. The root centred its own child (`flex ... justify-center`),
    // and a flex container that centres overflows at BOTH ends — but only
    // the end-edge overflow joins the scrollable region. Same viewport,
    // same content, `overflow-hidden` swapped for `scroll-area`: scroll
    // range 12px, last button reachable, and the X icon still frozen at
    // -12px with no way up. Moving the centring INTO a `min-h-full` column
    // puts the whole card back inside the scrollable box: scroll range
    // 88px, both ends reachable, and while the card fits the column is
    // exactly 100dvh so the centring is byte-identical to before.
    //
    // `overflow-x-hidden` is not decoration. `overflow-y: auto` promotes a
    // `visible` cross axis to `auto`, and this page moves content sideways
    // on purpose: the failure card shakes +/-4px on x and the success
    // confetti flies +/-100px. That was a horizontal scrollbar; the old
    // `overflow-hidden` is what used to absorb it.
    <div className="scroll-area relative h-dvh overflow-x-hidden bg-(--brand-bg-primary) px-8 text-center">
      {/* Ambient background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            state === "success"
              ? "radial-gradient(circle at center, rgba(34,197,94,0.08) 0%, transparent 60%)"
              : state === "failed" || state === "timeout"
                ? "radial-gradient(circle at center, rgba(239,68,68,0.08) 0%, transparent 60%)"
                : "radial-gradient(circle at center, color-mix(in oklab, var(--brand-foreground) 3%, transparent) 0%, transparent 60%)",
        }}
      />

      {/* The centring lives here and not on the scroller: see the note on
          the root. `min-h-full` resolves against the scroller’s content box
          (100dvh — the scroller carries only horizontal padding, so nothing
          shrinks it), so this column is exactly one screen tall while the
          card fits and grows with the card when it does not. */}
      <div className="flex min-h-full flex-col items-center justify-center py-8">
        <AnimatePresence mode="wait">
          {state === "processing" && (
            <ProcessingState
              key="processing"
              checkoutUrl={checkoutUrl}
              onOpenPayment={openPayment}
            />
          )}
          {state === "success" && (
            <SuccessState
              key="success"
              primary={branding.primary}
              label={purchaseLabel}
              cashbackPoints={cashbackPoints}
              onExchange={handleExchangeCashback}
            />
          )}
          {(state === "failed" || state === "timeout") && (
            <FailedState
              key="failed"
              isTimeout={state === "timeout"}
              checkoutUrl={checkoutUrl}
              onOpenPayment={openPayment}
              onRetry={() => navigate(retryTo)}
              onHome={() => navigate("/dashboard", { replace: true })}
              onAbandon={abandonRefused ? undefined : handleAbandon}
              abandoning={abandoning}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Processing ─────────────────────────────────────────────────────────────

function ProcessingState({
  checkoutUrl,
  onOpenPayment,
}: {
  checkoutUrl: string | null;
  onOpenPayment: () => void;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="relative z-10 flex flex-col items-center gap-6"
    >
      {/* Spinning ring */}
      <div className="relative h-24 w-24">
        <svg className="h-full w-full animate-spin-slow" viewBox="0 0 100 100">
          <circle
            cx="50" cy="50" r="44"
            fill="none"
            stroke="var(--color-border-strong)"
            strokeWidth="4"
          />
          <circle
            cx="50" cy="50" r="44"
            fill="none"
            stroke="var(--brand-primary)"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="70 210"
            className="origin-center"
          />
        </svg>
      </div>

      <div role="status" aria-live="polite">
        <h2 className="text-xl font-semibold text-foreground">
          {t("paymentAnim.processing")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("paymentAnim.waitingProvider")}
        </p>
      </div>

      {/* Bouncing dots */}
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: "var(--brand-primary)" }}
            animate={{ y: [0, -6, 0] }}
            transition={{
              duration: 0.6,
              repeat: Infinity,
              delay: i * 0.15,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>

      {/* Not a fallback — the primary action whenever the buyer is still here
          with an unpaid checkout, and for two whole populations the ONLY way
          through: a Telegram Mini App (the bridge needs a live user gesture and
          the checkout link arrives asynchronously) and any browser paying via a
          `t.me` gateway (that link cannot be assigned without destroying this
          polling tab). Nothing but a press can open either. Styled as the main
          button accordingly; an outline button read as optional and buyers left
          without paying. */}
      {checkoutUrl && (
        <div className="mt-1 flex flex-col items-center gap-2">
          <p className="max-w-xs text-xs text-muted-foreground">
            {t("paymentAnim.openPaymentHint")}
          </p>
          <Button onClick={onOpenPayment} size="lg" className="gap-2 font-semibold shadow-lg">
            <ExternalLink className="h-4 w-4" />
            {t("paymentAnim.openPayment")}
          </Button>
        </div>
      )}
    </motion.div>
  );
}

// ─── Success ────────────────────────────────────────────────────────────────

function SuccessState({
  primary,
  label,
  cashbackPoints,
  onExchange,
}: {
  primary: string;
  label?: string | null;
  /** Points credited by this payment, or `null` to say nothing about them. */
  cashbackPoints?: number | null;
  onExchange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", damping: 15, stiffness: 200 }}
      className="relative z-10 flex flex-col items-center gap-6"
    >
      {/* Glow circle + checkmark */}
      <div className="relative">
        {/* Outer glow pulse */}
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: primary }}
          initial={{ scale: 1, opacity: 0.3 }}
          animate={{ scale: 1.6, opacity: 0 }}
          transition={{ duration: 1.2, repeat: 2, ease: "easeOut" }}
        />
        <div
          className="relative flex h-24 w-24 items-center justify-center rounded-full"
          style={{
            backgroundColor: `color-mix(in oklab, ${primary} 15%, transparent)`,
            boxShadow: `0 0 60px color-mix(in oklab, ${primary} 30%, transparent)`,
          }}
        >
          {/* SVG checkmark with path draw animation */}
          <svg viewBox="0 0 52 52" className="h-12 w-12">
            <motion.path
              d="M14 27 L22 35 L38 17"
              fill="none"
              stroke={primary}
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.5, delay: 0.2, ease: "easeOut" }}
            />
          </svg>
        </div>
      </div>

      {/* Confetti particles */}
      <ConfettiParticles color={primary} />

      <div role="status" aria-live="polite">
        <h2 className="text-xl font-semibold" style={{ color: primary }}>
          {t("paymentAnim.success")}
        </h2>
        {label ? (
          <p className="mt-2 text-sm font-medium text-foreground">{label}</p>
        ) : null}
        <p className="mt-2 text-sm text-muted-foreground">
          {t("paymentAnim.successHint")}
        </p>
        {/* Reward line. Kept inside the same live region as the rest of the
            success copy so it is announced with it, and appended under the
            hint rather than beside anything — the layout above is load-bearing
            (see the note on the page root) and is untouched. */}
        {cashbackPoints != null && cashbackPoints > 0 ? (
          <div className="mt-3 flex flex-col items-center gap-1">
            <p className="text-sm font-medium text-amber-400">
              {t("paymentAnim.cashbackCredited", { count: cashbackPoints })}
            </p>
            <button
              type="button"
              onClick={onExchange}
              className="text-xs font-semibold text-(--brand-primary) underline underline-offset-4"
            >
              {t("paymentAnim.cashbackExchange")}
            </button>
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

// ─── Failed ─────────────────────────────────────────────────────────────────

function FailedState({
  isTimeout,
  checkoutUrl,
  onOpenPayment,
  onRetry,
  onHome,
  onAbandon,
  abandoning,
}: {
  isTimeout: boolean;
  checkoutUrl: string | null;
  onOpenPayment: () => void;
  onRetry: () => void;
  onHome: () => void;
  /** Absent once the draft exists at the provider — the server refuses then. */
  onAbandon?: (() => void) | undefined;
  abandoning?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1, x: [0, -4, 4, -4, 4, 0] }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", damping: 15, stiffness: 200 }}
      className="relative z-10 flex flex-col items-center gap-6"
    >
      {/* X-mark circle */}
      <div
        className="flex h-24 w-24 items-center justify-center rounded-full"
        style={{
          backgroundColor: "color-mix(in oklab, #ef4444 15%, transparent)",
          boxShadow: "0 0 60px color-mix(in oklab, #ef4444 25%, transparent)",
        }}
      >
        <svg viewBox="0 0 52 52" className="h-12 w-12">
          <motion.path
            d="M16 16 L36 36"
            fill="none"
            stroke="#ef4444"
            strokeWidth="4"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          />
          <motion.path
            d="M36 16 L16 36"
            fill="none"
            stroke="#ef4444"
            strokeWidth="4"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, delay: 0.25 }}
          />
        </svg>
      </div>

      <div role="alert" aria-live="assertive">
        <h2 className="text-xl font-semibold text-red-400">
          {t("paymentAnim.failed")}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("paymentAnim.failedHint")}
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        {isTimeout && checkoutUrl && (
          <Button
            onClick={onOpenPayment}
            variant="outline"
            className="w-full gap-2 bg-card backdrop-blur hover:bg-accent"
          >
            <ExternalLink className="h-4 w-4" />
            {t("paymentAnim.openPayment")}
          </Button>
        )}
        <Button
          onClick={onRetry}
          className="w-full"
          style={{
            backgroundColor: "var(--brand-primary)",
            color: "var(--brand-primary-fg)",
          }}
        >
          {t("common.retry")}
        </Button>
        {onAbandon && (
          // Only offered when the draft never reached the provider. Past that
          // point the invoice is still payable and freeing the trial quota
          // would let the same buyer collect several trials — so the server
          // refuses, and offering a button that always fails is worse than
          // offering none.
          <Button
            onClick={onAbandon}
            disabled={abandoning}
            variant="ghost"
            className="w-full text-muted-foreground"
          >
            {t("payment.abandonCheckout")}
          </Button>
        )}
        <Button onClick={onHome} variant="ghost" className="w-full text-muted-foreground">
          {t("payment.backToDashboard")}
        </Button>
      </div>
    </motion.div>
  );
}

// ─── Confetti Particles ─────────────────────────────────────────────────────

function ConfettiParticles({ color }: { color: string }) {
  const particles = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * 360;
    const distance = 60 + Math.random() * 40;
    const x = Math.cos((angle * Math.PI) / 180) * distance;
    const y = Math.sin((angle * Math.PI) / 180) * distance;
    const size = 4 + Math.random() * 4;
    const delay = Math.random() * 0.3;
    return { x, y, size, delay, angle };
  });

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      {particles.map((p, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            backgroundColor: i % 3 === 0 ? color : i % 3 === 1 ? "#fbbf24" : "#a78bfa",
          }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{ x: p.x, y: p.y, opacity: 0, scale: 0.5 }}
          transition={{
            duration: 0.8,
            delay: 0.3 + p.delay,
            ease: "easeOut",
          }}
        />
      ))}
    </div>
  );
}

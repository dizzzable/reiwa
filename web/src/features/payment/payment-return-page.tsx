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
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";

import { getPaymentStatus } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { useBranding } from "@/lib/branding-provider";
import { openExternalUrl } from "@/lib/utils";
import { readPendingCheckout, readPendingCheckoutReturnTo, readPendingCheckoutLabel, clearPendingCheckout } from "@/lib/pending-checkout";

type PaymentState = "processing" | "success" | "failed" | "timeout";

const MAX_POLLS = 30;
const POLL_INTERVAL_MS = 2000;
const AUTO_REDIRECT_MS = 3500;

export default function PaymentReturnPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const { branding } = useBranding();

  const paymentId = searchParams.get("paymentId") ?? "";
  const [state, setState] = useState<PaymentState>("processing");
  const pollCountRef = useRef(0);

  // The provider URL stashed by the flow that created this checkout. On
  // Telegram Desktop the auto-open (fired from an async mutation callback) is
  // blocked because `openLink` must run inside a user gesture — so we surface a
  // manual button here that opens the page from a fresh click.
  const checkoutUrl = useMemo(() => readPendingCheckout(paymentId), [paymentId]);
  // Where "retry" should send the user — the originating flow (/addons, /renew,
  // /upgrade), captured before the poll clears the pending record. Falls back
  // to the plan catalog for legacy/new purchases.
  const retryTo = useMemo(() => readPendingCheckoutReturnTo(paymentId) ?? "/plans", [paymentId]);
  const purchaseLabel = useMemo(() => readPendingCheckoutLabel(paymentId), [paymentId]);
  const openPayment = () => {
    if (checkoutUrl) openExternalUrl(checkoutUrl);
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

        if (status.status === "COMPLETED") {
          clearPendingCheckout(paymentId);
          setState("success");
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
          queryClient.invalidateQueries({ queryKey: ["subscription"] });
          queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
          // The `['subscriptions-all']` (hyphenated) key used by renewal/
          // upgrade/addons pages isn't a prefix of `['subscriptions']`, so
          // invalidate it explicitly too.
          queryClient.invalidateQueries({ queryKey: ["subscriptions-all"] });
          queryClient.invalidateQueries({ queryKey: ["devices"] });
          queryClient.invalidateQueries({ queryKey: ["session"] });
          return;
        }
        if (status.status === "FAILED" || status.status === "CANCELED") {
          clearPendingCheckout(paymentId);
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
  }, [paymentId, navigate, queryClient]);

  // ── Auto-redirect on success ──────────────────────────────────────────────
  useEffect(() => {
    if (state !== "success") return;
    const timer = setTimeout(() => {
      navigate("/dashboard", { replace: true });
    }, AUTO_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [state, navigate]);

  return (
    <div className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-(--brand-bg-primary) px-8 text-center">
      {/* Ambient background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            state === "success"
              ? "radial-gradient(circle at center, rgba(34,197,94,0.08) 0%, transparent 60%)"
              : state === "failed" || state === "timeout"
                ? "radial-gradient(circle at center, rgba(239,68,68,0.08) 0%, transparent 60%)"
                : "radial-gradient(circle at center, rgba(255,255,255,0.02) 0%, transparent 60%)",
        }}
      />

      <AnimatePresence mode="wait">
        {state === "processing" && (
          <ProcessingState
            key="processing"
            checkoutUrl={checkoutUrl}
            onOpenPayment={openPayment}
          />
        )}
        {state === "success" && <SuccessState key="success" primary={branding.primary} label={purchaseLabel} />}
        {(state === "failed" || state === "timeout") && (
          <FailedState
            key="failed"
            isTimeout={state === "timeout"}
            checkoutUrl={checkoutUrl}
            onOpenPayment={openPayment}
            onRetry={() => navigate(retryTo)}
            onHome={() => navigate("/dashboard", { replace: true })}
          />
        )}
      </AnimatePresence>
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
            stroke="rgba(255,255,255,0.06)"
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

      {/* Manual open — the reliable path on Telegram Desktop, where the
          auto-open (openLink from an async callback) is blocked. */}
      {checkoutUrl && (
        <div className="mt-1 flex flex-col items-center gap-2">
          <p className="max-w-xs text-xs text-muted-foreground">
            {t("paymentAnim.openPaymentHint")}
          </p>
          <Button
            onClick={onOpenPayment}
            variant="outline"
            className="gap-2 border-white/10 bg-white/5 backdrop-blur hover:bg-white/10"
          >
            <ExternalLink className="h-4 w-4" />
            {t("paymentAnim.openPayment")}
          </Button>
        </div>
      )}
    </motion.div>
  );
}

// ─── Success ────────────────────────────────────────────────────────────────

function SuccessState({ primary, label }: { primary: string; label?: string | null }) {
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
          <p className="mt-2 text-sm font-medium text-white">{label}</p>
        ) : null}
        <p className="mt-2 text-sm text-muted-foreground">
          {t("paymentAnim.successHint")}
        </p>
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
}: {
  isTimeout: boolean;
  checkoutUrl: string | null;
  onOpenPayment: () => void;
  onRetry: () => void;
  onHome: () => void;
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
            className="w-full gap-2 border-white/10 bg-white/5 backdrop-blur hover:bg-white/10"
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

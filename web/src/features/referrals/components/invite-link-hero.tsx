/**
 * InviteLinkHero
 * ──────────────
 * Top section of the Referral/Partner page: shows the invite link(s) with
 * Copy / Share / QR buttons.
 *
 * Two links exist:
 *   - Telegram: `https://t.me/<BOT>?start=<REF_CODE>` — for Telegram users.
 *   - Web: `https://<REIWA_DOMAIN>/register?ref=<REF_CODE>` — for browser users.
 *
 * Behaviour:
 *   - **Copy** copies the context-appropriate link (TMA → Telegram, Web → Web).
 *   - **Share** sends both links in one message via Web Share API / TMA inline.
 *   - **QR** generates the web link (QR is scanned by camera → opens browser).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, QrCode, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useBranding } from "@/lib/branding-provider";
import { qrSvg, resolveQrStyle } from "@/lib/qr-style";
import { cn } from "@/lib/utils";

interface InviteLinkHeroProps {
  /** Telegram deep link: https://t.me/Bot?start=CODE */
  telegramLink: string;
  /** Web registration link: https://domain/register?ref=CODE */
  webLink: string;
  /** Brand name used in the share text. */
  brandName?: string;
}

export function InviteLinkHero({ telegramLink, webLink, brandName }: InviteLinkHeroProps) {
  const { t } = useTranslation();
  const { branding } = useBranding();
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const displayBrand = brandName ?? branding.brandName;
  // The operator's QR style, resolved once per branding change rather than on
  // every render, because it is a dependency of `handleQr` below.
  // `resolveQrStyle` is total: an old panel's absent field, or anything
  // malformed, comes back as plain — today's code, byte for byte.
  const qrStyle = useMemo(() => resolveQrStyle(branding.qrStyle), [branding.qrStyle]);

  // Context detection: TMA users get Telegram link, web users get web link
  const isTma = !!window.Telegram?.WebApp?.initData;
  const primaryLink = isTma ? telegramLink : webLink;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(primaryLink);
      setCopied(true);
      toast.success(t("common.copied"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("common.error"));
    }
  }, [primaryLink, t]);

  const handleShare = useCallback(async () => {
    // Share text includes BOTH links so the recipient can choose
    const shareText = [
      `${t("referrals.shareText", { brand: displayBrand })}`,
      ``,
      `📱 Telegram: ${telegramLink}`,
      `🌐 Web: ${webLink}`,
    ].join("\n");

    // TMA context: use Telegram's native share
    if (window.Telegram?.WebApp?.switchInlineQuery) {
      try {
        window.Telegram.WebApp.switchInlineQuery(
          `${displayBrand} — ${telegramLink}`,
          ["users", "groups", "channels"],
        );
        return;
      } catch {
        // fallback
      }
    }

    // Web Share API (mobile browsers)
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
        return;
      } catch {
        // user cancelled — fallback to copy
      }
    }

    // Fallback: copy both links
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success(t("common.copied"));
    } catch {
      toast.error(t("common.error"));
    }
  }, [telegramLink, webLink, displayBrand, t]);

  const handleQr = useCallback(async () => {
    try {
      // QR always encodes the web link (scanned by camera → opens browser).
      //
      // Drawn dark-on-white, on a white plate, and NOT in the brand foreground
      // on a transparent field as it was. That looked right on the dark sheet
      // and failed twice over: it is an inverted code, which ZXing's JS port
      // and v2rayNG's camera path do not attempt at all, and its background
      // was `#00000000` — so the moment the alpha was flattened onto white,
      // which is what saving or forwarding the image does, it became
      // near-white on white. Not faint. Blank.
      //
      // The operator may style it: this is a code one person hands to another
      // person's phone camera, not one a VPN client reads. 208 is the CSS size
      // the dialog shows it at (`h-52 w-52` below), which is what decides
      // whether dots are still large enough to keep.
      const svg = await qrSvg(webLink, qrStyle, 208);
      setQrDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      setQrOpen(true);
    } catch {
      toast.error(t("common.error"));
    }
  }, [webLink, qrStyle, t]);

  return (
    <>
      <div className="mx-5 space-y-3">
        {/* Link display — shows the context-appropriate link */}
        <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--brand-muted-foreground)]">
            {t("referrals.yourLink")}
          </p>
          <p className="mt-1 break-all font-mono text-xs leading-relaxed text-[var(--brand-foreground)]">
            {primaryLink}
          </p>
          {/* Show the other link as a secondary hint */}
          <p className="mt-1.5 break-all text-[10px] leading-relaxed text-[var(--brand-muted-foreground)]">
            {isTma ? `🌐 ${webLink}` : `📱 ${telegramLink}`}
          </p>
        </div>

        {/* Action buttons — icon-over-label tiles, matching the dashboard
            subscription actions so the page reads as one design system. */}
        <div className="grid grid-cols-3 gap-2">
          <ActionTile onClick={handleCopy} label={t("common.copy")} active={copied}>
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span
                  key="check"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Check className="h-5 w-5 text-(--brand-primary)" />
                </motion.span>
              ) : (
                <motion.span
                  key="copy"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Copy className="h-5 w-5" />
                </motion.span>
              )}
            </AnimatePresence>
          </ActionTile>

          <ActionTile onClick={handleShare} label={t("referrals.share")}>
            <Share2 className="h-5 w-5" />
          </ActionTile>

          <ActionTile onClick={handleQr} label="QR">
            <QrCode className="h-5 w-5" />
          </ActionTile>
        </div>
      </div>

      {/* QR Dialog */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-center">{t("referrals.qrTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            {/* A WHITE plate under a dark code. The dark surface this used to
                sit on is what tempted the inverted palette in the first place;
                a light plate is how a dark theme shows a scannable code.
                `imageRendering: pixelated` went with the bitmap — an SVG has no
                pixels to snap, and forcing it degrades the very edges the
                decoder samples. */}
            {qrDataUrl && (
              <div className="overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-white p-4">
                <img src={qrDataUrl} alt="QR Code" className="h-52 w-52" />
              </div>
            )}
            <p className="max-w-[220px] break-all text-center text-[11px] leading-relaxed text-[var(--brand-muted-foreground)]">
              {webLink}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * ActionTile — icon-over-label button matching the dashboard's
 * SubscriptionActions tiles (rounded-2xl glass, brand-tinted icon).
 */
function ActionTile({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-2xl border px-1 py-3 transition-all duration-150 active:scale-95",
        active
          ? "border-(--brand-primary)/30 bg-(--brand-primary)/10"
          : "border-[var(--color-border-soft)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-high)]",
      )}
    >
      <span className="text-(--brand-primary)">{children}</span>
      <span className="w-full truncate px-0.5 text-center text-[10.5px] font-medium text-[var(--brand-foreground)]">
        {label}
      </span>
    </button>
  );
}

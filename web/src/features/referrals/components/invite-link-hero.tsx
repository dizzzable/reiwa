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

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, QrCode, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import QRCode from "qrcode";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useBranding } from "@/lib/branding-provider";
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
      // QR always encodes the web link (scanned by camera → opens browser)
      const dataUrl = await QRCode.toDataURL(webLink, {
        width: 280,
        margin: 2,
        color: { dark: "#ffffff", light: "#00000000" },
      });
      setQrDataUrl(dataUrl);
      setQrOpen(true);
    } catch {
      toast.error(t("common.error"));
    }
  }, [webLink, t]);

  return (
    <>
      <div className="mx-5 space-y-3">
        {/* Link display — shows the context-appropriate link */}
        <div className="rounded-2xl border border-white/6 bg-white/3 px-4 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            {t("referrals.yourLink")}
          </p>
          <p className="mt-1 break-all font-mono text-xs leading-relaxed text-zinc-300">
            {primaryLink}
          </p>
          {/* Show the other link as a secondary hint */}
          <p className="mt-1.5 break-all text-[10px] leading-relaxed text-zinc-600">
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
            {qrDataUrl && (
              <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
                <img
                  src={qrDataUrl}
                  alt="QR Code"
                  className="h-52 w-52"
                  style={{ imageRendering: "pixelated" }}
                />
              </div>
            )}
            <p className="max-w-[220px] break-all text-center text-[11px] leading-relaxed text-zinc-500">
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
          : "border-white/6 bg-white/3 hover:bg-white/6",
      )}
    >
      <span className="text-(--brand-primary)">{children}</span>
      <span className="w-full truncate px-0.5 text-center text-[10.5px] font-medium text-zinc-300">
        {label}
      </span>
    </button>
  );
}

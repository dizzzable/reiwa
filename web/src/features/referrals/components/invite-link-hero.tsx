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

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useBranding } from "@/lib/branding-provider";

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
          <p className="truncate font-mono text-xs text-zinc-400">{primaryLink}</p>
          {/* Show the other link as secondary hint */}
          <p className="mt-1 truncate text-[10px] text-zinc-600">
            {isTma ? `🌐 ${webLink}` : `📱 ${telegramLink}`}
          </p>
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={handleCopy}
          >
            <AnimatePresence mode="wait" initial={false}>
              {copied ? (
                <motion.span
                  key="check"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Check className="h-4 w-4 text-emerald-400" />
                </motion.span>
              ) : (
                <motion.span
                  key="copy"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Copy className="h-4 w-4" />
                </motion.span>
              )}
            </AnimatePresence>
            <span className="text-xs">{t("common.copy")}</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={handleShare}
          >
            <Share2 className="h-4 w-4" />
            <span className="text-xs">{t("referrals.share")}</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5"
            onClick={handleQr}
          >
            <QrCode className="h-4 w-4" />
            <span className="text-xs">QR</span>
          </Button>
        </div>
      </div>

      {/* QR Dialog */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-center">QR-код</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {qrDataUrl && (
              <img
                src={qrDataUrl}
                alt="QR Code"
                className="h-56 w-56 rounded-xl"
                style={{ imageRendering: "pixelated" }}
              />
            )}
            <p className="text-center text-xs text-muted-foreground max-w-[200px] truncate">
              {webLink}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

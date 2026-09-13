/**
 * PartnerQrDialog
 * ───────────────
 * A partner's advertising code, tapped open: the same link drawn again at a
 * size a camera reads comfortably — in the operator's style, and with the
 * operator's logo where the planner finds room for one.
 *
 * ── Why the thumbnail is not simply made bigger ─────────────────────────────
 *
 * The card shows its codes side by side at 96 CSS px. On the links it carries
 * (versions 3–5) that is 2.1–2.6 px per module: under the ~3 px phone cameras
 * practically need, and far under the 4 px a logo needs — at 96 px no symbol
 * reaches it, so a thumbnail can never carry a logo. The card keeps its layout;
 * the code becomes a button that opens a large one.
 *
 * ── Why 256 px ──────────────────────────────────────────────────────────────
 *
 *   - The realistic web ad link, 64–77 bytes, is version 5 at M: 37 modules and
 *     an 8-module quiet zone, 5.69 px per module at 256. The longest link
 *     measured — 92 bytes with UTM parameters, version 6 — gets 5.22. Every
 *     logo plan on those links lands between the two, above the 4.5 px per
 *     module the camera model in `qr-logo-decodes.test.ts` reads at.
 *   - It is the largest code this dialog holds on a 320 CSS px screen: 320 less
 *     an 8 px gutter each side, less 16 px of padding each side, is 272 — the
 *     code and its 8 px white plate padding, exactly.
 *
 * The number itself lives in the shared kit (`LOGO_DISPLAY_PIXELS`), because
 * the panel verifies an operator's logo at the sizes the cabinet shows it.
 *
 * ── The thumbnail stays what it was ─────────────────────────────────────────
 *
 * `children` is the card's own `<LocalQr>` at 96 px, unchanged, and `LocalQr`
 * has no way to pass a logo: the code on the card is byte for byte the code it
 * was before the logo existed. Only this dialog hands `qrSvg` the loaded image.
 *
 * ── Accessibility ───────────────────────────────────────────────────────────
 *
 * The thumbnail is a real `<button>` named for what it opens, and the dialog
 * is the app's Radix primitive through `DialogTrigger`: focus moves into the
 * dialog, Tab stays inside it, Escape and the close button dismiss it, and
 * focus returns to the thumbnail that opened it. That return is the reason for
 * the trigger — a controlled dialog without one leaves focus on the page body
 * when it closes (Radix focuses `context.triggerRef`, which only a trigger
 * sets). Under `prefers-reduced-motion` the dialog's zoom-in is switched off;
 * the backdrop's 100 ms opacity fade, which moves nothing, is left alone.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { LOGO_DISPLAY_PIXELS } from "@/lib/qr-logo";
import { useQrLogoHref } from "@/lib/qr-logo-source";
import { qrSvg, type QrStyle } from "@/lib/qr-style";

/** The CSS size the enlarged code is drawn and shown at. See "Why 256 px" above. */
export const ENLARGED_PARTNER_QR_PIXELS = LOGO_DISPLAY_PIXELS.partnerEnlarged;

export function PartnerQrDialog({
  kind,
  url,
  style,
  children,
}: {
  /** Which of the card's two links this is — it names the button and the dialog. */
  kind: "bot" | "web";
  url: string;
  /** Already resolved and memoised by the section. */
  style: QrStyle;
  /** The thumbnail, exactly as the card draws it. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  // Fetched while the card is on screen, so the logo is usually there the first
  // time the dialog opens. `undefined` draws the code without it.
  const logoHref = useQrLogoHref(url, style, ENLARGED_PARTNER_QR_PIXELS);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void qrSvg(url, style, ENLARGED_PARTNER_QR_PIXELS, logoHref)
      .then((svg) => {
        if (!cancelled) setCode(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setCode(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, url, style, logoHref]);

  const title = t(kind === "bot" ? "partnerAds.qrDialogBot" : "partnerAds.qrDialogWeb");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t(kind === "bot" ? "partnerAds.qrEnlargeBot" : "partnerAds.qrEnlargeWeb")}
          className="cursor-zoom-in rounded-md outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--brand-primary)"
        >
          {children}
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-w-[calc(100%-1rem)] p-4 sm:max-w-sm"
        style={reduceMotion ? { animation: "none" } : undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-center">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {/* A white plate under a dark code, as everywhere a code is shown.
              The placeholder is the same box, so nothing moves when the code
              arrives a moment after the dialog opens. */}
          <div className="rounded-2xl bg-white p-2">
            {code === null ? (
              <div style={{ width: ENLARGED_PARTNER_QR_PIXELS, height: ENLARGED_PARTNER_QR_PIXELS }} aria-hidden />
            ) : (
              <img
                src={code}
                alt={title}
                width={ENLARGED_PARTNER_QR_PIXELS}
                height={ENLARGED_PARTNER_QR_PIXELS}
                className="block"
              />
            )}
          </div>
          <DialogDescription className="max-w-[256px] break-all text-center text-[11px] leading-relaxed text-[var(--brand-muted-foreground)]">
            {url}
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * SettingsPage
 * ────────────
 * Main settings hub — Telegram-style layout:
 *   1. Profile header (avatar + username + status).
 *   2. Menu items (each navigates to a sub-page or opens a sheet).
 *   3. Logout button at the bottom.
 *
 * Menu items:
 *   - 🔒 Конфиденциальность → /settings/privacy
 *   - 🔔 Уведомления → /settings/notifications
 *   - 📋 Транзакции → /settings/transactions
 *   - 🌐 Язык → inline sheet
 *   - 💬 Поддержка → /support
 *   - ❓ Помощь (FAQ) → /settings/faq
 *   - 🚪 Выйти
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  CircleHelp,
  CreditCard,
  Globe,
  GraduationCap,
  LogOut,
  MessageSquare,
  Bell,
  Shield,
  CheckCircle2,
  Tag,
  Download,
  Share,
} from "lucide-react";

import { useSession } from "@/hooks/use-session";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { signOut, updateLanguage, getNotifications } from "@/lib/api-client";
import { setLocale } from "@/i18n/i18n";
import { useBranding } from "@/lib/branding-provider";
import { useOnboardingContext } from "@/features/onboarding/onboarding-tour-controller";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StadiumButton } from "@/components/ui/stadium-button";
import { FlagIcon } from "@/components/ui/flag-icon";
import { toast } from "sonner";

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const { branding } = useBranding();
  const { replayTour } = useOnboardingContext();
  const install = useInstallPrompt();
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [showLangDialog, setShowLangDialog] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);

  // Support indicator: count UNREAD support replies (the operator answered and
  // the user hasn't opened the ticket yet). Driven by the same notification
  // feed + `['notifications']` cache as the bell, so it (a) reflects the real
  // number of unread replies — not just "1 ticket" — and (b) clears the moment
  // the user opens the ticket (which marks the support_reply events read and
  // invalidates this key), instead of lingering until the user replies.
  const { data: notifData } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => getNotifications(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const supportUnread = (notifData?.notifications ?? []).filter(
    (n) => n.type === "support_reply" && !n.readAt,
  ).length;

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.clear();
      navigate("/bootstrap", { replace: true });
    },
    onError: () => {
      queryClient.clear();
      navigate("/bootstrap", { replace: true });
    },
  });

  function changeLang(lang: "en" | "ru") {
    setLocale(lang);
    updateLanguage(lang.toUpperCase()).catch(() => {});
    toast.success(t("settings.languageUpdated"));
    setShowLangDialog(false);
  }

  if (!session) return null;

  // Display label precedence: real name → Telegram @username → web login →
  // generic. Web-first users have no name/username, so without the login
  // fallback the header showed "User" / "??".
  const displayName =
    session.name || session.username || session.webAccount?.login || "User";

  const initials = displayName && displayName !== "User"
    ? displayName
        .split(/[\s@._-]+/)
        .filter(Boolean)
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "??";

  const statusText = t("settings.statusActive");

  // Resolve a menu icon's colour from the branding strategy:
  //   default → the icon's own accent (Tailwind class kept by the caller),
  //   theme   → brand primary, custom → per-icon colour (fallback: primary).
  const iconMode = branding.iconColorMode ?? "default";
  function iconTint(key: string): string | undefined {
    if (iconMode === "theme") return branding.primary;
    if (iconMode === "custom") return branding.iconColors?.[key] ?? branding.primary;
    return undefined; // default → keep the icon's own accent class
  }

  return (
    <div className="min-h-full pb-6">
      {/* ── Profile Header ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center px-5 pt-[calc(3rem+env(safe-area-inset-top))] pb-6"
      >
        {/* Avatar */}
        <div
          className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold text-white shadow-lg"
          style={{
            background: `linear-gradient(135deg, ${branding.primary} 0%, #8b5cf6 100%)`,
            boxShadow: `0 0 32px color-mix(in oklab, ${branding.primary} 40%, transparent)`,
          }}
        >
          {initials}
        </div>
        {/* Username */}
        <p className="mt-3 text-lg font-semibold text-white">
          {displayName}
        </p>
        {session.username && (
          <p className="text-sm text-muted-foreground">@{session.username}</p>
        )}
        {!session.username && session.webAccount?.login && (
          <p className="text-sm text-muted-foreground">{session.webAccount.login}</p>
        )}
        {/* Status */}
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-zinc-400">{statusText}</span>
        </div>
      </motion.div>

      {/* ── Menu Items ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="mx-5 space-y-1.5"
      >
        <MenuItem
          icon={<Shield className="h-5 w-5" />}
          iconBg="bg-emerald-500/10 text-emerald-400"
          tint={iconTint("privacy")}
          label={t("settings.privacy")}
          sublabel={t("settings.privacySub")}
          onClick={() => navigate("/settings/privacy")}
        />
        <MenuItem
          icon={<Bell className="h-5 w-5" />}
          iconBg="bg-blue-500/10 text-blue-400"
          tint={iconTint("notifications")}
          label={t("settings.notifications")}
          sublabel={t("settings.notificationsSub")}
          onClick={() => navigate("/settings/notifications")}
        />
        <MenuItem
          icon={<CreditCard className="h-5 w-5" />}
          iconBg="bg-amber-500/10 text-amber-400"
          tint={iconTint("transactions")}
          label={t("settings.transactions")}
          sublabel={t("settings.transactionsSub")}
          onClick={() => navigate("/settings/transactions")}
        />
        <MenuItem
          icon={<Tag className="h-5 w-5" />}
          iconBg="bg-violet-500/10 text-violet-400"
          tint={iconTint("promocodes")}
          label={t("settings.promocodes")}
          sublabel={t("settings.promocodesSub")}
          onClick={() => navigate("/settings/promocodes")}
        />
        <MenuItem
          icon={<Globe className="h-5 w-5" />}
          iconBg="bg-violet-500/10 text-violet-400"
          tint={iconTint("language")}
          label={t("settings.language")}
          sublabel={i18n.language === "ru" ? t("common.languageRu") : t("common.languageEn")}
          onClick={() => setShowLangDialog(true)}
        />
        <MenuItem
          icon={<MessageSquare className="h-5 w-5" />}
          iconBg="bg-(--brand-primary)/10 text-(--brand-primary)"
          tint={iconTint("support")}
          label={t("settings.support")}
          sublabel={t("settings.supportSub")}
          badge={supportUnread}
          onClick={() => navigate("/support")}
        />
        <MenuItem
          icon={<CircleHelp className="h-5 w-5" />}
          iconBg="bg-zinc-500/10 text-zinc-400"
          tint={iconTint("faq")}
          label={t("settings.faq")}
          sublabel={t("settings.faqSub")}
          onClick={() => navigate("/settings/faq")}
        />
        {install.canInstall || install.isIos ? (
          <MenuItem
            icon={<Download className="h-5 w-5" />}
            iconBg="bg-(--brand-primary)/10 text-(--brand-primary)"
            tint={iconTint("install")}
            label={t("settings.installApp")}
            sublabel={t("settings.installAppSub")}
            onClick={() => {
              if (install.canInstall) {
                void install.promptInstall();
              } else {
                setShowInstallHelp(true);
              }
            }}
          />
        ) : null}
        <MenuItem
          icon={<GraduationCap className="h-5 w-5" />}
          iconBg="bg-sky-500/10 text-sky-400"
          tint={iconTint("tutorial")}
          label={t("settings.replayTutorial")}
          sublabel={t("settings.replayTutorialSub")}
          onClick={() => {
            navigate("/dashboard");
            // Let the dashboard mount before spotlighting its elements.
            setTimeout(() => replayTour(), 400);
          }}
        />
      </motion.div>

      {/* ── Logout ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12 }}
        className="mx-5 mt-6"
      >
        <button
          onClick={() => setShowLogoutDialog(true)}
          className="flex w-full items-center gap-3 rounded-2xl border border-red-500/10 bg-red-500/5 p-4 text-red-400 transition-all hover:bg-red-500/10 active:scale-[0.98]"
        >
          <LogOut className="h-5 w-5" />
          <span className="text-sm font-medium">{t("settings.signOut")}</span>
        </button>
      </motion.div>

      {/* ── Language Dialog (centered) ── */}
      <Dialog open={showLangDialog} onOpenChange={setShowLangDialog}>
        <DialogContent className="max-w-xs" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t("settings.changeLanguage")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <LangOption
              code="RU"
              label={t("common.languageRu")}
              active={i18n.language === "ru"}
              onClick={() => changeLang("ru")}
            />
            <LangOption
              code="GB"
              label={t("common.languageEn")}
              active={i18n.language === "en"}
              onClick={() => changeLang("en")}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Install (iOS) Help Dialog ── */}
      <Dialog open={showInstallHelp} onOpenChange={setShowInstallHelp}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("settings.installIosTitle", { brand: branding.brandName })}</DialogTitle>
            <DialogDescription>{t("settings.installIosIntro")}</DialogDescription>
          </DialogHeader>
          <ol className="space-y-3 py-1 text-sm text-zinc-300">
            <li className="flex items-center gap-2">
              <Share className="h-4 w-4 shrink-0 text-(--brand-primary)" />
              <span>{t("settings.installIosStep1")}</span>
            </li>
            <li className="flex items-center gap-2">
              <Download className="h-4 w-4 shrink-0 text-(--brand-primary)" />
              <span>{t("settings.installIosStep2")}</span>
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-(--brand-primary)" />
              <span>{t("settings.installIosStep3")}</span>
            </li>
          </ol>
        </DialogContent>
      </Dialog>

      {/* ── Logout Dialog ── */}
      <Dialog open={showLogoutDialog} onOpenChange={setShowLogoutDialog}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("settings.signOut")}</DialogTitle>
            <DialogDescription>{t("settings.signOutConfirm")}</DialogDescription>
          </DialogHeader>
          <div className="mt-2 flex flex-col gap-2">
            <StadiumButton
              variant="danger"
              size="lg"
              fullWidth
              loading={signOutMutation.isPending}
              icon={<LogOut className="h-5 w-5" />}
              onClick={() => signOutMutation.mutate()}
            >
              {t("settings.signOut")}
            </StadiumButton>
            <StadiumButton
              variant="ghost"
              size="md"
              fullWidth
              onClick={() => setShowLogoutDialog(false)}
            >
              {t("common.cancel")}
            </StadiumButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── MenuItem ────────────────────────────────────────────────────────────────

function MenuItem({
  icon,
  iconBg,
  tint,
  label,
  sublabel,
  onClick,
  badge,
}: {
  icon: React.ReactNode;
  iconBg: string;
  /** When set (theme/custom modes), tints the icon + its background inline. */
  tint?: string;
  label: string;
  sublabel?: string;
  onClick: () => void;
  /** Optional unread/attention count shown as a pill before the chevron. */
  badge?: number;
}) {
  // When a tint is provided we drop the per-icon accent class and paint the
  // glyph + a soft matching background from the single tint colour.
  const tinted = tint
    ? {
        className: "",
        style: {
          color: tint,
          backgroundColor: `color-mix(in oklab, ${tint} 12%, transparent)`,
        } as React.CSSProperties,
      }
    : { className: iconBg, style: undefined };
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-4 transition-all hover:bg-white/4 active:scale-[0.98]"
    >
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tinted.className}`}
        style={tinted.style}
      >
        {icon}
      </div>
      <div className="flex-1 text-left min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        {sublabel && <p className="text-xs text-zinc-500 truncate">{sublabel}</p>}
      </div>
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-(--brand-primary) px-1.5 text-[10px] font-bold text-(--brand-primary-fg)">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
    </button>
  );
}

// ── LangOption ──────────────────────────────────────────────────────────────

function LangOption({
  code,
  label,
  active,
  onClick,
}: {
  code: "RU" | "GB";
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl border p-3.5 transition-all active:scale-[0.98] ${
        active ? "border-(--brand-primary)/50 bg-(--brand-primary)/5" : "border-white/6 hover:border-white/12"
      }`}
    >
      <FlagIcon code={code} className="h-5 w-7" />
      <span className="flex-1 text-left text-sm font-medium">{label}</span>
      {active && <CheckCircle2 className="h-4 w-4" style={{ color: "var(--brand-primary)" }} />}
    </button>
  );
}

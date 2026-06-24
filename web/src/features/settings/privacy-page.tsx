/**
 * PrivacyPage
 * ───────────
 * Security & account linking settings:
 *   - Change password
 *   - Link Telegram account (mints a one-time code submitted to the bot)
 *   - Link Email (issues a 6-digit code, then verifies it)
 *
 * Link status is read from the session payload (`telegramId`,
 * `webAccount.emailVerifiedAt`) so each row reflects whether the
 * channel is already attached.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Copy, Key, Mail, Send } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  changePasswordAuth,
  initiateEmailLink,
  initiateTelegramLink,
  verifyEmailLink,
} from "@/lib/api-client";
import { useSession, SESSION_QUERY_KEY } from "@/hooks/use-session";
import { useBranding } from "@/lib/branding-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function PrivacyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { session } = useSession();
  const { emailEnabled } = useBranding();
  const [activeSheet, setActiveSheet] = useState<"password" | "telegram" | "email" | null>(null);

  const telegramLinked = Boolean(session?.telegramId);
  const emailVerified = Boolean(session?.webAccount?.emailVerifiedAt);

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <button
          onClick={() => navigate(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">{t("settings.privacy")}</h1>
      </div>

      {/* Menu items */}
      <div className="mx-5 space-y-1.5">
        <PrivacyItem
          icon={<Key className="h-5 w-5" />}
          iconBg="bg-amber-500/10 text-amber-400"
          label={t("privacy.changePassword")}
          sublabel={t("privacy.changePasswordSub")}
          onClick={() => setActiveSheet("password")}
        />
        <PrivacyItem
          icon={<Send className="h-5 w-5" />}
          iconBg="bg-blue-500/10 text-blue-400"
          label={t("privacy.linkTelegram")}
          sublabel={telegramLinked ? t("privacy.linkedStatus") : t("privacy.linkTelegramSub")}
          linked={telegramLinked}
          onClick={() => setActiveSheet("telegram")}
        />
        {emailEnabled && (
          <PrivacyItem
            icon={<Mail className="h-5 w-5" />}
            iconBg="bg-emerald-500/10 text-emerald-400"
            label={t("privacy.linkEmail")}
            sublabel={
              emailVerified
                ? `${session?.webAccount?.email ?? ""} · ${t("privacy.verifiedStatus")}`
                : t("privacy.linkEmailSub")
            }
            linked={emailVerified}
            onClick={() => setActiveSheet("email")}
          />
        )}
      </div>

      {/* Change Password Dialog */}
      <Dialog open={activeSheet === "password"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("privacy.changePassword")}</DialogTitle>
          </DialogHeader>
          <ChangePasswordForm onSuccess={() => setActiveSheet(null)} />
        </DialogContent>
      </Dialog>

      {/* Link Telegram Dialog */}
      <Dialog open={activeSheet === "telegram"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("privacy.linkTelegram")}</DialogTitle>
          </DialogHeader>
          <LinkTelegramForm linked={telegramLinked} />
        </DialogContent>
      </Dialog>

      {/* Link Email Dialog */}
      {emailEnabled && (
        <Dialog open={activeSheet === "email"} onOpenChange={(open) => !open && setActiveSheet(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("privacy.linkEmail")}</DialogTitle>
            </DialogHeader>
            <LinkEmailForm
              verified={emailVerified}
              currentEmail={session?.webAccount?.email ?? null}
              onSuccess={() => setActiveSheet(null)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PrivacyItem({
  icon,
  iconBg,
  label,
  sublabel,
  linked,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  sublabel: string;
  linked?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-4 transition-all hover:bg-white/4 active:scale-[0.98]"
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 text-left">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-zinc-500">{sublabel}</p>
      </div>
      {linked && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Check className="h-3.5 w-3.5" />
        </span>
      )}
    </button>
  );
}

// ── Telegram linking ─────────────────────────────────────────────────────────

function LinkTelegramForm({ linked }: { linked: boolean }) {
  const { t } = useTranslation();
  const [code, setCode] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => initiateTelegramLink(),
    onSuccess: (data) => {
      setCode(data.code);
      setBotUsername(data.botUsername);
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.error(t("privacy.telegramAlreadyLinked"));
      } else {
        toast.error(t("privacy.linkError"));
      }
    },
  });

  const deepLink =
    code && botUsername ? `https://t.me/${botUsername}?start=link_${code}` : null;

  if (linked && code === null) {
    return (
      <div className="py-4 space-y-3">
        <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-emerald-400">
          <Check className="h-4 w-4 shrink-0" />
          <p className="text-sm">{t("privacy.telegramLinkedHint")}</p>
        </div>
        <p className="text-xs text-zinc-500">{t("privacy.telegramRelinkHint")}</p>
        <Button
          variant="outline"
          className="w-full"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? t("common.loading") : t("privacy.generateCode")}
        </Button>
      </div>
    );
  }

  return (
    <div className="py-4 space-y-4">
      <p className="text-sm text-muted-foreground">{t("privacy.linkTelegramHint")}</p>

      {code === null ? (
        <Button
          className="w-full"
          style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? t("common.loading") : t("privacy.generateCode")}
        </Button>
      ) : (
        <div className="space-y-4">
          {/* Code display */}
          <div className="space-y-2">
            <Label>{t("privacy.yourCode")}</Label>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(code);
                toast.success(t("common.copied"));
              }}
              className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/3 px-4 py-3 transition-colors hover:bg-white/5"
            >
              <span className="font-mono text-2xl tracking-[0.3em] text-white">{code}</span>
              <Copy className="h-4 w-4 text-zinc-400" />
            </button>
          </div>

          <p className="text-xs text-zinc-500">{t("privacy.telegramCodeInstructions")}</p>

          {deepLink && (
            <Button asChild className="w-full" style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}>
              <a href={deepLink} target="_blank" rel="noopener noreferrer">
                {t("privacy.openBot")}
              </a>
            </Button>
          )}

          <Button variant="ghost" className="w-full" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {t("privacy.regenerateCode")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Email linking ──────────────────────────────────────────────────────────

function LinkEmailForm({
  verified,
  currentEmail,
  onSuccess,
}: {
  verified: boolean;
  currentEmail: string | null;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState(currentEmail ?? "");
  const [code, setCode] = useState("");

  const initiateMutation = useMutation({
    mutationFn: () => initiateEmailLink(email.trim()),
    onSuccess: (data) => {
      if (data.success) {
        toast.success(t("privacy.emailCodeSent"));
        setStep("code");
      } else {
        toast.error(data.message || t("privacy.linkError"));
      }
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.error(t("privacy.emailAlreadyLinked"));
      } else {
        toast.error(t("privacy.linkError"));
      }
    },
  });

  const verifyMutation = useMutation({
    mutationFn: () => verifyEmailLink(code.trim()),
    onSuccess: (data) => {
      if (data.verified) {
        toast.success(t("privacy.emailVerified"));
        void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        onSuccess();
      } else {
        toast.error(t("privacy.emailCodeInvalid"));
      }
    },
    onError: (err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 410) {
        toast.error(t("privacy.emailCodeExpired"));
      } else if (status === 429) {
        toast.error(t("privacy.emailTooManyAttempts"));
        setStep("email");
      } else {
        toast.error(t("privacy.emailCodeInvalid"));
      }
    },
  });

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  if (verified && step === "email" && !initiateMutation.isPending) {
    return (
      <div className="py-4 space-y-3">
        <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-emerald-400">
          <Check className="h-4 w-4 shrink-0" />
          <p className="text-sm">{t("privacy.emailVerifiedHint", { email: currentEmail ?? "" })}</p>
        </div>
        <p className="text-xs text-zinc-500">{t("privacy.emailRelinkHint")}</p>
        <div className="space-y-2">
          <Label>Email</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
          />
        </div>
        <Button
          variant="outline"
          className="w-full"
          disabled={!emailValid || initiateMutation.isPending}
          onClick={() => initiateMutation.mutate()}
        >
          {t("privacy.sendVerification")}
        </Button>
      </div>
    );
  }

  return (
    <div className="py-4 space-y-4">
      {step === "email" ? (
        <>
          <p className="text-sm text-muted-foreground">{t("privacy.linkEmailHint")}</p>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </div>
          <Button
            className="w-full"
            style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
            disabled={!emailValid || initiateMutation.isPending}
            onClick={() => initiateMutation.mutate()}
          >
            {initiateMutation.isPending ? t("common.loading") : t("privacy.sendVerification")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("privacy.emailCodeHint", { email: email.trim() })}
          </p>
          <div className="space-y-2">
            <Label>{t("privacy.verificationCode")}</Label>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              className="text-center font-mono text-xl tracking-[0.4em]"
            />
          </div>
          <Button
            className="w-full"
            style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
            disabled={code.length !== 6 || verifyMutation.isPending}
            onClick={() => verifyMutation.mutate()}
          >
            {verifyMutation.isPending ? t("common.loading") : t("common.confirm")}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setStep("email");
              setCode("");
            }}
          >
            {t("common.back")}
          </Button>
        </>
      )}
    </div>
  );
}

// ── Change password ──────────────────────────────────────────────────────────

function ChangePasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const currentHash = await sha256(currentPassword);
      const newHash = await sha256(newPassword);
      return changePasswordAuth({ currentPasswordHash: currentHash, newPasswordHash: newHash });
    },
    onSuccess: () => {
      toast.success(t("privacy.passwordChanged"));
      onSuccess();
    },
    onError: () => toast.error(t("privacy.passwordError")),
  });

  return (
    <div className="py-4 space-y-4">
      <div className="space-y-2">
        <Label>{t("privacy.currentPassword")}</Label>
        <Input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>
      <div className="space-y-2">
        <Label>{t("privacy.newPassword")}</Label>
        <Input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>
      <Button
        className="w-full"
        style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
        disabled={!currentPassword || newPassword.length < 8 || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? t("common.loading") : t("privacy.changePassword")}
      </Button>
    </div>
  );
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

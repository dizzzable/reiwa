/**
 * PrivacyPage
 * ───────────
 * Security & account linking settings:
 *   - Change password
 *   - Link Telegram account
 *   - Link Email (for password recovery)
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Key, Mail, Send } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { changePasswordAuth } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export default function PrivacyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [activeSheet, setActiveSheet] = useState<"password" | "telegram" | "email" | null>(null);

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
          sublabel={t("privacy.linkTelegramSub")}
          onClick={() => setActiveSheet("telegram")}
        />
        <PrivacyItem
          icon={<Mail className="h-5 w-5" />}
          iconBg="bg-emerald-500/10 text-emerald-400"
          label={t("privacy.linkEmail")}
          sublabel={t("privacy.linkEmailSub")}
          onClick={() => setActiveSheet("email")}
        />
      </div>

      {/* Change Password Sheet */}
      <Sheet open={activeSheet === "password"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("privacy.changePassword")}</SheetTitle>
          </SheetHeader>
          <ChangePasswordForm onSuccess={() => setActiveSheet(null)} />
        </SheetContent>
      </Sheet>

      {/* Link Telegram Sheet */}
      <Sheet open={activeSheet === "telegram"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("privacy.linkTelegram")}</SheetTitle>
          </SheetHeader>
          <div className="py-4 space-y-3">
            <p className="text-sm text-muted-foreground">{t("privacy.linkTelegramHint")}</p>
            <Button className="w-full" style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}>
              {t("privacy.generateCode")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Link Email Sheet */}
      <Sheet open={activeSheet === "email"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("privacy.linkEmail")}</SheetTitle>
          </SheetHeader>
          <div className="py-4 space-y-3">
            <p className="text-sm text-muted-foreground">{t("privacy.linkEmailHint")}</p>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" placeholder="user@example.com" />
            </div>
            <Button className="w-full" style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}>
              {t("privacy.sendVerification")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PrivacyItem({
  icon,
  iconBg,
  label,
  sublabel,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  sublabel: string;
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
    </button>
  );
}

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

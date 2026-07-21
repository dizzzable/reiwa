/**
 * Quests entry icon + modal — the cabinet gamification surface.
 *
 * Renders a neutral-glass header button (distinct from the aggressive purchase
 * ring) with a subtle "glint" sheen to draw the eye, an unclaimed-count badge,
 * and a glass modal listing the quests relevant to the user with a manual
 * "Забрать" (claim) action. The whole entry hides when the user has no relevant
 * quests. Server (`GET /quests`) is the single source of truth.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  Gift,
  Mail,
  Megaphone,
  Send,
  Sparkles,
  Star,
  Trophy,
  Users,
  type LucideIcon,
} from "lucide-react";

import {
  claimQuest,
  confirmPartnerVisit,
  getQuests,
  questIconUrl,
  startPartnerVisit,
  submitPartnerCode,
  type QuestCabinetItem,
  type QuestClaimResult,
  type QuestLocalizedText,
} from "@/lib/api-client/quests";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBranding } from "@/lib/branding-provider";
import { cn } from "@/lib/utils";

const PRESET_ICONS: Record<string, LucideIcon> = {
  telegram: Send,
  mail: Mail,
  email: Mail,
  gift: Gift,
  trophy: Trophy,
  sparkles: Sparkles,
  star: Star,
  users: Users,
  invite: Users,
  megaphone: Megaphone,
};

export function QuestsIcon(): JSX.Element | null {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["quests"],
    queryFn: getQuests,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const quests = data?.quests ?? [];
  if (quests.length === 0) return null;
  const unclaimed = quests.filter((q) => q.claimable).length;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label={t("quests.iconAria")}
        className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-white/6 bg-white/3 text-zinc-400 transition-colors hover:bg-white/6 hover:text-white"
      >
        <Sparkles className="h-4 w-4" />
        {!reduceMotion && (
          <span
            aria-hidden
            className="animate-glint pointer-events-none absolute inset-y-0 -left-1/2 w-1/2"
            style={{
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
            }}
          />
        )}
        {unclaimed > 0 && (
          <span className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center">
            <span className="relative inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-(--brand-primary) px-1 text-[9px] font-bold leading-none text-(--brand-primary-fg)">
              {unclaimed > 9 ? "9+" : unclaimed}
            </span>
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("quests.title")}</DialogTitle>
            <DialogDescription>{t("quests.subtitle")}</DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between rounded-xl border border-white/8 bg-white/3 px-3 py-2 text-sm">
            <span className="text-zinc-300">
              {t("quests.pointsBalance", { count: data?.pointsBalance ?? 0 })}
            </span>
            <QuestsExchangeLink onNavigate={() => setOpen(false)} />
          </div>

          <div className="mt-2 max-h-[55vh] space-y-2 overflow-y-auto">
            {quests.map((quest) => (
              <QuestRow key={quest.id} quest={quest} onClose={() => setOpen(false)} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function QuestsExchangeLink({ onNavigate }: { onNavigate: () => void }): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate();
        navigate("/referrals/exchange");
      }}
      className="text-xs font-medium text-(--brand-primary) hover:brightness-110"
    >
      {t("quests.exchangeLink")}
    </button>
  );
}

function QuestRow({
  quest,
  onClose,
}: {
  quest: QuestCabinetItem;
  onClose: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { botUsername } = useBranding();

  const claim = useMutation({
    mutationFn: () => claimQuest(quest.id),
    onSuccess: (result: QuestClaimResult) => {
      void queryClient.invalidateQueries({ queryKey: ["quests"] });
      void queryClient.invalidateQueries({ queryKey: ["subscriptions", "all"] });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
      toast.success(
        result.promoCode
          ? t("quests.claimedPromo", { code: result.promoCode })
          : t("quests.claimed", { reward: rewardSummary(t, quest) }),
      );
    },
    onError: () => toast.error(t("quests.claimFailed")),
  });

  const IconGlyph = PRESET_ICONS[quest.iconRef] ?? Sparkles;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/3 p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-(--brand-primary)/12 text-(--brand-primary)">
        {quest.iconKind === "SVG" && quest.iconRef.length > 0 ? (
          <img src={questIconUrl(quest.iconRef)} alt="" className="h-5 w-5" />
        ) : (
          <IconGlyph className="h-5 w-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {/* Title: at most 2 lines; description wraps fully so operators' copy
            is not cut mid-word (cabinet quests dialog regression). */}
        <p className="line-clamp-2 break-words text-sm font-medium text-white">
          {loc(quest.title, i18n.language)}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-snug text-zinc-400">
          {loc(quest.description, i18n.language)}
        </p>
        <p className="mt-1 text-[11px] font-medium text-(--brand-primary)">
          {rewardSummary(t, quest)}
          {quest.type === "INVITE_FRIENDS" && quest.requiredFriends
            ? ` · ${t("quests.progress", { current: quest.progress, required: quest.requiredFriends })}`
            : ""}
        </p>
      </div>
      <div className="shrink-0">
        {quest.claimable ? (
          <button
            type="button"
            disabled={claim.isPending}
            onClick={() => claim.mutate()}
            className="rounded-lg bg-(--brand-primary) px-3 py-1.5 text-xs font-semibold text-(--brand-primary-fg) disabled:opacity-50"
          >
            {claim.isPending ? t("quests.claiming") : t("quests.claim")}
          </button>
        ) : quest.type === "SUBSCRIBE_CHANNEL" ? (
          botUsername ? (
            <a
              href={`https://t.me/${botUsername}?start=quest_channel_${quest.id}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => onClose()}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white"
            >
              {t("quests.actions.openBot")}
            </a>
          ) : null
        ) : quest.type === "PARTNER_TASK" ? (
          <PartnerAction quest={quest} />
        ) : (
          questAction(quest.type) && (
            <button
              type="button"
              onClick={() => {
                onClose();
                navigate(questAction(quest.type)!.route);
              }}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white"
            >
              {t(questAction(quest.type)!.labelKey)}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function PartnerAction({ quest }: { quest: QuestCabinetItem }): JSX.Element | null {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear the dwell countdown on unmount — the Dialog unmounts its content and
  // the list can hide the row on refetch, so a bare setInterval would keep
  // ticking and call setRemaining on a dead component.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, []);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["quests"] });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const codeMutation = useMutation({
    mutationFn: () => submitPartnerCode(quest.id, code.trim()),
    onSuccess: () => {
      invalidate();
      toast.success(t("quests.partner.verified"));
    },
    onError: () => toast.error(t("quests.partner.codeInvalid")),
  });

  const startMutation = useMutation({
    mutationFn: () => startPartnerVisit(quest.id),
    onSuccess: (r) => {
      if (r.landingUrl) window.open(r.landingUrl, "_blank", "noopener,noreferrer");
      setRemaining(quest.partnerVisitSeconds ?? 15);
      if (timerRef.current !== null) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setRemaining((prev) => {
          if (prev === null || prev <= 1) {
            if (timerRef.current !== null) clearInterval(timerRef.current);
            timerRef.current = null;
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    },
    onError: () => toast.error(t("quests.partner.failed")),
  });

  const confirmMutation = useMutation({
    mutationFn: () => confirmPartnerVisit(quest.id),
    onSuccess: () => {
      invalidate();
      toast.success(t("quests.partner.verified"));
    },
    // On a server-side dwell rejection, reset so the user can restart the visit
    // instead of being stuck on a dead Confirm button.
    onError: () => {
      setRemaining(null);
      toast.error(t("quests.partner.failed"));
    },
  });

  const btn = "rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white disabled:opacity-50";

  if (quest.partnerMethod === "manual_code") {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label={t("quests.partner.codePlaceholder")}
          placeholder={t("quests.partner.codePlaceholder")}
          autoComplete="off"
          className="w-24 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-xs text-white placeholder:text-zinc-500"
        />
        <button
          type="button"
          disabled={code.trim().length === 0 || codeMutation.isPending}
          onClick={() => codeMutation.mutate()}
          className={cn(btn, "bg-(--brand-primary) font-semibold text-(--brand-primary-fg)")}
        >
          {codeMutation.isPending ? t("quests.partner.submitting") : t("quests.partner.submitCode")}
        </button>
      </div>
    );
  }

  if (quest.partnerMethod === "postback") {
    if (!quest.partnerUrl) return null;
    // Postback rewards land asynchronously (the partner signs a callback to
    // rezeis), so surface that expectation — otherwise the row just looks stuck
    // after the user returns from the partner.
    return (
      <div className="flex flex-col items-end gap-1">
        <a
          href={quest.partnerUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${t("quests.partner.open")} ${t("quests.partner.newTab")}`}
          className={btn}
        >
          {t("quests.partner.open")}
        </a>
        <span className="max-w-[180px] text-right text-[10px] leading-tight text-zinc-500">
          {t("quests.partner.pendingPostback")}
        </span>
      </div>
    );
  }

  if (quest.partnerMethod === "timed_visit") {
    // Not started yet → open the partner link and begin the server-timed dwell.
    if (remaining === null) {
      return (
        <button
          type="button"
          disabled={startMutation.isPending || !quest.partnerUrl}
          onClick={() => startMutation.mutate()}
          className={btn}
        >
          {t("quests.partner.openVisit")}
        </button>
      );
    }
    // Dwell elapsed → the confirm is authoritative-checked server-side.
    if (remaining <= 0) {
      return (
        <button
          type="button"
          disabled={confirmMutation.isPending}
          onClick={() => confirmMutation.mutate()}
          className={cn(btn, "bg-(--brand-primary) font-semibold text-(--brand-primary-fg)")}
        >
          {t("quests.partner.confirmVisit")}
        </button>
      );
    }
    // Counting down. `aria-live="off"` — a per-second SR announcement would be
    // noise; the Confirm button becoming enabled is the meaningful state change.
    return (
      <span aria-live="off" className="text-xs text-zinc-400">
        {t("quests.partner.waitSeconds", { count: remaining })}
      </span>
    );
  }

  return null;
}

function questAction(type: QuestCabinetItem["type"]): { route: string; labelKey: string } | null {
  switch (type) {
    case "LINK_TELEGRAM":
    case "LINK_EMAIL":
      return { route: "/settings", labelKey: "quests.actions.link" };
    case "INVITE_FRIENDS":
      return { route: "/referrals", labelKey: "quests.actions.invite" };
    default:
      return null;
  }
}

function rewardSummary(t: (k: string, o?: Record<string, unknown>) => string, quest: QuestCabinetItem): string {
  switch (quest.rewardType) {
    case "POINTS":
      return t("quests.reward.points", { count: quest.rewardAmount });
    case "DAYS":
      return t("quests.reward.days", { count: quest.rewardAmount });
    case "DISCOUNT":
      return t("quests.reward.discount", { count: quest.rewardAmount });
    case "TRAFFIC":
      return t("quests.reward.traffic", { count: quest.rewardAmount });
    case "PROMOCODE":
      return t("quests.reward.promocode");
    default:
      return "";
  }
}

function loc(text: QuestLocalizedText, lang: string): string {
  const key = lang.startsWith("ru") ? "ru" : "en";
  return text[key] || text.en || text.ru || "";
}

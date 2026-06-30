/**
 * PartnerAdvertisingSection
 * ─────────────────────────
 * Compact advertising block inside the partner cabinet:
 *   - per-placement stats (opens / registrations / conversions / earned),
 *   - a request form to propose a new advertising campaign (platforms +
 *     attribution window), moderated by the operator,
 *   - the partner's own request history with status.
 *
 * Inline helper text gives the "what / how" context (mobile-friendly, no
 * hover-only tooltips).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Megaphone } from "lucide-react";

import {
  createPartnerAdRequest,
  getPartnerAdRequests,
  getPartnerAdStats,
  type AdPlatform,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PLATFORMS: readonly AdPlatform[] = [
  "TELEGRAM",
  "YOUTUBE",
  "TIKTOK",
  "INSTAGRAM",
  "VK",
  "WEBSITE",
  "OTHER",
];

export function PartnerAdvertisingSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<AdPlatform[]>([]);
  const [channel, setChannel] = useState("");
  const [windowDays, setWindowDays] = useState("30");

  const stats = useQuery({ queryKey: ["partner", "ads", "stats"], queryFn: getPartnerAdStats });
  const requests = useQuery({
    queryKey: ["partner", "ads", "requests"],
    queryFn: getPartnerAdRequests,
  });

  const submit = useMutation({
    mutationFn: () =>
      createPartnerAdRequest({
        platforms: selected,
        channel: channel.trim() || undefined,
        proposedWindowDays: Math.max(1, Math.min(365, Number(windowDays) || 30)),
      }),
    onSuccess: () => {
      toast.success(t("partnerAds.submitted"));
      setSelected([]);
      setChannel("");
      queryClient.invalidateQueries({ queryKey: ["partner", "ads"] });
    },
    onError: () => toast.error(t("partnerAds.submitError")),
  });

  const togglePlatform = (p: AdPlatform) =>
    setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));

  const placements = stats.data?.placements ?? [];
  const reqs = requests.data?.requests ?? [];

  return (
    <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
      <div className="flex items-center gap-2">
        <Megaphone className="h-4 w-4 text-(--brand-primary)" />
        <h2 className="text-sm font-semibold">{t("partnerAds.title")}</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("partnerAds.subtitle")}</p>

      {/* Per-placement stats */}
      {stats.isLoading ? (
        <Skeleton className="mt-3 h-20 w-full rounded-xl" />
      ) : placements.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {placements.map((p) => (
            <div key={p.placementId} className="rounded-xl border border-white/6 bg-white/2 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{t(`partnerAds.platforms.${p.platform}`)}</span>
                <span className="text-[10px] text-muted-foreground">{p.channel ?? ""}</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1 text-center">
                <Stat label={t("partnerAds.opens")} value={p.opens} />
                <Stat label={t("partnerAds.regs")} value={p.registrations} />
                <Stat label={t("partnerAds.conv")} value={p.conversions} />
                <Stat label={t("partnerAds.earned")} value={`${(p.earnedMinor / 100).toFixed(0)}₽`} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">{t("partnerAds.noPlacements")}</p>
      )}

      {/* Request form */}
      <div className="mt-4 space-y-2 rounded-xl border border-white/6 bg-white/2 p-3">
        <p className="text-xs font-medium">{t("partnerAds.newRequest")}</p>
        <p className="text-[11px] text-muted-foreground">{t("partnerAds.platformsHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => togglePlatform(p)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                selected.includes(p)
                  ? "border-(--brand-primary) bg-(--brand-primary)/15 text-foreground"
                  : "border-white/10 text-muted-foreground"
              }`}
            >
              {t(`partnerAds.platforms.${p}`)}
            </button>
          ))}
        </div>
        <input
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          placeholder={t("partnerAds.channelPlaceholder")}
          className="w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
        />
        <div>
          <label className="text-[11px] text-muted-foreground">{t("partnerAds.windowLabel")}</label>
          <input
            type="number"
            min="1"
            max="365"
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">{t("partnerAds.windowHint")}</p>
        </div>
        <Button
          className="w-full"
          style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
          disabled={selected.length === 0 || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {t("partnerAds.submit")}
        </Button>
      </div>

      {/* Request history */}
      {reqs.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {reqs.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between rounded-lg border border-white/6 bg-white/2 px-3 py-2 text-xs"
            >
              <span>{r.platforms.map((p) => t(`partnerAds.platforms.${p}`)).join(", ")}</span>
              <span className="text-muted-foreground">{t(`partnerAds.status.${r.status}`, r.status)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
      <p className="text-[9px] text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * PartnerAdvertisingSection
 * ─────────────────────────
 * Compact advertising block inside the partner cabinet:
 *   - per-placement stats + copyable tracking links (bot / miniapp / web),
 *   - dual QR for bot + web when URLs are available,
 *   - a request form to propose a new advertising campaign,
 *   - request history with Accept for COUNTERED operator terms.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Copy, Megaphone } from "lucide-react";

import {
  acceptPartnerAdRequest,
  createPartnerAdRequest,
  getPartnerAdRequests,
  getPartnerAdStats,
  type AdPlatform,
  type PartnerAdPlacementStat,
  type PartnerAdRequest,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { LocalQr } from "@/components/ui/local-qr";
import { Skeleton } from "@/components/ui/skeleton";

const PLATFORMS: readonly AdPlatform[] = [
  "TELEGRAM",
  "TELEGRAM_ADS",
  "YOUTUBE",
  "TIKTOK",
  "INSTAGRAM",
  "VK",
  "WEBSITE",
  "INFLUENCER",
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

  const accept = useMutation({
    mutationFn: (id: string) => acceptPartnerAdRequest(id),
    onSuccess: () => {
      toast.success(t("partnerAds.accepted"));
      queryClient.invalidateQueries({ queryKey: ["partner", "ads"] });
    },
    onError: () => toast.error(t("partnerAds.acceptError")),
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

      {stats.isLoading ? (
        <Skeleton className="mt-3 h-20 w-full rounded-xl" />
      ) : placements.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {placements.map((p) => (
            <PlacementCard key={p.placementId} placement={p} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">{t("partnerAds.noPlacements")}</p>
      )}

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

      {reqs.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {reqs.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              accepting={accept.isPending}
              onAccept={() => accept.mutate(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlacementCard({ placement: p }: { placement: PartnerAdPlacementStat }) {
  const { t } = useTranslation();
  const botUrl = p.links?.botStart || "";
  const webUrl = p.links?.miniAppWeb || "";
  const miniUrl = p.links?.miniAppStart || "";
  const runnable = p.status === "ACTIVE" || p.status === "PAUSED";

  return (
    <div className="rounded-xl border border-white/6 bg-white/2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t(`partnerAds.platforms.${p.platform}`)}</span>
        <span className="text-[10px] text-muted-foreground">{p.channel ?? ""}</span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1 text-center">
        <Stat label={t("partnerAds.opens")} value={p.opens} />
        <Stat label={t("partnerAds.regs")} value={p.registrations} />
        <Stat label={t("partnerAds.conv")} value={p.conversions} />
        <Stat label={t("partnerAds.earned")} value={`${(p.earnedMinor / 100).toFixed(0)}₽`} />
      </div>

      {runnable && (p.payload || botUrl || webUrl) && (
        <div className="mt-3 space-y-2 border-t border-white/6 pt-2">
          <p className="text-[10px] font-medium text-muted-foreground">{t("partnerAds.linksTitle")}</p>
          {p.payload && <CopyRow label={t("partnerAds.payload")} value={p.payload} />}
          {botUrl && <CopyRow label={t("partnerAds.linkBot")} value={botUrl} />}
          {miniUrl && <CopyRow label={t("partnerAds.linkMiniApp")} value={miniUrl} />}
          {webUrl && <CopyRow label={t("partnerAds.linkWeb")} value={webUrl} />}
          {(botUrl || webUrl) && (
            <div className="flex flex-wrap gap-3 pt-1">
              {botUrl && <LocalQr label={t("partnerAds.qrBot")} url={botUrl} size={96} />}
              {webUrl && <LocalQr label={t("partnerAds.qrWeb")} url={webUrl} size={96} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RequestRow({
  request: r,
  accepting,
  onAccept,
}: {
  request: PartnerAdRequest;
  accepting: boolean;
  onAccept: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/6 bg-white/2 px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <span>{r.platforms.map((p) => t(`partnerAds.platforms.${p}`)).join(", ")}</span>
        <span className="ml-2 text-muted-foreground">{t(`partnerAds.status.${r.status}`, r.status)}</span>
        {r.status === "COUNTERED" && r.approvedWindowDays != null && (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {t("partnerAds.counterHint", {
              proposed: r.proposedWindowDays,
              approved: r.approvedWindowDays,
            })}
          </p>
        )}
      </div>
      {r.status === "COUNTERED" && (
        <Button size="sm" className="h-7 shrink-0 text-xs" disabled={accepting} onClick={onAccept}>
          {t("partnerAds.accept")}
        </Button>
      )}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t("partnerAds.copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("partnerAds.copyError"));
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[9px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-black/20 px-1.5 py-0.5 text-[10px]">{value}</code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-white/10 text-muted-foreground hover:text-foreground"
        aria-label={t("partnerAds.copy")}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
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

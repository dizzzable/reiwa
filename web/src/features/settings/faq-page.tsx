/**
 * FaqPage
 * ───────
 * Frequently asked questions — accordion-style collapsible items.
 * Content is fetched from rezeis-admin via internal API.
 * Fallback: hardcoded FAQ items when API is unavailable.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ExternalLink, Maximize2 } from "lucide-react";
import { useId, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

import { Skeleton } from "@/components/ui/skeleton";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { getFaq, type FaqItem } from "@/lib/api-client";
import { getFaqMediaKind, normalizeFaqMediaUrls } from "./faq-media";
import { FaqMediaElement } from "./faq-media-element";
import { useMediaViewer } from "@/features/media-viewer/use-media-viewer";
import type { MediaViewerItem } from "@/features/media-viewer/media-viewer";
import { resolveFaqViewState } from "./faq-state";

export default function FaqPage() {
  const { t, i18n } = useTranslation();

  const { data: items, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["faq", i18n.language],
    queryFn: () => getFaq(i18n.language),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const viewState = resolveFaqViewState(items, isError, t);

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("settings.faq")}</h1>
      </div>

      <div className="mx-5 space-y-2">
        {viewState.showLoadError ? (
          <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-left">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-100">{t("faq.loadFailedTitle")}</p>
                <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
                  {t("faq.loadFailedBody")}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void refetch();
                }}
                disabled={isFetching}
                className="border-amber-300/30 bg-transparent text-amber-100 hover:bg-amber-500/10 hover:text-amber-50"
              >
                {t("common.retry")}
              </Button>
            </div>
          </div>
        ) : null}
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-2xl" />
          ))
        ) : viewState.showEmptyState ? (
          <div className="rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] px-5 py-8 text-center">
            <p className="text-sm font-medium text-[color:var(--brand-foreground)]">{t("faq.emptyTitle")}</p>
            <p className="mt-1 text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">{t("faq.emptyBody")}</p>
          </div>
        ) : (
          viewState.items.map((item) => (
            <FaqAccordionItem key={item.id} item={item} />
          ))
        )}
      </div>
    </div>
  );
}

function FaqAccordionItem({ item }: { item: FaqItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const accordionId = useId();
  const triggerId = `${accordionId}-trigger`;
  const panelId = `${accordionId}-panel`;
  const mediaUrls = normalizeFaqMediaUrls(item.mediaUrls);

  // Only what the viewer can actually show. A format the cabinet does not know
  // renders its fallback card in the grid and is skipped here, so the index a
  // thumbnail hands over always lines up with what is being paged through.
  const viewable: MediaViewerItem[] = mediaUrls.flatMap((url) => {
    const kind = getFaqMediaKind(url);
    if (kind === "unsupported") return [];
    return [
      {
        url,
        kind,
        label: t(kind === "image" ? "faq.mediaImageAlt" : "faq.mediaVideoLabel", {
          question: item.question,
        }),
      },
    ];
  });
  const viewer = useMediaViewer(viewable);

  return (
    <div className="overflow-hidden rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)]">
      <button
        type="button"
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-[color:var(--color-surface-high)]"
      >
        <span className="pr-4 text-sm font-medium text-[color:var(--brand-foreground)]">{item.question}</span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="shrink-0"
          aria-hidden="true"
        >
          <ChevronDown className="h-4 w-4 text-[color:var(--brand-muted-foreground)]" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={triggerId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">
              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">
                {item.answer}
              </div>
              {mediaUrls.length > 0 && (
                <div
                  className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
                  role="group"
                  aria-label={t("faq.mediaGroupLabel", { question: item.question })}
                >
                  {mediaUrls.map((url) => (
                    <FaqMedia
                      key={url}
                      url={url}
                      question={item.question}
                      onOpen={() => {
                        const at = viewable.findIndex((entry) => entry.url === url);
                        if (at >= 0) viewer.open(at);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {viewer.element}
    </div>
  );
}

function FaqMedia({
  url,
  question,
  onOpen,
}: {
  url: string;
  question: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const kind = getFaqMediaKind(url);

  if (failed || kind === "unsupported") {
    return (
      <FaqMediaFallback
        url={url}
        message={t(failed ? "faq.mediaLoadFailed" : "faq.mediaUnsupported")}
      />
    );
  }

  const label = t(kind === "image" ? "faq.mediaImageAlt" : "faq.mediaVideoLabel", {
    question,
  });

  return (
    <figure className="min-w-0 overflow-hidden rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)]">
      {kind === "image" ? (
        // A button, not a click handler on the image: the grid is the only way
        // to reach the viewer, so it has to be reachable from a keyboard and
        // announce itself to a screen reader as something that opens.
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("mediaViewer.openImage", { label })}
          className="block w-full cursor-zoom-in"
        >
          <FaqMediaElement kind={kind} url={url} label={label} onError={() => setFailed(true)} />
        </button>
      ) : (
        <>
          <FaqMediaElement kind={kind} url={url} label={label} onError={() => setFailed(true)} />
          {/* Video keeps its own controls, so the way to full screen is a
              separate control rather than a tap that would fight play/pause. */}
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full items-center justify-center gap-1.5 px-3 py-2 text-xs text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t("mediaViewer.expand")}
          </button>
        </>
      )}
    </figure>
  );
}

function FaqMediaFallback({ url, message }: { url: string; message: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)] p-4 text-center">
      <AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden="true" />
      <p className="text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">{message}</p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-cyan-300 transition-colors hover:bg-[color:var(--color-surface)] hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
      >
        {t("faq.mediaOpen")}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}

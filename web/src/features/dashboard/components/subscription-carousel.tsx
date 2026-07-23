/**
 * SubscriptionCarousel
 * ─────────────────────────────────────────────────────────────────────────────
 * Native scroll-snap carousel for real subscriptions and transient
 * provisioning receipts. Selection is controlled by stable item keys so a
 * provisioning→real handoff or first/middle/last deletion cannot point the
 * actions/devices panel at a different card.
 */

import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useLongPress } from "@/hooks/use-long-press";
import { useBranding } from "@/lib/branding-provider";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import type {
  AllSubscriptionsResponse,
  Subscription,
} from "@/types/api";

import {
  provisioningCarouselItemKey,
  resolveActiveCarouselItemKey,
  selectCarouselItemAfterRemoval,
  subscriptionCarouselItemKey,
  type SubscriptionCarouselItem,
  type SubscriptionCarouselProvisioningItem,
  type SubscriptionCarouselSubscriptionItem,
} from "../subscription-lifecycle-policy";
import { DeleteSubscriptionDialog } from "./delete-subscription-dialog";
import { SubscriptionCard } from "./subscription-card";
import { SubscriptionCreationMotion } from "./subscription-creation-motion";
import { SubscriptionDeletionMotion } from "./subscription-deletion-motion";
import {
  resolveSubscriptionCardVisual,
  type ResolvedSubscriptionCardVisual,
} from "./subscription-card-visual";

interface SubscriptionCarouselProps {
  readonly items: readonly SubscriptionCarouselItem[];
  readonly firstDeviceById?: Readonly<Record<string, string | null>>;
  readonly activeItemKey: string | null;
  readonly onActiveItemKeyChange: (itemKey: string | null) => void;
  readonly onProvisioningComplete: (
    paymentId: string,
    subscription: Subscription,
  ) => void;
}

interface DeleteTarget {
  readonly item: SubscriptionCarouselSubscriptionItem;
}

interface DeletingSubscription {
  readonly item: SubscriptionCarouselSubscriptionItem;
  readonly visual: ResolvedSubscriptionCardVisual;
}

export function SubscriptionCarousel({
  items,
  firstDeviceById,
  activeItemKey,
  onActiveItemKeyChange,
  onProvisioningComplete,
}: SubscriptionCarouselProps) {
  const { t } = useTranslation();
  const { branding } = useBranding();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState<DeletingSubscription | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A realtime invalidation can remove the committed row before the local
  // DELETE response reaches this tab. Keep the explicitly targeted snapshot
  // mounted until the dialog closes or the local dissolve completes.
  const protectedItem = deleting?.item ?? deleteTarget?.item ?? null;
  const renderedItems = useMemo(() => {
    if (
      protectedItem === null ||
      items.some((item) => item.key === protectedItem.key)
    ) {
      return [...items];
    }
    const next = [...items];
    next.splice(
      Math.min(protectedItem.slotIndex, next.length),
      0,
      protectedItem,
    );
    return next.map((item, slotIndex) => ({ ...item, slotIndex }));
  }, [items, protectedItem]);

  const itemKeys = renderedItems.map((item) => item.key);
  const activeKey = resolveActiveCarouselItemKey(itemKeys, activeItemKey);
  const activeIndex = Math.max(
    0,
    renderedItems.findIndex((item) => item.key === activeKey),
  );
  const count = renderedItems.length;
  const itemKeySignature = itemKeys.join("|");

  useEffect(() => {
    if (activeKey !== activeItemKey) {
      onActiveItemKeyChange(activeKey);
    }
  }, [activeItemKey, activeKey, onActiveItemKeyChange]);

  const commitActiveItem = useCallback(() => {
    const element = trackRef.current;
    if (!element || renderedItems.length === 0) return;
    const width = element.clientWidth || 1;
    const index = Math.max(
      0,
      Math.min(
        Math.round(element.scrollLeft / width),
        renderedItems.length - 1,
      ),
    );
    onActiveItemKeyChange(renderedItems[index]?.key ?? null);
  }, [onActiveItemKeyChange, renderedItems]);

  const handleScroll = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = setTimeout(commitActiveItem, 120);
  }, [commitActiveItem]);

  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    const onScrollEnd = () => commitActiveItem();
    element.addEventListener("scrollend", onScrollEnd);
    return () => element.removeEventListener("scrollend", onScrollEnd);
  }, [commitActiveItem]);

  useEffect(
    () => () => {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
      }
    },
    [],
  );

  const goTo = useCallback(
    (index: number, behavior: ScrollBehavior = "smooth") => {
      const element = trackRef.current;
      if (!element || renderedItems.length === 0) return;
      const clamped = Math.max(
        0,
        Math.min(index, renderedItems.length - 1),
      );
      element.scrollTo({
        left: clamped * element.clientWidth,
        behavior,
      });
    },
    [renderedItems.length],
  );

  // Item-key replacement (provisioning→real) and removal both remap to a
  // deterministic index. Use an instant correction; user arrow/dot navigation
  // remains smooth.
  useEffect(() => {
    if (count > 0) {
      goTo(activeIndex, "auto");
    }
  }, [activeIndex, count, goTo, itemKeySignature]);

  const beginCommittedDeletion = useCallback(
    (subscriptionId: string) => {
      const item =
        renderedItems.find(
          (
            candidate,
          ): candidate is SubscriptionCarouselSubscriptionItem =>
            candidate.kind === "subscription" &&
            candidate.subscription.id === subscriptionId,
        ) ??
        (deleteTarget?.item.subscription.id === subscriptionId
          ? deleteTarget.item
          : null);
      if (item === null) return;
      setDeleting({
        item,
        visual: resolveSubscriptionCardVisual(branding, item.slotIndex),
      });
    },
    [branding, deleteTarget, renderedItems],
  );

  const finishCommittedDeletion = useCallback(() => {
    if (deleting === null) return;
    const removedKey = deleting.item.key;
    const nextActiveKey = selectCarouselItemAfterRemoval(
      renderedItems.map((item) => item.key),
      removedKey,
      activeKey,
    );
    const subscriptionId = deleting.item.subscription.id;

    queryClient.setQueryData<AllSubscriptionsResponse>(
      subscriptionQueryKeys.all,
      (current) =>
        current === undefined
          ? current
          : {
              ...current,
              subscriptions: current.subscriptions.filter(
                (subscription) => subscription.id !== subscriptionId,
              ),
            },
    );
    setDeleting(null);
    setDeleteTarget(null);
    onActiveItemKeyChange(nextActiveKey);

    void queryClient.invalidateQueries({
      queryKey: subscriptionQueryKeys.all,
    });
    void queryClient.invalidateQueries({
      queryKey: subscriptionQueryKeys.detail,
    });
    void queryClient.invalidateQueries({ queryKey: ["action-policy"] });
    void queryClient.invalidateQueries({ queryKey: ["devices"] });
  }, [
    activeKey,
    deleting,
    onActiveItemKeyChange,
    queryClient,
    renderedItems,
  ]);

  if (count === 0) return null;

  return (
    <div className="relative">
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className="carousel-track flex snap-x snap-mandatory"
      >
        {renderedItems.map((item, index) =>
          item.kind === "subscription" ? (
            <RealSubscriptionSlide
              key={item.key}
              item={item}
              firstDevice={
                firstDeviceById?.[item.subscription.id] ?? null
              }
              effectActive={index === activeIndex}
              deleting={deleting?.item.key === item.key ? deleting : null}
              onLongPress={() => {
                if (deleting === null) setDeleteTarget({ item });
              }}
              onDeleteExitComplete={finishCommittedDeletion}
            />
          ) : (
            <ProvisioningSlide
              key={item.key}
              item={item}
              effectActive={index === activeIndex}
              labels={{
                creating: t("subscriptionProvisioning.creating"),
                calibrating: t("subscriptionProvisioning.calibrating"),
                waiting: t("subscriptionProvisioning.waiting"),
                longWaiting: t("subscriptionProvisioning.longWaiting"),
                ready: t("subscriptionProvisioning.ready"),
                failed: t("subscriptionProvisioning.failed"),
                failedHint: t("subscriptionProvisioning.failedHint"),
              }}
              planName={t("dashboard.subscription")}
              onSequenceComplete={(subscription) =>
                onProvisioningComplete(
                  item.receipt.paymentId,
                  subscription,
                )
              }
            />
          ),
        )}
      </div>

      {count > 1 && (
        <>
          {activeIndex > 0 && (
            <button
              onClick={() => goTo(activeIndex - 1)}
              className="absolute top-1/2 left-2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 sm:flex"
              aria-label={t("subscription.previousCard")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {activeIndex < count - 1 && (
            <button
              onClick={() => goTo(activeIndex + 1)}
              className="absolute top-1/2 right-2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/70 sm:flex"
              aria-label={t("subscription.nextCard")}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </>
      )}

      {count > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1.5">
          {renderedItems.map((item, index) => (
            <button
              key={item.key}
              onClick={() => goTo(index)}
              aria-label={t("subscription.carouselItemAria", {
                index: index + 1,
              })}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                index === activeIndex
                  ? "w-4 bg-(--brand-primary)"
                  : "w-1.5 bg-white/20 hover:bg-white/40"
              }`}
            />
          ))}
        </div>
      )}

      <DeleteSubscriptionDialog
        subscription={deleteTarget?.item.subscription ?? null}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onServerCommitted={beginCommittedDeletion}
      />
    </div>
  );
}

function SlideShell({
  children,
  onLongPress,
}: {
  readonly children: React.ReactNode;
  readonly onLongPress?: () => void;
}) {
  const longPress = useLongPress(onLongPress ?? (() => undefined));
  return (
    <div
      className="relative w-full shrink-0 snap-center snap-always"
      style={{
        paddingLeft: "1.25rem",
        paddingRight: "1.25rem",
        boxSizing: "border-box",
        WebkitTouchCallout: "none",
      }}
      {...(onLongPress ? longPress : {})}
    >
      {children}
    </div>
  );
}

function RealSubscriptionSlide({
  item,
  firstDevice,
  effectActive,
  deleting,
  onLongPress,
  onDeleteExitComplete,
}: {
  readonly item: SubscriptionCarouselSubscriptionItem;
  readonly firstDevice: string | null;
  readonly effectActive: boolean;
  readonly deleting: DeletingSubscription | null;
  readonly onLongPress: () => void;
  readonly onDeleteExitComplete: () => void;
}) {
  const card = (
    <SubscriptionCard
      subscription={item.subscription}
      index={item.slotIndex}
      firstDevice={firstDevice}
      effectActive={effectActive}
      visual={deleting?.visual}
    />
  );

  return (
    <SlideShell onLongPress={deleting === null ? onLongPress : undefined}>
      {deleting === null ? (
        card
      ) : (
        <SubscriptionDeletionMotion
          active
          visual={deleting.visual}
          onExitComplete={onDeleteExitComplete}
        >
          {card}
        </SubscriptionDeletionMotion>
      )}
    </SlideShell>
  );
}

function ProvisioningSlide({
  item,
  effectActive,
  labels,
  planName,
  onSequenceComplete,
}: {
  readonly item: SubscriptionCarouselProvisioningItem;
  readonly effectActive: boolean;
  readonly labels: React.ComponentProps<
    typeof SubscriptionCreationMotion
  >["labels"];
  readonly planName: string;
  readonly onSequenceComplete: (subscription: Subscription) => void;
}) {
  const { branding } = useBranding();
  const visual = useMemo(
    () => resolveSubscriptionCardVisual(branding, item.slotIndex),
    [branding, item.slotIndex],
  );

  return (
    <SlideShell>
      <SubscriptionCreationMotion
        visual={visual}
        backendReady={item.backendReady}
        failed={item.failed}
        readySubscription={item.readySubscription}
        firstDevice={
          item.readySubscription === null ? null : undefined
        }
        planName={item.readySubscription?.plan?.name ?? planName}
        labels={labels}
        effectActive={effectActive}
        onSequenceComplete={onSequenceComplete}
      />
    </SlideShell>
  );
}

export {
  provisioningCarouselItemKey,
  subscriptionCarouselItemKey,
};

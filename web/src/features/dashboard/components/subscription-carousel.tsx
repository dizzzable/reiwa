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
import { useReducedMotion } from "motion/react";

import { useLongPress } from "@/hooks/use-long-press";
import { useBranding } from "@/lib/branding-provider";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import { cn } from "@/lib/utils";
import type {
  AllSubscriptionsResponse,
  Subscription,
} from "@/types/api";

import {
  provisioningCarouselItemKey,
  resolveActiveCarouselItemKeyWithDeleteTarget,
  retainCarouselItemDuringDeletion,
  selectCarouselItemAfterRemoval,
  subscriptionCarouselItemKey,
  type SubscriptionCarouselItem,
  type SubscriptionCarouselProvisioningItem,
  type SubscriptionCarouselSubscriptionItem,
} from "../subscription-lifecycle-policy";
import { DeleteSubscriptionDialog } from "./delete-subscription-dialog";
import { SubscriptionCard } from "./subscription-card";
import { SubscriptionCreationMotion } from "./subscription-creation-motion";
import {
  resolveSubscriptionCardVisual,
  type ResolvedSubscriptionCardVisual,
} from "./subscription-card-visual";
import { SubscriptionDeletionMotion } from "./subscription-deletion-motion";
import type { SubscriptionDeletionServerStatus } from "./subscription-deletion-motion-policy";

interface SubscriptionCarouselProps {
  readonly items: readonly SubscriptionCarouselItem[];
  readonly firstDeviceById?: Readonly<Record<string, string | null>>;
  readonly activeItemKey: string | null;
  readonly onActiveItemKeyChange: (itemKey: string | null) => void;
  readonly onProvisioningComplete: (
    paymentId: string,
    subscription: Subscription,
  ) => void;
  /**
   * Keeps the carousel subtree mounted while confirmation or the deletion
   * presentation owns a frozen subscription snapshot.
   */
  readonly onDeleteGuardActiveChange?: (active: boolean) => void;
}

interface DeleteTarget {
  readonly item: SubscriptionCarouselSubscriptionItem;
}

export function SubscriptionCarouselPagination({
  count,
  activeIndex,
  disabled,
  onSelect,
  getLabel,
}: {
  readonly count: number;
  readonly activeIndex: number;
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
  readonly getLabel: (index: number) => string;
}) {
  if (count <= 1) return null;

  return (
    <div className="mt-3 flex items-center justify-center gap-1.5">
      {Array.from({ length: count }, (_, index) => (
        <button
          key={index}
          type="button"
          data-subscription-carousel-dot
          onClick={() => onSelect(index)}
          disabled={disabled}
          aria-label={getLabel(index)}
          aria-current={index === activeIndex ? "true" : undefined}
          className="group flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--brand-bg-primary)] disabled:cursor-not-allowed"
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 rounded-full transition-all duration-200",
              index === activeIndex
                ? "w-4 bg-(--brand-primary)"
                : "w-1.5 bg-[color:var(--color-border-strong)] group-hover:bg-[color:var(--brand-muted-foreground)]",
            )}
          />
        </button>
      ))}
    </div>
  );
}

interface DeletionPresentation {
  readonly operationId: number;
  readonly item: SubscriptionCarouselSubscriptionItem;
  readonly firstDevice: string | null;
  readonly visual: ResolvedSubscriptionCardVisual;
  readonly startedAtMs: number;
  readonly serverStatus: SubscriptionDeletionServerStatus;
  readonly serverSettledAtMs: number | null;
  readonly nextActiveKey: string | null;
  readonly reducedMotion: boolean;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/**
 * How many slides either side of the selected one keep their renderer warm.
 *
 * WHAT WENT WRONG: only the selected slide was ever allowed a live renderer, so
 * every swipe tore one down and built the next from nothing. That was survivable
 * while a fresh renderer simply started drawing; once the release added a 420 ms
 * reveal crossfade it meant the incoming card showed the flat operator gradient
 * and watermark for the whole of it, on every swipe, in both directions.
 *
 * One either side, not more. A swipe can only reach a neighbour, so a second
 * ring buys nothing a user can see while costing GPU contexts on a device that
 * counts them; and warming is asked of the shared budget, which is what actually
 * bounds the total — see `useCardEffectWarmSlot`. A carousel of twenty
 * subscriptions still warms exactly two, because "neighbour" is a distance from
 * the selected slide and not a count of the list.
 */
const CARD_EFFECT_WARM_RADIUS = 1;

export function SubscriptionCarousel({
  items,
  firstDeviceById,
  activeItemKey,
  onActiveItemKeyChange,
  onProvisioningComplete,
  onDeleteGuardActiveChange,
}: SubscriptionCarouselProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { branding } = useBranding();
  const prefersReducedMotion = useReducedMotion();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deletion, setDeletion] =
    useState<DeletionPresentation | null>(null);
  const deletionRef = useRef<DeletionPresentation | null>(null);
  const operationIdRef = useRef(0);
  const [handoffItemKey, setHandoffItemKey] = useState<string | null>(
    null,
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A realtime invalidation or an early successful DELETE may remove the
  // canonical row while the local presentation still owns it. The immutable
  // snapshot keeps the exact card mounted through dialog, sweep and handoff.
  const protectedItem = deletion?.item ?? deleteTarget?.item ?? null;
  const holdsProtectedItem = protectedItem !== null;
  useEffect(() => {
    onDeleteGuardActiveChange?.(holdsProtectedItem);
  }, [holdsProtectedItem, onDeleteGuardActiveChange]);
  // Safety net: the parent holds its branch open on our word, so if we go away
  // for any other reason (route change, remount) we must take that word back —
  // otherwise the dashboard would sit on an empty carousel indefinitely.
  useEffect(
    () => () => {
      onDeleteGuardActiveChange?.(false);
    },
    [onDeleteGuardActiveChange],
  );

  const renderedItems = useMemo(
    () => retainCarouselItemDuringDeletion(items, protectedItem),
    [items, protectedItem],
  );

  const itemKeys = renderedItems.map((item) => item.key);
  const activeKey = resolveActiveCarouselItemKeyWithDeleteTarget(
    itemKeys,
    activeItemKey,
    protectedItem?.key ?? null,
  );
  const activeIndex = Math.max(
    0,
    renderedItems.findIndex((item) => item.key === activeKey),
  );
  const count = renderedItems.length;
  const itemKeySignature = itemKeys.join("|");

  useEffect(() => {
    // The protected slide is one we re-inserted locally; the parent's list does
    // not contain it, so pushing its key up would ping-pong — the parent
    // resolves it back to a key from its own list, we resolve to the protected
    // one again, and the two update each other while the dialog is open.
    // The successful delete callback hands the final key over explicitly, so
    // nothing is lost by staying quiet while deletion owns this snapshot.
    if (protectedItem !== null && activeKey === protectedItem.key) return;
    if (activeKey !== activeItemKey) {
      onActiveItemKeyChange(activeKey);
    }
  }, [activeItemKey, activeKey, onActiveItemKeyChange, protectedItem]);

  const commitActiveItem = useCallback(() => {
    if (deletionRef.current !== null) return;
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

  useEffect(() => {
    if (handoffItemKey === null) return;
    const frame = window.requestAnimationFrame(() => {
      const track = trackRef.current;
      const target = Array.from(track?.children ?? []).find(
        (candidate) =>
          candidate instanceof HTMLElement &&
          candidate.dataset.carouselItemKey === handoffItemKey,
      );
      if (target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
      }
    });
    const timer = window.setTimeout(
      () =>
        setHandoffItemKey((current) =>
          current === handoffItemKey ? null : current,
        ),
      250,
    );
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [handoffItemKey]);

  const beginSubscriptionDeletion = useCallback(
    (subscriptionId: string) => {
      if (deletionRef.current !== null) return;
      const target = deleteTarget?.item;
      if (target?.subscription.id !== subscriptionId) return;
      const currentTarget =
        renderedItems.find(
          (
            item,
          ): item is SubscriptionCarouselSubscriptionItem =>
            item.kind === "subscription" &&
            item.subscription.id === subscriptionId,
        ) ?? target;

      const operationId = operationIdRef.current + 1;
      operationIdRef.current = operationId;
      const presentation: DeletionPresentation = {
        operationId,
        item: currentTarget,
        firstDevice:
          firstDeviceById?.[currentTarget.subscription.id] ?? null,
        visual: resolveSubscriptionCardVisual(
          branding,
          currentTarget.slotIndex,
        ),
        startedAtMs: monotonicNow(),
        serverStatus: "pending",
        serverSettledAtMs: null,
        reducedMotion: Boolean(prefersReducedMotion),
        nextActiveKey: selectCarouselItemAfterRemoval(
          renderedItems.map((item) => item.key),
          currentTarget.key,
          activeKey,
        ),
      };
      deletionRef.current = presentation;
      setDeletion(presentation);
      setHandoffItemKey(null);
    },
    [
      activeKey,
      branding,
      deleteTarget,
      firstDeviceById,
      prefersReducedMotion,
      renderedItems,
    ],
  );

  const commitSubscriptionDeletion = useCallback(
    (subscriptionId: string) => {
      const current = deletionRef.current;
      if (current?.item.subscription.id === subscriptionId) {
        const committed: DeletionPresentation = {
          ...current,
          serverStatus: "success",
          serverSettledAtMs: monotonicNow() - current.startedAtMs,
        };
        deletionRef.current = committed;
        setDeletion(committed);
      }

      // Canonical data follows the server immediately. The protected visual
      // snapshot above is independent and remains mounted until its wipe ends.
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
      setDeleteTarget(null);

      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.detail,
      });
      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.actionPolicyRoot,
      });
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      // Eligibility answers `ALREADY_HAS_SUBSCRIPTION` while a subscription
      // exists and is cached for a minute. Without this the user lands on the
      // empty state right after deleting and the trial offer stays hidden — or,
      // the other way round, a stale `eligible: true` keeps offering a trial that
      // was already spent. That stale read is the likeliest cause of the reported
      // "offer shown after deleting the trial".
      void queryClient.invalidateQueries({
        queryKey: ["trial", "eligibility"],
      });
    },
    [queryClient],
  );

  const rejectSubscriptionDeletion = useCallback(
    (subscriptionId: string) => {
      const current = deletionRef.current;
      if (current?.item.subscription.id !== subscriptionId) return;
      const rejected: DeletionPresentation = {
        ...current,
        serverStatus: "error",
        serverSettledAtMs: monotonicNow() - current.startedAtMs,
      };
      deletionRef.current = rejected;
      setDeletion(rejected);
      void queryClient.invalidateQueries({
        queryKey: subscriptionQueryKeys.all,
      });
    },
    [queryClient],
  );

  const finishDeletionPresentation = useCallback(
    (operationId: number, nextActiveKey: string | null) => {
      if (deletionRef.current?.operationId !== operationId) return;
      deletionRef.current = null;
      setDeletion(null);
      setDeleteTarget(null);
      onDeleteGuardActiveChange?.(false);
      onActiveItemKeyChange(nextActiveKey);
      setHandoffItemKey(nextActiveKey);
    },
    [onActiveItemKeyChange, onDeleteGuardActiveChange],
  );

  const restoreDeletionPresentation = useCallback(
    (operationId: number) => {
      if (deletionRef.current?.operationId !== operationId) return;
      deletionRef.current = null;
      setDeletion(null);
      setDeleteTarget(null);
      onDeleteGuardActiveChange?.(false);
    },
    [onDeleteGuardActiveChange],
  );

  if (count === 0) return null;

  return (
    <div className="relative">
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className={cn(
          "carousel-track flex snap-x snap-mandatory",
          deletion !== null && "pointer-events-none",
        )}
        aria-busy={deletion?.serverStatus === "pending" ? true : undefined}
      >
        {renderedItems.map((item, index) => {
          const distanceFromActive = Math.abs(index - activeIndex);
          if (item.kind === "subscription") {
            const itemDeletion =
              deletion?.item.key === item.key ? deletion : null;
            const displayItem = itemDeletion?.item ?? item;
            return (
              <RealSubscriptionSlide
                key={item.key}
                item={displayItem}
                firstDevice={
                  itemDeletion?.firstDevice ??
                  firstDeviceById?.[displayItem.subscription.id] ??
                  null
                }
                effectActive={
                  index === activeIndex || itemDeletion !== null
                }
                effectWarm={
                  distanceFromActive > 0 &&
                  distanceFromActive <= CARD_EFFECT_WARM_RADIUS
                }
                visual={itemDeletion?.visual ?? null}
                deletion={itemDeletion}
                reducedMotion={
                  itemDeletion?.reducedMotion ??
                  Boolean(prefersReducedMotion)
                }
                holdingLabel={t("deleteSubscription.finishing")}
                successLabel={t("deleteSubscription.success")}
                handoff={handoffItemKey === item.key}
                onDeleteSuccessExitComplete={() => {
                  if (itemDeletion === null) return;
                  finishDeletionPresentation(
                    itemDeletion.operationId,
                    itemDeletion.nextActiveKey,
                  );
                }}
                onDeleteRestoreComplete={() => {
                  if (itemDeletion === null) return;
                  restoreDeletionPresentation(itemDeletion.operationId);
                }}
                onLongPress={
                  deletion === null && handoffItemKey === null
                    ? () => {
                        if (deleteTarget === null) {
                          setDeleteTarget({ item: displayItem });
                        }
                      }
                    : undefined
                }
              />
            );
          }

          return (
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
          );
        })}
      </div>

      {count > 1 && (
        <>
          {activeIndex > 0 && (
            <button
              onClick={() => goTo(activeIndex - 1)}
              disabled={deletion !== null}
              className="absolute top-1/2 left-2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[var(--radius-pill)] border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface-high)] text-[color:var(--brand-foreground)] shadow-sm backdrop-blur-sm transition-colors hover:bg-[color:var(--color-surface)] sm:flex"
              aria-label={t("subscription.previousCard")}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {activeIndex < count - 1 && (
            <button
              onClick={() => goTo(activeIndex + 1)}
              disabled={deletion !== null}
              className="absolute top-1/2 right-2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[var(--radius-pill)] border border-[color:var(--color-border-strong)] bg-[color:var(--color-surface-high)] text-[color:var(--brand-foreground)] shadow-sm backdrop-blur-sm transition-colors hover:bg-[color:var(--color-surface)] sm:flex"
              aria-label={t("subscription.nextCard")}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </>
      )}

      <SubscriptionCarouselPagination
        count={count}
        activeIndex={activeIndex}
        disabled={deletion !== null}
        onSelect={goTo}
        getLabel={(index) =>
          t("subscription.carouselItemAria", { index: index + 1 })
        }
      />

      <DeleteSubscriptionDialog
        subscription={deleteTarget?.item.subscription ?? null}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleteStarted={beginSubscriptionDeletion}
        onServerCommitted={commitSubscriptionDeletion}
        onServerRejected={rejectSubscriptionDeletion}
      />
    </div>
  );
}

function SlideShell({
  children,
  onLongPress,
  itemKey,
}: {
  readonly children: React.ReactNode;
  readonly onLongPress?: () => void;
  readonly itemKey?: string;
}) {
  const longPress = useLongPress(onLongPress ?? (() => undefined));
  return (
    <div
      className="relative w-full shrink-0 snap-center snap-always"
      data-carousel-item-key={itemKey}
      tabIndex={itemKey === undefined ? undefined : -1}
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
  effectWarm,
  visual,
  deletion,
  reducedMotion,
  holdingLabel,
  successLabel,
  handoff,
  onDeleteSuccessExitComplete,
  onDeleteRestoreComplete,
  onLongPress,
}: {
  readonly item: SubscriptionCarouselSubscriptionItem;
  readonly firstDevice: string | null;
  readonly effectActive: boolean;
  readonly effectWarm: boolean;
  readonly visual: ResolvedSubscriptionCardVisual | null;
  readonly deletion: DeletionPresentation | null;
  readonly reducedMotion: boolean;
  readonly holdingLabel: string;
  readonly successLabel: string;
  readonly handoff: boolean;
  readonly onDeleteSuccessExitComplete: () => void;
  readonly onDeleteRestoreComplete: () => void;
  readonly onLongPress?: () => void;
}) {
  return (
    <SlideShell itemKey={item.key} onLongPress={onLongPress}>
      <SubscriptionDeletionMotion
        active={deletion !== null}
        visual={visual}
        startedAtMs={deletion?.startedAtMs ?? 0}
        serverStatus={deletion?.serverStatus ?? "pending"}
        serverSettledAtMs={deletion?.serverSettledAtMs ?? null}
        reducedMotion={reducedMotion}
        holdingLabel={holdingLabel}
        successLabel={successLabel}
        handoff={handoff}
        onSuccessExitComplete={onDeleteSuccessExitComplete}
        onRestoreComplete={onDeleteRestoreComplete}
      >
        <SubscriptionCard
          subscription={item.subscription}
          index={item.slotIndex}
          firstDevice={firstDevice}
          effectActive={effectActive}
          effectWarm={effectWarm}
          visual={visual ?? undefined}
        />
      </SubscriptionDeletionMotion>
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
    <SlideShell itemKey={item.key}>
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

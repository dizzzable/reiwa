import {
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  getAllSubscriptions,
  getPaymentStatus,
} from "@/lib/api-client";
import {
  clearSubscriptionProvisioningReceipt,
  ensureSubscriptionProvisioningReceipt,
  isTrialSubscriptionProvisioningReceipt,
  listSubscriptionProvisioningReceipts,
  saveTrialSubscriptionProvisioningReceipt,
  type SubscriptionProvisioningReceipt,
} from "@/lib/subscription-provisioning-receipt";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import type { AllSubscriptionsResponse, PaymentStatus } from "@/types/api";

import {
  hasAllReadySubscriptionTargets,
  resolveTrialProvisioningPaymentStatus,
  type SubscriptionProvisioningRuntime,
} from "./subscription-lifecycle-policy";

const PAYMENT_POLL_INTERVAL_MS = 2_000;
const PROFILE_POLL_INTERVAL_MS = 1_000;
const READY_SUBSCRIPTION_REFRESH_MS = 1_000;

function provisioningPaymentQueryKey(paymentId: string) {
  return ["payments", paymentId, "subscription-provisioning"] as const;
}

export interface SubscriptionProvisioningState {
  readonly runtimes: readonly SubscriptionProvisioningRuntime[];
  readonly completeHandoff: (paymentId: string) => void;
  readonly startTrialProvisioning: (input: {
    readonly subscriptionId?: string;
    readonly knownSubscriptionIds: readonly string[];
    readonly slotIndex: number;
  }) => void;
}

/**
 * Polls the lightweight payment-status contract only while this tab owns a
 * provisioning receipt. The heavier subscription list is prefetched once at
 * PROFILE_PENDING, then retried at READY only until every exact Remnawave
 * profile is present in the canonical list.
 */
export function useSubscriptionProvisioning(): SubscriptionProvisioningState {
  const queryClient = useQueryClient();
  const [receipts, setReceipts] = useState<
    SubscriptionProvisioningReceipt[]
  >(() => listSubscriptionProvisioningReceipts());
  const profilePendingRefreshes = useRef(new Set<string>());
  const trialReceipts = useMemo(
    () =>
      receipts.filter(isTrialSubscriptionProvisioningReceipt),
    [receipts],
  );
  const trialReceiptSignature = trialReceipts
    .map(
      (receipt) =>
        [
          receipt.paymentId,
          receipt.subscriptionId ?? "",
          ...(receipt.knownSubscriptionIds ?? []),
        ].join(":"),
    )
    .join("|");

  const paymentQueries = useQueries({
    queries: receipts.map((receipt) => {
      const isTrial = isTrialSubscriptionProvisioningReceipt(receipt);
      return {
        queryKey: provisioningPaymentQueryKey(receipt.paymentId),
        queryFn: () => getPaymentStatus(receipt.paymentId),
        enabled: !isTrial,
        staleTime: 0,
        retry: 2,
        refetchInterval: isTrial
          ? false
          : (query: {
              state: { data: PaymentStatus | undefined };
            }) => {
              const status = query.state.data;
              if (status === undefined) {
                return receipt.phase === "PROVISIONING"
                  ? PROFILE_POLL_INTERVAL_MS
                  : PAYMENT_POLL_INTERVAL_MS;
              }
              if (
                status.status === "FAILED" ||
                status.status === "CANCELED" ||
                status.subscriptionProvisioningStatus === "READY" ||
                status.subscriptionProvisioningStatus === "FAILED" ||
                (status.status === "COMPLETED" &&
                  status.subscriptionProvisioningStatus === "NOT_APPLICABLE")
              ) {
                return false;
              }
              return receipt.phase === "PROVISIONING"
                ? PROFILE_POLL_INTERVAL_MS
                : PAYMENT_POLL_INTERVAL_MS;
            },
      };
    }),
  });

  const cachedSubscriptions =
    queryClient.getQueryData<AllSubscriptionsResponse>(
      subscriptionQueryKeys.all,
    )?.subscriptions ?? [];
  const statuses = paymentQueries.map(
    (query, index) => {
      const receipt = receipts[index];
      return (
        (receipt === undefined
          ? null
          : resolveTrialProvisioningPaymentStatus(
              receipt,
              cachedSubscriptions,
            )) ??
        (query.data as PaymentStatus | undefined) ??
        null
      );
    },
  );
  const statusSignature = statuses
    .map((status) =>
      status === null
        ? "pending"
        : [
            status.paymentId,
            status.status,
            status.subscriptionProvisioningStatus,
            status.subscriptionId ?? "",
            status.updatedAt,
          ].join(":"),
    )
    .join("|");
  const readySubscriptionIds = statuses.flatMap((status) =>
    status?.subscriptionProvisioningStatus === "READY" &&
    typeof status.subscriptionId === "string" &&
    status.subscriptionId.length > 0
      ? [status.subscriptionId]
      : [],
  );
  const readySubscriptionSignature = readySubscriptionIds.join("|");

  useEffect(() => {
    if (trialReceipts.length === 0) return;

    let cancelled = false;
    let retryTimer: number | undefined;

    const refreshUntilTrialProfilesArrive = async (): Promise<void> => {
      let allTargetsReady = false;
      try {
        const response = await queryClient.fetchQuery({
          queryKey: subscriptionQueryKeys.all,
          queryFn: getAllSubscriptions,
          staleTime: 0,
          retry: 2,
        });
        allTargetsReady = trialReceipts.every(
          (receipt) =>
            resolveTrialProvisioningPaymentStatus(
              receipt,
              response.subscriptions,
            )?.subscriptionProvisioningStatus === "READY",
        );
      } catch {
        // Retain the creation state across a transient BFF error. The next
        // bounded refresh retries the same exact local subscription IDs.
      }

      if (!cancelled && !allTargetsReady) {
        retryTimer = window.setTimeout(
          () => void refreshUntilTrialProfilesArrive(),
          PROFILE_POLL_INTERVAL_MS,
        );
      }
    };

    void refreshUntilTrialProfilesArrive();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [queryClient, trialReceiptSignature, trialReceipts]);

  useEffect(() => {
    const receiptsToRemove = new Set<string>();
    const receiptsToPromote = new Map<
      string,
      SubscriptionProvisioningReceipt
    >();

    receipts.forEach((receipt, index) => {
      const status = statuses[index];
      if (status === null) return;

      if (status.status === "FAILED" || status.status === "CANCELED") {
        receiptsToRemove.add(receipt.paymentId);
        clearSubscriptionProvisioningReceipt(receipt.paymentId);
        return;
      }

      if (
        status.status === "COMPLETED" &&
        status.subscriptionProvisioningStatus === "NOT_APPLICABLE" &&
        receipt.phase === "AWAITING_PAYMENT"
      ) {
        receiptsToRemove.add(receipt.paymentId);
        clearSubscriptionProvisioningReceipt(receipt.paymentId);
        return;
      }

      if (
        status.status === "COMPLETED" &&
        status.subscriptionProvisioningStatus !== "NOT_APPLICABLE" &&
        receipt.phase === "AWAITING_PAYMENT"
      ) {
        const promoted = ensureSubscriptionProvisioningReceipt({
          ...receipt,
          phase: "PROVISIONING",
          createdAt: receipt.createdAt,
        });
        if (promoted !== null) {
          receiptsToPromote.set(receipt.paymentId, promoted);
        }
      }

      if (
        status.subscriptionProvisioningStatus === "PROFILE_PENDING" &&
        !profilePendingRefreshes.current.has(receipt.paymentId)
      ) {
        profilePendingRefreshes.current.add(receipt.paymentId);
        void queryClient.fetchQuery({
          queryKey: subscriptionQueryKeys.all,
          queryFn: getAllSubscriptions,
          staleTime: 0,
          retry: 2,
        });
      }

    });

    if (receiptsToRemove.size === 0 && receiptsToPromote.size === 0) {
      return;
    }
    setReceipts((current) =>
      current
        .filter((receipt) => !receiptsToRemove.has(receipt.paymentId))
        .map(
          (receipt) =>
            receiptsToPromote.get(receipt.paymentId) ?? receipt,
        ),
    );
  }, [queryClient, receipts, statusSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (readySubscriptionIds.length === 0) return;

    let cancelled = false;
    let retryTimer: number | undefined;

    const refreshUntilExactProfilesArrive = async (): Promise<void> => {
      let allTargetsReady = false;
      try {
        const response = await queryClient.fetchQuery({
          queryKey: subscriptionQueryKeys.all,
          queryFn: getAllSubscriptions,
          staleTime: 0,
          retry: 2,
        });
        allTargetsReady = hasAllReadySubscriptionTargets(
          response.subscriptions,
          readySubscriptionIds,
        );
      } catch {
        // A transient edge/BFF failure must not strand a READY receipt. The
        // next bounded attempt reuses the same canonical query and exact IDs.
      }

      if (!cancelled && !allTargetsReady) {
        retryTimer = window.setTimeout(
          () => void refreshUntilExactProfilesArrive(),
          READY_SUBSCRIPTION_REFRESH_MS,
        );
      }
    };

    void refreshUntilExactProfilesArrive();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [queryClient, readySubscriptionSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  const completeHandoff = useCallback(
    (paymentId: string) => {
      clearSubscriptionProvisioningReceipt(paymentId);
      setReceipts((current) =>
        current.filter((receipt) => receipt.paymentId !== paymentId),
      );
      queryClient.removeQueries({
        queryKey: provisioningPaymentQueryKey(paymentId),
        exact: true,
      });
    },
    [queryClient],
  );

  const startTrialProvisioning = useCallback(
    ({
      subscriptionId,
      knownSubscriptionIds,
      slotIndex,
    }: {
      subscriptionId?: string;
      knownSubscriptionIds: readonly string[];
      slotIndex: number;
    }) => {
      const receipt = saveTrialSubscriptionProvisioningReceipt({
        subscriptionId,
        knownSubscriptionIds,
        slotIndex,
      });
      if (receipt === null) return;

      setReceipts((current) =>
        [
          ...current.filter((item) => item.paymentId !== receipt.paymentId),
          receipt,
        ].sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            left.paymentId.localeCompare(right.paymentId),
        ),
      );
    },
    [],
  );

  const runtimes = useMemo<SubscriptionProvisioningRuntime[]>(
    () =>
      receipts.flatMap((receipt, index) =>
        receipt.phase === "PROVISIONING"
          ? [
              {
                receipt,
                paymentStatus: statuses[index] ?? null,
              },
            ]
          : [],
      ),
    [receipts, statusSignature], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return { runtimes, completeHandoff, startTrialProvisioning };
}

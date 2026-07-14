export type PaymentResultInput = {
  readonly status: "PENDING" | "COMPLETED" | "CANCELED" | "REFUNDED" | "FAILED";
  readonly checkoutUrl: string | null;
  readonly errorCode?: string | null;
};

export type PaymentResult = "processing" | "success" | "failed" | "unresolved";

/** Provider URL is optional: status is authoritative once the payment exists. */
export function resolvePaymentResult(input: PaymentResultInput): PaymentResult {
  if (input.errorCode === "PROVIDER_CHECKOUT_CREATION_UNRESOLVED") return "unresolved";
  if (input.status === "COMPLETED") return "success";
  if (input.status === "FAILED" || input.status === "CANCELED" || input.status === "REFUNDED") {
    return "failed";
  }
  return "processing";
}

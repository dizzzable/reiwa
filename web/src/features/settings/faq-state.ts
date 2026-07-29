import type { TFunction } from "i18next";

import type { FaqItem } from "@/lib/api-client";

export interface FaqViewState {
  readonly items: FaqItem[];
  readonly showLoadError: boolean;
}

/**
 * Keep the FAQ page explicit about upstream failures: users may still see the
 * built-in fallback answers, but the cabinet must not silently pretend the
 * operator-managed FAQ loaded successfully.
 */
export function resolveFaqViewState(
  items: FaqItem[] | undefined,
  isError: boolean,
  t: TFunction,
): FaqViewState {
  return {
    items: items && items.length > 0 ? items : getDefaultFaq(t),
    showLoadError: isError,
  };
}

function getDefaultFaq(t: TFunction): FaqItem[] {
  return [
    { id: "1", question: t("faq.q1"), answer: t("faq.a1") },
    { id: "2", question: t("faq.q2"), answer: t("faq.a2") },
    { id: "3", question: t("faq.q3"), answer: t("faq.a3") },
    { id: "4", question: t("faq.q4"), answer: t("faq.a4") },
  ];
}

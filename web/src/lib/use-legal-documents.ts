/**
 * useLegalDocuments
 * ─────────────────
 * The agreement / offer the operator switched on, in the cabinet's language.
 *
 * Shared query key so the registration screen and the privacy page dedupe onto
 * one request. Unlike `useAccessMode` this does NOT cache for a minute and does
 * NOT fail open, and both differences are deliberate:
 *
 *  - `staleTime: 0` mirrors the server's `Cache-Control: no-store`. An
 *    operator's edit to a legal text has to be the text the next visitor
 *    actually agrees to; a minute of staleness is a minute of people accepting
 *    a wording that no longer exists.
 *  - On error the list is EMPTY but `failed` is true. Callers must not read an
 *    empty list as "nothing is required": the panel would then refuse the
 *    registration for consent the form never asked for, and the visitor would
 *    see a rejection with no explanation. The registration form uses `failed`
 *    to say so instead.
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { getLegalDocuments, type LegalDocument } from "@/lib/api-client";

export interface LegalDocumentsState {
  readonly documents: readonly LegalDocument[];
  readonly isLoading: boolean;
  /** The request errored — the list is empty because we do not know, not because there is nothing. */
  readonly failed: boolean;
  /** Try again. `retry: 1` gives up quickly and nothing refetches on focus, so
   *  without an explicit retry a visitor's only recourse is reloading. */
  readonly retry: () => void;
}

export function useLegalDocuments(): LegalDocumentsState {
  const { i18n } = useTranslation();
  const locale = i18n.language?.startsWith("ru") ? "ru" : "en";

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["legal-documents", locale],
    queryFn: () => getLegalDocuments(locale),
    staleTime: 0,
    refetchOnMount: "always",
    retry: 1,
    refetchOnWindowFocus: false,
  });

  return {
    documents: data ?? [],
    isLoading,
    failed: isError,
    retry: () => {
      void refetch();
    },
  };
}

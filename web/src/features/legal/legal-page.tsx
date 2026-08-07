/**
 * Public reader for the operator's legal documents.
 *
 * Deliberately reachable WITHOUT a session. Three places need it and none of
 * them can assume an account exists:
 *   - the sign-up form, where someone is deciding whether to create one;
 *   - the bot's rules screen, whose only way to show a long text is a link;
 *   - the cabinet's privacy page, for reading afterwards.
 *
 * Bodies render as text (`whitespace-pre-wrap`), never as markup — this page
 * ships in the pre-login bundle, which keeps a sanitizer out on purpose.
 */
import { useTranslation } from "react-i18next";

import { BackButton } from "@/components/ui/back-button";
import { useLegalDocuments } from "@/lib/use-legal-documents";

export default function LegalPage() {
  const { t } = useTranslation();
  const { documents, isLoading, failed } = useLegalDocuments();

  return (
    <div className="min-h-full pb-10">
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/welcome" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("privacy.legalDocuments")}</h1>
      </div>

      <div className="mx-5 space-y-6">
        {isLoading && <p className="text-sm text-(--tg-hint)">{t("common.loading")}</p>}

        {failed && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-400">
            {t("register.legal.unavailable")}
          </p>
        )}

        {!isLoading && !failed && documents.length === 0 && (
          <p className="text-sm text-(--tg-hint)">{t("privacy.legalDocumentsEmpty")}</p>
        )}

        {documents.map((document) => (
          <section key={document.key} className="space-y-2">
            <h2 className="text-base font-semibold">{document.title}</h2>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-(--tg-hint)">
              {document.body}
            </p>
          </section>
        ))}
      </div>
    </div>
  );
}

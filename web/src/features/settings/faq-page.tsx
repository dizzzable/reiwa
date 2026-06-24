/**
 * FaqPage
 * ───────
 * Frequently asked questions — accordion-style collapsible items.
 * Content is fetched from rezeis-admin via internal API.
 * Fallback: hardcoded FAQ items when API is unavailable.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";

import { Skeleton } from "@/components/ui/skeleton";
import { BackButton } from "@/components/ui/back-button";
import { getFaq, type FaqItem } from "@/lib/api-client";

export default function FaqPage() {
  const { t, i18n } = useTranslation();

  const { data: items, isLoading } = useQuery({
    queryKey: ["faq", i18n.language],
    queryFn: () => getFaq(i18n.language),
    staleTime: 5 * 60_000,
  });

  const faqItems = items && items.length > 0 ? items : getDefaultFaq(t);

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("settings.faq")}</h1>
      </div>

      <div className="mx-5 space-y-2">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-2xl" />
          ))
        ) : (
          faqItems.map((item) => (
            <FaqAccordionItem key={item.id} item={item} />
          ))
        )}
      </div>
    </div>
  );
}

function FaqAccordionItem({ item }: { item: FaqItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border border-white/6 bg-white/2 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-white/3"
      >
        <span className="text-sm font-medium text-zinc-200 pr-4">{item.question}</span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="shrink-0"
        >
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        </motion.span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 text-sm text-zinc-400 leading-relaxed">
              {item.answer}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function getDefaultFaq(t: (key: string) => string): FaqItem[] {
  return [
    { id: "1", question: t("faq.q1"), answer: t("faq.a1") },
    { id: "2", question: t("faq.q2"), answer: t("faq.a2") },
    { id: "3", question: t("faq.q3"), answer: t("faq.a3") },
    { id: "4", question: t("faq.q4"), answer: t("faq.a4") },
  ];
}

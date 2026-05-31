/**
 * StatRow
 * ───────
 * Full-width horizontal stat row: icon (left) → label + sublabel → value +
 * chevron (right). Replaces the cramped vertical StatCard grid so each metric
 * gets its own line and never clips its text.
 */

import { motion } from "motion/react";
import { ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface StatRowProps {
  icon: LucideIcon;
  iconColor?: string;
  value?: string | number;
  label: string;
  sublabel?: string;
  onClick?: () => void;
  className?: string;
}

export function StatRow({
  icon: Icon,
  iconColor = "var(--brand-primary)",
  value,
  label,
  sublabel,
  onClick,
  className,
}: StatRowProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/3 p-3.5 text-left transition-colors hover:bg-white/6",
        className,
      )}
    >
      {/* Icon */}
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        style={{ backgroundColor: `color-mix(in oklab, ${iconColor} 15%, transparent)` }}
      >
        <Icon className="h-5 w-5" style={{ color: iconColor }} />
      </div>

      {/* Label + sublabel */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">{label}</p>
        {sublabel && <p className="truncate text-xs text-zinc-500">{sublabel}</p>}
      </div>

      {/* Value */}
      {value !== undefined && value !== "" && (
        <p className="shrink-0 text-lg font-bold text-white tabular-nums">{value}</p>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
    </motion.button>
  );
}

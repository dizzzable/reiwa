/**
 * StatCard
 * ────────
 * Tappable card showing a single stat value with icon and label.
 * Used in the 3-column (referral) or 4-column (partner) grid.
 * Matches the design reference (dark glass card, icon top-left, value large).
 */

import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface StatCardProps {
  icon: LucideIcon;
  iconColor?: string;
  value: string | number;
  label: string;
  sublabel?: string;
  onClick?: () => void;
  className?: string;
}

export function StatCard({
  icon: Icon,
  iconColor = "var(--brand-primary)",
  value,
  label,
  sublabel,
  onClick,
  className,
}: StatCardProps) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-2 rounded-2xl border border-white/6 bg-white/3 p-3.5 text-left transition-colors hover:bg-white/6",
        className,
      )}
    >
      <div
        className="flex h-8 w-8 items-center justify-center rounded-lg"
        style={{ backgroundColor: `color-mix(in oklab, ${iconColor} 15%, transparent)` }}
      >
        <Icon className="h-4 w-4" style={{ color: iconColor }} />
      </div>
      <div>
        <p className="text-lg font-bold text-white">{value}</p>
        <p className="text-[11px] text-zinc-400 leading-tight">{label}</p>
        {sublabel && (
          <p className="text-[10px] text-zinc-500 leading-tight">{sublabel}</p>
        )}
      </div>
    </motion.button>
  );
}

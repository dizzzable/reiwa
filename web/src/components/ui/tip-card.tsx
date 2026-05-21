import { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type TipTone = 'info' | 'success' | 'warning' | 'danger'

interface TipCardProps {
  tone?: TipTone
  icon?: ReactNode
  children: ReactNode
  className?: string
}

const toneClasses: Record<TipTone, string> = {
  info:    'border-l-blue-500/60    bg-blue-500/10    text-blue-300',
  success: 'border-l-emerald-500/60 bg-emerald-500/10 text-emerald-300',
  warning: 'border-l-amber-500/60   bg-amber-500/10   text-amber-300',
  danger:  'border-l-rose-500/60    bg-rose-500/10    text-rose-300',
}

export function TipCard({ tone = 'info', icon, children, className }: TipCardProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border-l-4 p-4 text-sm leading-relaxed',
        toneClasses[tone],
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div>{children}</div>
    </div>
  )
}

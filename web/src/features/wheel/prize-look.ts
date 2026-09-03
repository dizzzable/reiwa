/**
 * How a prize looks: its colour and its glyph.
 *
 * Shared by the disc and by the screen that announces what was won, so a
 * sector cannot be one thing on the wheel and another the instant it stops.
 *
 * RARITY IS A LOOK, NEVER A PROBABILITY. The operator picks it the way they
 * pick a colour; a "legendary" sector may be the likeliest on the wheel. The
 * odds are never shown to anybody here, and nothing in this file is derived
 * from a weight.
 */
import {
  CalendarPlus,
  Clover,
  Coins,
  Gauge,
  Gem,
  Gift,
  KeyRound,
  Percent,
  Sparkles,
  Ticket,
  TicketPercent,
  type LucideIcon,
} from 'lucide-react'

import type { WheelRarity, WheelSectorKind } from '@/lib/api-client'

export interface RarityLook {
  /** Slice gradient, top to bottom. */
  readonly from: string
  readonly to: string
  /** The hairline between slices. */
  readonly edge: string
  /** The accent: glyphs, light, confetti. */
  readonly glow: string
}

export const RARITY_LOOK: Readonly<Record<WheelRarity, RarityLook>> = {
  COMMON: { from: '#3f4c60', to: '#28313f', edge: 'rgba(255,255,255,0.10)', glow: '#cbd5e1' },
  RARE: { from: '#12608f', to: '#0b3a5b', edge: 'rgba(125,211,252,0.35)', glow: '#38bdf8' },
  EPIC: { from: '#6b2fbe', to: '#3d1a72', edge: 'rgba(196,181,253,0.40)', glow: '#a78bfa' },
  LEGENDARY: { from: '#c07709', to: '#7a3f05', edge: 'rgba(253,224,71,0.45)', glow: '#fbbf24' },
}

export function lookOf(rarity: WheelRarity | undefined): RarityLook {
  return (rarity !== undefined ? RARITY_LOOK[rarity] : undefined) ?? RARITY_LOOK.COMMON
}

/** A glyph per kind, so a slice is readable at a glance and at speed. */
const KIND_ICON: Readonly<Record<WheelSectorKind, LucideIcon>> = {
  NOTHING: Clover,
  POINTS: Coins,
  SPINS: Ticket,
  DAYS: CalendarPlus,
  TRAFFIC: Gauge,
  DISCOUNT: Percent,
  PROMOCODE: TicketPercent,
  KEY: KeyRound,
  MANUAL: Gift,
}

/** Operator-chosen preset names — the vocabulary the quest icons already use. */
const PRESET_ICON: Readonly<Record<string, LucideIcon>> = {
  gift: Gift,
  gem: Gem,
  sparkles: Sparkles,
  coins: Coins,
  ticket: Ticket,
  key: KeyRound,
  percent: Percent,
  clover: Clover,
  calendar: CalendarPlus,
  traffic: Gauge,
}

/**
 * The glyph for a sector: the operator's preset when they chose one, the
 * glyph for its kind otherwise. Uploaded SVGs are deliberately not fetched
 * here — a slice is 18 pixels across and turning at speed, and a missing
 * image would leave a hole in the wheel.
 */
export function iconFor(input: {
  readonly kind: WheelSectorKind
  readonly iconKind?: string
  readonly iconRef?: string
}): LucideIcon {
  const preset =
    input.iconKind === 'PRESET' && input.iconRef !== undefined
      ? PRESET_ICON[input.iconRef]
      : undefined
  return preset ?? KIND_ICON[input.kind] ?? Sparkles
}

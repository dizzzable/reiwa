/**
 * Bot message builder.
 *
 * Builds the per-subscription mini-profile summary appended to the bot's
 * greeting on `/start` and the `menu:main` callback. Every user-facing
 * string flows through `TranslatorPort.t(...)` — there are no hardcoded
 * literals in this module, so operators can edit copy via the admin
 * `BotText` editor without redeploying.
 */
import type {
  BotEmojiMap,
  Subscription,
  TgCustomEmojiEntity,
} from "../bot-config/types.js";
import {
  joinLines,
  lineWithEmoji,
  resolvePlaceholders,
  resolveUnicode,
  applyCustomEmojiTokens,
} from "../bot-config/emoji-utils.js";
import type { TranslatorPort } from "../../application/ports/translator.port.js";
import type { SupportedLocale } from "../../core/enums/locale.enum.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSummaryParams {
  firstName: string;
  subscriptions: readonly Subscription[];
  welcomeTemplate: string;
  botEmojis?: BotEmojiMap | null;
  /**
   * Operator custom-emoji library (`:slug:` → id/fallback). When present,
   * `:slug:` tokens in the welcome copy render as the fallback glyph plus a
   * premium custom-emoji entity (when an id is configured).
   */
  customEmojis?: Record<string, { id: string | null; fallback: string | null }> | null;
  translator: TranslatorPort;
  lang: SupportedLocale;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TRAFFIC_BAR_SEGMENTS = 14;

/**
 * Format an ISO date in the user's locale (DD.MM.YYYY for ru, MM/DD/YYYY
 * for en) with a translator-driven "not available" fallback. Locale list
 * is intentionally narrow — only the locales the bot actually ships with.
 */
function formatDate(
  iso: string | undefined | null,
  translator: TranslatorPort,
  lang: SupportedLocale,
): string {
  if (!iso) return translator.t("common.not_available", lang);
  try {
    const intlLocale = lang === "en" ? "en-US" : "ru-RU";
    return new Date(iso).toLocaleDateString(intlLocale);
  } catch {
    return iso;
  }
}

/** Format a GB amount with two decimals, e.g. 0 → "0.00". */
function formatGb(gb: number): string {
  return (Number.isFinite(gb) ? gb : 0).toFixed(2);
}

/**
 * Build the per-subscription traffic line:
 *   "📈 Трафик — 🟢 ░░░░░░░░░░░░░░ 0% (0.00 / 10.00 GB)"
 * The leading 📈 is a (premium-capable) entity; the activity dot (🟢/🟠/🔴)
 * is plain unicode reflecting how close usage is to the plan limit.
 */
function buildTrafficLine(
  sub: Subscription,
  botEmojis: BotEmojiMap | null | undefined,
  translator: TranslatorPort,
  lang: SupportedLocale,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const label = translator.t("profile.traffic", lang);
  const limit = sub.trafficLimit;

  // Unlimited plan — no meaningful bar, just mark it unlimited.
  if (limit == null) {
    const okDot = resolveUnicode("TRAFFIC_OK", botEmojis);
    return lineWithEmoji(
      "SUB_TRAFFIC",
      `${label} — ${okDot} ${translator.t("profile.unlimited", lang)}`,
      botEmojis,
    );
  }

  const used = Math.max(0, sub.trafficUsed ?? 0);
  const ratio = limit > 0 ? used / limit : 0;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const filled = Math.min(
    TRAFFIC_BAR_SEGMENTS,
    Math.max(0, Math.round((pct / 100) * TRAFFIC_BAR_SEGMENTS)),
  );
  const bar = "█".repeat(filled) + "░".repeat(TRAFFIC_BAR_SEGMENTS - filled);

  const activityKey =
    pct >= 100 || sub.status === "LIMITED"
      ? "TRAFFIC_FULL"
      : pct >= 80
        ? "TRAFFIC_WARN"
        : "TRAFFIC_OK";
  const dot = resolveUnicode(activityKey, botEmojis);

  const text = `${label} — ${dot} ${bar} ${Math.round(pct)}% (${formatGb(used)} / ${formatGb(limit)} GB)`;
  return lineWithEmoji("SUB_TRAFFIC", text, botEmojis);
}

// ── buildProfileSummary ───────────────────────────────────────────────────────

/**
 * Greeting + a compact per-subscription mini-profile, one block per
 * subscription the user owns:
 *
 *   👤 <profile name>
 *   📱 Устройств: 1 доступно
 *   📈 Трафик — 🟢 ░░░░░░░░░░░░░░ 0% (0.00 / 10.00 GB)
 *   📅 До: 31.12.2026
 *
 * The four leading icons render as Telegram Premium custom emoji when the
 * bot owner has Premium (baked-in ids, operator-overridable), degrading to
 * unicode otherwise. Falls back to the welcome text alone when the user has
 * no subscriptions. Every label is operator-editable through the admin
 * `BotText` keys (`profile.*`, `common.not_available`).
 */
export function buildProfileSummary(params: ProfileSummaryParams): {
  text: string;
  entities: TgCustomEmojiEntity[];
} {
  const { firstName, subscriptions, welcomeTemplate, botEmojis, customEmojis, translator, lang } =
    params;

  const withName = welcomeTemplate.replace(/\{\{firstName\}\}/g, firstName);
  const welcomePart = resolvePlaceholders(withName, botEmojis, 0);

  const visible = subscriptions.filter((s) => s.status !== "DELETED");
  if (visible.length === 0) {
    return applyCustomEmojiTokens(welcomePart.text, welcomePart.entities, customEmojis);
  }

  const lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }> = [
    { text: welcomePart.text, entities: welcomePart.entities },
  ];

  for (const sub of visible) {
    lines.push({ text: "", entities: [] }); // blank separator before each block

    const profileName =
      sub.profileName?.trim() ||
      sub.plan?.name ||
      translator.t("profile.subscription", lang);
    lines.push(lineWithEmoji("SUB_PROFILE", profileName, botEmojis));

    const devicesText =
      sub.deviceLimit != null
        ? translator.t("profile.devices", lang, { count: sub.deviceLimit })
        : translator.t("profile.devices_unlimited", lang);
    lines.push(lineWithEmoji("SUB_DEVICES", devicesText, botEmojis));

    lines.push(buildTrafficLine(sub, botEmojis, translator, lang));

    const until = formatDate(sub.expiresAt ?? sub.expireAt, translator, lang);
    lines.push(
      lineWithEmoji(
        "SUB_EXPIRY",
        `${translator.t("profile.until", lang)}: ${until}`,
        botEmojis,
      ),
    );
  }

  const joined = joinLines(lines);
  return applyCustomEmojiTokens(joined.text, joined.entities, customEmojis);
}

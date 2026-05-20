import type {
  BotEmojiMap,
  TgCustomEmojiEntity,
  Subscription,
  Plan,
} from "./types.js";
import {
  lineWithEmoji,
  joinLines,
  resolvePlaceholders,
  resolveUnicode,
  utf16Length,
} from "./emoji-utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WelcomeMessageParams {
  firstName: string;
  subscription?: Subscription | null;
  welcomeTemplate: string;
  format: "full" | "compact" | "minimal";
  botEmojis?: BotEmojiMap | null;
}

export interface SubscriptionCardParams {
  subscription: Subscription;
  botEmojis?: BotEmojiMap | null;
}

export interface PlansMessageParams {
  plans: Plan[];
  botEmojis?: BotEmojiMap | null;
}

export interface ReferralMessageParams {
  totalReferrals: number;
  qualifiedReferrals: number;
  inviteLink: string;
  botEmojis?: BotEmojiMap | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusEmojiKey(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "STATUS_ACTIVE";
    case "EXPIRED":
      return "STATUS_EXPIRED";
    case "DISABLED":
      return "STATUS_DISABLED";
    case "LIMITED":
      return "STATUS_LIMITED";
    case "DELETED":
      return "STATUS_DISABLED";
    default:
      return "STATUS_DISABLED";
  }
}

/** Format an ISO date string as DD.MM.YYYY in Russian locale */
function formatDate(iso: string | undefined | null): string {
  if (!iso) return "Н/Д";
  try {
    return new Date(iso).toLocaleDateString("ru-RU");
  } catch {
    return iso;
  }
}

/** Format traffic limit */
function formatTraffic(gb: number | null | undefined): string {
  return gb != null ? `${gb} GB` : "Безлимит";
}

/** Format device limit */
function formatDevices(n: number | null | undefined): string {
  return n != null ? String(n) : "Безлимит";
}

// ── buildWelcomeMessage ───────────────────────────────────────────────────────

export function buildWelcomeMessage(params: WelcomeMessageParams): {
  text: string;
  entities: TgCustomEmojiEntity[];
} {
  const { firstName, subscription, welcomeTemplate, format, botEmojis } =
    params;

  // Substitute {{firstName}} before resolving emoji placeholders
  const withName = welcomeTemplate.replace(/\{\{firstName\}\}/g, firstName);

  // Resolve emoji placeholders ({{KEY}}) in the welcome template
  const welcomePart = resolvePlaceholders(withName, botEmojis, 0);

  if (!subscription || format === "minimal") {
    return welcomePart;
  }

  // Append subscription summary below the welcome text
  const lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }> = [
    { text: welcomePart.text, entities: welcomePart.entities },
    { text: "", entities: [] }, // blank line separator
  ];

  const emojiKey = statusEmojiKey(subscription.status);
  const statusUnicode = resolveUnicode(emojiKey, botEmojis);
  const statusLine = lineWithEmoji(
    emojiKey,
    `Подписка: ${subscription.status}`,
    botEmojis,
  );
  lines.push(statusLine);

  if (format === "full") {
    lines.push({
      text: `📅 До: ${formatDate(subscription.expireAt)}`,
      entities: [],
    });
    lines.push({
      text: `📊 Трафик: ${formatTraffic(subscription.trafficLimit)}`,
      entities: [],
    });
    lines.push({
      text: `🖥 Устройства: ${formatDevices(subscription.deviceLimit)}`,
      entities: [],
    });
  }

  // Suppress unused variable warning
  void statusUnicode;

  return joinLines(lines);
}

// ── buildSubscriptionCard ─────────────────────────────────────────────────────

export function buildSubscriptionCard(params: SubscriptionCardParams): {
  text: string;
  entities: TgCustomEmojiEntity[];
} {
  const { subscription: sub, botEmojis } = params;

  const emojiKey = statusEmojiKey(sub.status);

  const lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }> = [];

  // Header: "EMOJI Подписка"
  const headerLine = lineWithEmoji("PACKAGE", "Подписка", botEmojis);
  lines.push(headerLine);
  lines.push({ text: "", entities: [] });

  // Status line
  lines.push(lineWithEmoji(emojiKey, `Статус: ${sub.status}`, botEmojis));

  // Plan name (if present)
  if (sub.plan?.name) {
    lines.push({ text: `📋 Тариф: ${sub.plan.name}`, entities: [] });
  }

  // Trial badge
  if (sub.isTrial) {
    lines.push(lineWithEmoji("TRIAL", "Пробный период", botEmojis));
  }

  // Expiry
  lines.push({
    text: `📅 Истекает: ${formatDate(sub.expireAt)}`,
    entities: [],
  });

  // Traffic
  lines.push(
    lineWithEmoji(
      "ACTIVITY",
      `Трафик: ${formatTraffic(sub.trafficLimit)}`,
      botEmojis,
    ),
  );

  // Devices
  lines.push(
    lineWithEmoji(
      "DEVICES",
      `Устройства: ${formatDevices(sub.deviceLimit)}`,
      botEmojis,
    ),
  );

  return joinLines(lines);
}

// ── buildPlansMessage ─────────────────────────────────────────────────────────

export function buildPlansMessage(params: PlansMessageParams): {
  text: string;
  entities: TgCustomEmojiEntity[];
} {
  const { plans, botEmojis } = params;

  const lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }> = [];

  // Header
  lines.push(lineWithEmoji("TARIFFS", "Доступные тарифы", botEmojis));
  lines.push({ text: "", entities: [] });

  for (const plan of plans) {
    // Plan name line
    lines.push(lineWithEmoji("PACKAGE", plan.name, botEmojis));

    // Traffic / devices
    lines.push({
      text: `  Трафик: ${formatTraffic(plan.trafficLimit)}  |  Устройств: ${formatDevices(plan.deviceLimit)}`,
      entities: [],
    });

    // Show first available price for each duration (if any)
    if (plan.durations?.length) {
      for (const dur of plan.durations) {
        const price = dur.prices?.[0];
        if (price) {
          lines.push({
            text: `  ${dur.days} дн. — ${price.price} ${price.currency}`,
            entities: [],
          });
        }
      }
    }

    lines.push({ text: "", entities: [] });
  }

  return joinLines(lines);
}

// ── buildReferralMessage ──────────────────────────────────────────────────────

export function buildReferralMessage(params: ReferralMessageParams): {
  text: string;
  entities: TgCustomEmojiEntity[];
} {
  const { totalReferrals, qualifiedReferrals, inviteLink, botEmojis } = params;

  const lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }> = [];

  // Header
  lines.push(lineWithEmoji("REFERRALS", "Реферальная программа", botEmojis));
  lines.push({ text: "", entities: [] });

  // Stats
  lines.push(
    lineWithEmoji("USERS", `Приглашено: ${totalReferrals}`, botEmojis),
  );
  lines.push(
    lineWithEmoji(
      "STATUS_ACTIVE",
      `Квалифицировано: ${qualifiedReferrals}`,
      botEmojis,
    ),
  );
  lines.push({ text: "", entities: [] });

  // Invite link (plain — links should not be inside custom_emoji entities)
  const linkLabel = "🔗 Ваша реферальная ссылка:";
  lines.push({ text: linkLabel, entities: [] });

  // Offset for the invite link text (after joining the lines above + '\n')
  const linkLine = { text: inviteLink, entities: [] };
  lines.push(linkLine);

  // Ensure the offset accounting is correct via joinLines
  const joined = joinLines(lines);

  // Find where inviteLink starts in the final text and add a text_link entity
  const linkOffset = utf16Length(joined.text) - utf16Length(inviteLink);
  const linkLength = utf16Length(inviteLink);

  // Add url entity so Telegram renders it as a tappable link
  const allEntities = [
    ...joined.entities,
    {
      type: "url" as const,
      offset: linkOffset,
      length: linkLength,
    },
  ];

  return { text: joined.text, entities: allEntities as TgCustomEmojiEntity[] };
}

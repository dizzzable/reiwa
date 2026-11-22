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
  lineWithEmojiAndDot,
  resolvePlaceholders,
  resolveUnicode,
  applyCustomEmojiTokens,
  stripCustomEmojiEntities,
  utf16Length,
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
  /** When false, `custom_emoji` entities are stripped (non-premium owner). */
  ownerHasPremium?: boolean;
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
 * `lineWithEmoji` for a line of operator copy: its `{{KEY}}` slots resolved
 * too, each with its entity.
 *
 * «Тексты бота» overrides every `profile.*` key, and its emoji picker writes
 * `{{KEY}}` slots into them. The `:slug:` pass at the end runs over the whole
 * message, but the slot pass ran over the welcome template only, so a slot in
 * a line reached the greeting as `{{GIFT}}`. The line's icon and its separator
 * lead the line, so every slot moves right by them and the icon's own entity
 * at 0 stays where it is.
 */
function copyLine(
  key: string,
  text: string,
  botEmojis: BotEmojiMap | null | undefined,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const slots = resolvePlaceholders(text, botEmojis, 0);
  const line = lineWithEmoji(key, slots.text, botEmojis);
  const shift = line.text.length - slots.text.length;
  return {
    text: line.text,
    entities: [...line.entities, ...slots.entities.map((e) => ({ ...e, offset: e.offset + shift }))],
  };
}

/**
 * `lineWithEmojiAndDot` for a line of operator copy. Same reason as
 * {@link copyLine}: every `profile.*` key is overridable in «Тексты бота», so
 * either side of the dot may carry `{{KEY}}` slots that have to be resolved
 * (each with its entity) before the line's own offsets are computed.
 *
 * The helper adds the slot glyph + separator before the copy and the dot glyph
 * between the two parts; both resolved sides shift by that prefix.
 */
function copyLineWithDot(
  emojiKey: string,
  dotKey: string,
  textBeforeDot: string,
  textAfterDot: string,
  botEmojis: BotEmojiMap | null | undefined,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const before = resolvePlaceholders(textBeforeDot, botEmojis, 0);
  const after = resolvePlaceholders(textAfterDot, botEmojis, 0);
  const line = lineWithEmojiAndDot(emojiKey, dotKey, before.text, after.text, botEmojis);

  // Where the second copy part starts in the finished line: everything after it
  // is unchanged, so the tail length locates it. The dot glyph (the slot's
  // unicode fallback — the same string the helper inserted) sits between the
  // two parts.
  const afterStart = utf16Length(line.text) - utf16Length(after.text);
  const beforeShift =
    afterStart - utf16Length(resolveUnicode(dotKey, botEmojis)) - utf16Length(before.text);

  return {
    text: line.text,
    entities: [
      ...line.entities,
      ...before.entities.map((e) => ({ ...e, offset: e.offset + beforeShift })),
      ...after.entities.map((e) => ({ ...e, offset: e.offset + afterStart })),
    ],
  };
}

/**
 * Build one traffic line:
 *   "📈 Трафик — 🟢 ░░░░░░░░░░░░░░ 0% (0.00 / 10.00 GB)"
 *
 * Both glyphs are premium-capable slots: the leading `SUB_TRAFFIC` /
 * `SUB_TRAFFIC_EXTRA` icon and the status dot (`TRAFFIC_OK` / `TRAFFIC_WARN` /
 * `TRAFFIC_FULL`, picked from how close usage is to the plan limit). The dot
 * used to be resolved through `resolveUnicode` only, so a premium emoji bound
 * to those three slots was silently dropped while the same setup on the
 * leading slot rendered — `copyLineWithDot` now emits an entity for each slot
 * that has a `tgEmojiId`. With no premium id the line is byte-identical to
 * before, and `stripCustomEmojiEntities` still degrades the whole message for
 * a non-premium owner.
 *
 * `label`/`emojiKey` are arguments because a merged subscription draws one line
 * per plan: the leading one is always an unlimited plan when the bundle has one
 * (labelled `profile.traffic`), and every limited plan after it gets its own
 * line under an operator-editable caption (`profile.traffic_extra`,
 * `profile.traffic_extra_2`, …; its own emoji slot `SUB_TRAFFIC_EXTRA`).
 */
function buildTrafficLine(
  sub: Subscription,
  label: string,
  emojiKey: string,
  botEmojis: BotEmojiMap | null | undefined,
  translator: TranslatorPort,
  lang: SupportedLocale,
): { text: string; entities: TgCustomEmojiEntity[] } {
  const limit = sub.trafficLimit;

  // Unlimited plan — no meaningful bar, just mark it unlimited.
  if (limit == null) {
    return copyLineWithDot(
      emojiKey,
      'TRAFFIC_OK',
      `${label} — `,
      ` ${translator.t("profile.unlimited", lang)}`,
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

  return copyLineWithDot(
    emojiKey,
    activityKey,
    `${label} — `,
    ` ${bar} ${Math.round(pct)}% (${formatGb(used)} / ${formatGb(limit)} GB)`,
    botEmojis,
  );
}

/**
 * One block of the mini-profile. A subscription on its own is a block of one; a
 * merged subscription (a plan bundle the customer holds two or more plans of) is
 * ONE block whose additional plans appear as extra traffic lines — the owner
 * does not want two full mini-profiles for what the app shows as one link.
 */
interface ProfileBlock {
  /** The plan whose name, devices and expiry the block shows. */
  readonly primary: Subscription;
  /** Every member of the block, in the order the customer's list has them. */
  readonly members: readonly Subscription[];
}

/** One block while it is being assembled. */
interface ProfileBlockDraft {
  primary: Subscription;
  readonly members: Subscription[];
}

/** The plan id as the merged-link payload spells it (a string). */
function planIdOf(subscription: Subscription): string | null {
  return subscription.plan?.id == null ? null : String(subscription.plan.id);
}

/**
 * Subscriptions → the blocks the greeting draws, in the order the customer's
 * list has them. Members of one bundle collapse into the block of the first one
 * seen; the block's primary is the plan the VPN app shows (`visiblePlanId`),
 * falling back to the first member when the payload does not name one — the same
 * rule the admin panel applies to a bundle.
 */
function groupSubscriptions(subscriptions: readonly Subscription[]): ProfileBlock[] {
  const blocks: ProfileBlockDraft[] = [];
  const blockByBundle = new Map<string, ProfileBlockDraft>();

  for (const subscription of subscriptions) {
    const bundleId = subscription.merge?.bundleId;
    if (bundleId === undefined) {
      blocks.push({ primary: subscription, members: [subscription] });
      continue;
    }
    const existing = blockByBundle.get(bundleId);
    if (existing === undefined) {
      const block = { primary: subscription, members: [subscription] };
      blockByBundle.set(bundleId, block);
      blocks.push(block);
      continue;
    }
    existing.members.push(subscription);
    // The visible plan leads the block wherever it appears in the list: its
    // name, devices and expiry are the ones on the VPN app's face.
    const visiblePlanId = subscription.merge?.visiblePlanId ?? existing.primary.merge?.visiblePlanId ?? null;
    if (
      visiblePlanId !== null &&
      planIdOf(subscription) === visiblePlanId &&
      planIdOf(existing.primary) !== visiblePlanId
    ) {
      existing.primary = subscription;
    }
  }

  return blocks;
}

/**
 * The traffic lines of one block: the plan that LEADS them and the plans that
 * follow under «Трафик доп.».
 *
 * The owner's rule (14.11.2026): if the bundle holds an unlimited plan, the
 * FIRST line is that plan — «Трафик — 🟢 Безлимит» — and every limited plan
 * follows it; «Трафик доп.» therefore never carries «Безлимит». A bundle
 * without an unlimited plan keeps the visible plan on the first line, and its
 * other limited plans follow.
 */
function trafficLinesOf(block: ProfileBlock): {
  lead: Subscription;
  extras: readonly Subscription[];
} {
  const lead = block.members.find((member) => member.trafficLimit === null) ?? block.primary;
  const extras = block.members.filter(
    (member) => member.id !== lead.id && member.trafficLimit !== null,
  );
  return { lead, extras };
}

/**
 * The caption of the n-th extra traffic line (0-based). The first line uses the
 * operator's `profile.traffic_extra`; each next plan gets its own caption — one
 * of the windows the operator adds with «+» in «Карта бота» →
 * `profile.traffic_extra_2`, `profile.traffic_extra_3`, … A window that was
 * never added (or was deleted) falls back to the first caption, so a bundle
 * with more plans than captions still reads.
 */
function extraTrafficLabel(
  translator: TranslatorPort,
  lang: SupportedLocale,
  index: number,
): string {
  const fallback = translator.t("profile.traffic_extra", lang);
  if (index === 0) return fallback;
  const key = `profile.traffic_extra_${index + 1}`;
  const label = translator.t(key, lang);
  return label === key ? fallback : label;
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
 * A subscription that is part of the operator's plan grouping (a bundle the
 * customer holds two or more plans of) shares its block with the others: the
 * merge link makes them one subscription to the VPN app, so the greeting shows
 * one profile line, the plan the app faces, and one traffic line per plan of
 * the bundle. An unlimited plan ALWAYS leads the traffic lines; the limited
 * ones follow under «Трафик доп.» — the first with the editable
 * `profile.traffic_extra` caption (the owner renames it to «Обходы»), each next
 * one with its own window added in «Карта бота» (`profile.traffic_extra_2`, …).
 *
 * The four leading icons render as Telegram Premium custom emoji when the
 * bot owner has Premium (baked-in ids, operator-overridable), degrading to
 * unicode otherwise; the traffic status dot is a premium-capable slot too
 * (`TRAFFIC_OK` / `TRAFFIC_WARN` / `TRAFFIC_FULL`), rendered as its own entity
 * in every traffic line. Falls back to the welcome text alone when the user has
 * no subscriptions. Every label is operator-editable through the admin
 * `BotText` keys (`profile.*`, `common.not_available`).
 */
export function buildProfileSummary(params: ProfileSummaryParams): {
  text: string;
  entities: TgCustomEmojiEntity[];
} {
  const { firstName, subscriptions, welcomeTemplate, botEmojis, customEmojis, ownerHasPremium, translator, lang } =
    params;

  // Non-premium owners can't send custom_emoji entities — strip them so the
  // message still delivers (fallback glyphs remain inline as text).
  const finalize = (r: { text: string; entities: TgCustomEmojiEntity[] }): { text: string; entities: TgCustomEmojiEntity[] } =>
    ownerHasPremium === false ? { text: r.text, entities: stripCustomEmojiEntities(r.entities) } : r;

  const withName = welcomeTemplate.replace(/\{\{firstName\}\}/g, firstName);
  const welcomePart = resolvePlaceholders(withName, botEmojis, 0);

  const visible = subscriptions.filter((s) => s.status !== "DELETED");
  if (visible.length === 0) {
    return finalize(applyCustomEmojiTokens(welcomePart.text, welcomePart.entities, customEmojis));
  }

  const lines: Array<{ text: string; entities: TgCustomEmojiEntity[] }> = [
    { text: welcomePart.text, entities: welcomePart.entities },
  ];

  for (const block of groupSubscriptions(visible)) {
    const primary = block.primary;
    lines.push({ text: "", entities: [] }); // blank separator before each block

    const profileName =
      primary.profileName?.trim() ||
      primary.plan?.name ||
      translator.t("profile.subscription", lang);
    lines.push(copyLine("SUB_PROFILE", profileName, botEmojis));

    // `deviceLimit <= 0` IS the unlimited subscription (`hwidDeviceLimit: 0` in
    // Remnawave), never "0 devices available": the owner's rule (14.11.2026) is
    // that a zero device limit is printed as «безлимит», not as a count.
    const devicesText =
      primary.deviceLimit != null && primary.deviceLimit > 0
        ? translator.t("profile.devices", lang, { count: primary.deviceLimit })
        : translator.t("profile.devices_unlimited", lang);
    lines.push(copyLine("SUB_DEVICES", devicesText, botEmojis));

    const { lead, extras } = trafficLinesOf(block);
    // An unlimited plan always leads the block (owner's rule, 14.11.2026) —
    // its line is «Трафик — 🟢 Безлимит», never a «Трафик доп.» line.
    lines.push(
      buildTrafficLine(
        lead,
        translator.t("profile.traffic", lang),
        "SUB_TRAFFIC",
        botEmojis,
        translator,
        lang,
      ),
    );
    // Every other limited plan of the same bundle: one traffic line each, under
    // its own caption. The operator sets that caption in the merged-tariff card
    // (`plan_bundle_members.traffic_label`, delivered as `merge.trafficLabel`);
    // a plan without one uses the «Трафик доп.» caption the bot map edits — and
    // so does every line of a bundle that predates per-plan captions.
    extras.forEach((extra, index) => {
      lines.push(
        buildTrafficLine(
          extra,
          extra.merge?.trafficLabel ?? extraTrafficLabel(translator, lang, index),
          "SUB_TRAFFIC_EXTRA",
          botEmojis,
          translator,
          lang,
        ),
      );
    });

    const until = formatDate(primary.expiresAt ?? primary.expireAt, translator, lang);
    lines.push(
      copyLine(
        "SUB_EXPIRY",
        `${translator.t("profile.until", lang)}: ${until}`,
        botEmojis,
      ),
    );
  }

  const joined = joinLines(lines);
  return finalize(applyCustomEmojiTokens(joined.text, joined.entities, customEmojis));
}

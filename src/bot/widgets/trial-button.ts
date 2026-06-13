/**
 * resolveTrialButton
 * ──────────────────
 * Pure builder for the primary "trial" button injected at the top of the bot
 * main keyboard for subscription-less users. Encapsulates the visibility +
 * styling rules from `.kiro/specs/web-cabinet-onboarding`:
 *
 *   - Property 5/10: shown iff the user has NO active subscription and a trial
 *     is offered (free-eligible OR a paid trial is configured). Hidden once a
 *     subscription is active.
 *   - Property 6: always `style: 'primary'`; carries the premium
 *     `icon_custom_emoji_id` when the operator configured a `TRIAL` custom
 *     emoji, otherwise degrades to a leading unicode glyph in the label.
 *   - Paid trials carry the plan price in the label.
 *
 * Returns `null` when the button must not render (active sub, no trial, or no
 * usable cabinet target). No network / grammy coupling — easy to unit-test.
 */
import type { BotEmojiMap } from '../../infrastructure/bot-config/types.js';
import { resolvePremiumId, resolveUnicode } from '../../infrastructure/bot-config/emoji-utils.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import type { TrialButtonSpec } from './main-keyboard.js';

export interface TrialEligibilityShape {
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface ResolveTrialButtonInputs {
  /** Whether the user currently has an active subscription. */
  readonly hasActiveSubscription: boolean;
  /** Trial eligibility probe result (`null` when the probe failed). */
  readonly eligibility: TrialEligibilityShape | null;
  /** Price label for a paid trial (e.g. "$2.00"); `null` when free/unknown. */
  readonly paidTrialPriceLabel: string | null;
  /** Mini App URL (preferred target). */
  readonly miniAppUrl: string | null;
  /** Magic-link cabinet URL (fallback target, already `?signin=` stamped). */
  readonly cabinetUrl: string | null;
  readonly botEmojis: BotEmojiMap | null | undefined;
  readonly translator: TranslatorPort;
  readonly lang: SupportedLocale;
}

/** Reason returned by the trial-eligibility probe for a configured paid trial. */
const PAID_TRIAL_REASON = 'TRIAL_REQUIRES_PAYMENT';

export function resolveTrialButton(inputs: ResolveTrialButtonInputs): TrialButtonSpec | null {
  // Suppression (Property 10): never show the trial button to a subscriber.
  if (inputs.hasActiveSubscription) return null;

  // No usable cabinet target → no point rendering a dead button.
  const hasMiniApp = typeof inputs.miniAppUrl === 'string' && inputs.miniAppUrl.length > 0;
  const hasUrl = typeof inputs.cabinetUrl === 'string' && inputs.cabinetUrl.length > 0;
  if (!hasMiniApp && !hasUrl) return null;

  const free = inputs.eligibility?.eligible === true;
  const paid = inputs.eligibility?.reason === PAID_TRIAL_REASON;
  // Any other reason (TRIAL_NOT_CONFIGURED / ALREADY_HAS_SUBSCRIPTION /
  // claim-not-allowed) or a failed probe → no offer.
  if (!free && !paid) return null;

  const baseLabel = paid
    ? inputs.translator.t('menu.btn_trial_paid', inputs.lang, {
        price: inputs.paidTrialPriceLabel ?? '',
      })
    : inputs.translator.t('menu.btn_trial_free', inputs.lang);

  const premiumId = resolvePremiumId('TRIAL', inputs.botEmojis);
  // Premium owners get the custom emoji as the button icon (no unicode prefix
  // to avoid a double glyph); everyone else gets a leading unicode glyph.
  const text = premiumId !== null ? baseLabel : `${resolveUnicode('TRIAL', inputs.botEmojis)} ${baseLabel}`;

  return {
    text,
    iconCustomEmojiId: premiumId,
    miniAppUrl: inputs.miniAppUrl,
    url: inputs.cabinetUrl,
  };
}

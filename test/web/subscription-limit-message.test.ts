/**
 * THE SENTENCE AT CAPACITY, and the catalogue it no longer hides.
 *
 *   - a cap of one says "while you have your current one", a larger cap says
 *     "all slots are taken", and a policy without the two numbers falls back
 *     to the plain line — never a "{{current}}" left in the text;
 *   - "have", not "is active": the panel counts an expired subscription too;
 *   - the Buy shortcut on the dashboard and «Выбрать план» on the subscription
 *     screen open «Тарифы» at capacity instead of refusing, and the subscription
 *     screen offers «Посмотреть тарифы» beside the notice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en } from '../../web/src/i18n/en';
import { ru } from '../../web/src/i18n/ru';
import { subscriptionLimitMessage } from '../../web/src/lib/subscription-limit';
import type { ActionPolicy } from '../../web/src/types/api';

/** Only the fields the sentence reads; the rest of a policy does not matter here. */
const policy = (fields: Partial<ActionPolicy>): ActionPolicy => fields as ActionPolicy;

function translator(dict: typeof ru) {
  return (key: string, opts?: Record<string, unknown>): string => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], dict);
    if (typeof value !== 'string') throw new Error(`missing ${key}`);
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name]));
  };
}

describe('subscriptionLimitMessage', () => {
  const t = translator(ru);

  it('a cap of one: 1/1 and "пока у вас есть текущая"', () => {
    expect(subscriptionLimitMessage(t, policy({ activeSubscriptionCount: 1, maxSubscriptions: 1 }))).toBe(
      'Лимит подписок 1/1: купить ещё одну подписку нельзя, пока у вас есть текущая.',
    );
  });

  it('a larger cap: all slots are taken', () => {
    expect(subscriptionLimitMessage(t, policy({ activeSubscriptionCount: 3, maxSubscriptions: 3 }))).toBe(
      'Лимит подписок 3/3: все места заняты, купить ещё одну подписку нельзя.',
    );
  });

  it('without the numbers, the plain line', () => {
    expect(subscriptionLimitMessage(t, policy({ limitReached: true }))).toBe(
      'Лимит подписок исчерпан: купить ещё одну подписку нельзя.',
    );
    expect(subscriptionLimitMessage(t, null)).toBe(ru.subscription.limitReached);
  });

  it('says "есть", never "действует" or "активн" — an expired subscription counts too', () => {
    for (const text of [ru.subscription.limitReached, ru.subscription.limitReachedOne, ru.subscription.limitReachedDetail]) {
      expect(text).not.toMatch(/действу|активн/i);
    }
  });

  it('English has the same three lines, with both numbers where Russian has them', () => {
    const tEn = translator(en);
    expect(subscriptionLimitMessage(tEn, policy({ activeSubscriptionCount: 1, maxSubscriptions: 1 }))).toContain('1/1');
    expect(subscriptionLimitMessage(tEn, policy({ activeSubscriptionCount: 2, maxSubscriptions: 2 }))).toContain('2/2');
    expect(en.subscription.viewPlans).toBe('View plans');
    expect(ru.subscription.viewPlans).toBe('Посмотреть тарифы');
  });
});

describe('the catalogue opens at capacity', () => {
  const read = (path: string) => readFileSync(join(__dirname, '../../web/src/features', path), 'utf8');

  it('the dashboard Buy shortcut navigates to /plans and no longer refuses', () => {
    const source = read('dashboard/dashboard-page.tsx');
    const handler = source.slice(source.indexOf('const handleBuy'), source.indexOf('};', source.indexOf('const handleBuy')));
    expect(handler).toContain('navigate("/plans")');
    expect(handler).not.toContain('buyLimitReached');
    expect(source).not.toContain('notifySubscriptionLimitReached');
  });

  it('the subscription screen opens /plans from «Выбрать план» and offers «Посмотреть тарифы» at capacity', () => {
    const source = read('subscription/subscription-page.tsx');
    expect(source).not.toContain('notifySubscriptionLimitReached');
    expect(source).toContain("t('subscription.viewPlans')");
  });
});

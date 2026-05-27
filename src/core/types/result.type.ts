/**
 * Result<T, E> — a discriminated union for control flow.
 *
 * Use this for *expected* failures (e.g. "user not found", "trial already
 * used"). Throw for *unexpected* failures (network died, DB exploded).
 * The split keeps happy-path code clean and makes failure modes
 * exhaustive at the type level.
 *
 * Example:
 *   const r = await activateTrial({ telegramId });
 *   if (!r.ok) {
 *     await ctx.reply(t(`error.${r.error.code}`, lang));
 *     return;
 *   }
 *   await ctx.reply(t('msg.trial.activated', lang, { id: r.value.subscriptionId }));
 */
export type Result<T, E = Error> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

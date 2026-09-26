/**
 * What the Mini App says when the panel refuses a blocked account's sign-in.
 *
 * The BFF answers `403 { code: 'USER_BLOCKED' }` for it now — from the panel's
 * code, or from an older panel's sentence (`test/api/telegram-bootstrap-blocked.test.ts`).
 * It used to reach this page as an unnamed 403, which reads «Не удалось войти.
 * Попробуйте позже или напишите в поддержку.» — and trying later never helps a
 * blocked account. Pinned with the real dictionaries.
 */
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import { resolveBootstrapError } from '../src/features/auth/bootstrap-error'
import { en } from '../src/i18n/en'
import { ru } from '../src/i18n/ru'

let ruT: TFunction
let enT: TFunction

beforeAll(async () => {
  const ruInstance = i18next.createInstance()
  await ruInstance.init({ lng: 'ru', resources: { ru: { translation: ru } }, interpolation: { escapeValue: false } })
  ruT = ruInstance.t.bind(ruInstance)
  const enInstance = i18next.createInstance()
  await enInstance.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
  enT = enInstance.t.bind(enInstance)
})

/** The page passes `t` as a plain key-to-text function. */
const ruText = (key: string): string => String(ruT(key))
const enText = (key: string): string => String(enT(key))

function refusal(status: number, data: unknown): unknown {
  return { response: { status, data } }
}

describe('resolveBootstrapError', () => {
  it('names a blocked account, in both languages', () => {
    const blocked = refusal(403, { code: 'USER_BLOCKED', message: 'This account is blocked' })

    expect(resolveBootstrapError(blocked, ruText)).toBe('Аккаунт заблокирован. Если это ошибка, напишите в поддержку.')
    expect(resolveBootstrapError(blocked, enText)).toBe('This account is blocked. If this is a mistake, contact support.')
  })

  it('keeps the generic refusal for a 403 without a known code', () => {
    expect(resolveBootstrapError(refusal(403, { message: 'Access denied' }), ruText)).toBe(
      'Не удалось войти. Попробуйте позже или напишите в поддержку.',
    )
  })

  it('keeps the access-mode answers as they were', () => {
    expect(resolveBootstrapError(refusal(403, { code: 'REGISTRATION_DISABLED' }), ruText)).toBe(
      'Регистрация временно отключена. Обратитесь в поддержку.',
    )
    expect(resolveBootstrapError(refusal(503, { code: 'SERVICE_RESTRICTED' }), ruText)).toBe(
      'Сервис временно недоступен. Попробуйте позже.',
    )
  })
})

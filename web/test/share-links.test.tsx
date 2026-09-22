// @vitest-environment jsdom

/**
 * «Рефералы» / «Партнёрка»: the links an account hands to a friend.
 *
 * Under «только по приглашениям» a sign-up is admitted ONLY through a
 * single-use invite token. The bot minted one; these pages handed out the
 * permanent code instead — a link that looked fine and was refused at the
 * friend's registration. Each case is one way to get it wrong again.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getReferralSummary: vi.fn(),
  createReferralInvite: vi.fn(),
}))
const branding = vi.hoisted(() => ({ botUsername: 'reiwa_bot' as string | null }))

vi.mock('@/lib/api-client', () => api)
vi.mock('@/hooks/use-session', () => ({ useSession: () => ({ session: { id: 'session-id-7' } }) }))
vi.mock('@/lib/branding-provider', () => ({ useBranding: () => ({ botUsername: branding.botUsername }) }))

const { useShareLinks } = await import('../src/features/referrals/use-share-links')

let seen: ReturnType<typeof useShareLinks> | null = null
function Probe() {
  seen = useShareLinks()
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ),
  )
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  api.getReferralSummary.mockReset()
  api.createReferralInvite.mockReset()
  branding.botUsername = 'reiwa_bot'
  seen = null
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

describe('the code a share link carries', () => {
  it('is the permanent code normally, and asks for no invite', async () => {
    api.getReferralSummary.mockResolvedValue({ referralCode: 'reiwa-id-1' })
    await mount()
    expect(seen).toEqual({
      state: 'ready',
      telegramLink: 'https://t.me/reiwa_bot?start=ref_reiwa-id-1',
      webLink: `${window.location.origin}/register?ref=reiwa-id-1`,
    })
    expect(api.createReferralInvite).not.toHaveBeenCalled()
  })

  it('is the single-use invite under «только по приглашениям» — in BOTH links', async () => {
    api.getReferralSummary.mockResolvedValue({ referralCode: 'reiwa-id-1', admissionRequiresInvite: true })
    api.createReferralInvite.mockResolvedValue({ invite: { token: 'tok-9' } })
    await mount()
    expect(seen).toEqual({
      state: 'ready',
      telegramLink: 'https://t.me/reiwa_bot?start=ref_tok-9',
      webLink: `${window.location.origin}/register?ref=tok-9`,
    })
  })

  it('reads the invite in the other shape the panel answers with too', async () => {
    api.getReferralSummary.mockResolvedValue({ admissionRequiresInvite: true })
    api.createReferralInvite.mockResolvedValue({ token: 'tok-10' })
    await mount()
    expect(seen).toMatchObject({ state: 'ready', telegramLink: 'https://t.me/reiwa_bot?start=ref_tok-10' })
  })

  it('hands out NO link when there is no invite to be had — never the permanent code', async () => {
    // ANTI-VACUITY: this is the exact fallback that was the defect.
    api.getReferralSummary.mockResolvedValue({ referralCode: 'reiwa-id-1', admissionRequiresInvite: true })
    api.createReferralInvite.mockResolvedValue({ error: 'INVITE_SLOT_LIMIT_REACHED' })
    await mount()
    expect(seen).toEqual({ state: 'unavailable' })
  })

  it('makes both links the website one without a bot username', async () => {
    branding.botUsername = null
    api.getReferralSummary.mockResolvedValue({ referralCode: 'reiwa-id-1' })
    await mount()
    expect(seen).toMatchObject({
      state: 'ready',
      telegramLink: `${window.location.origin}/register?ref=reiwa-id-1`,
      webLink: `${window.location.origin}/register?ref=reiwa-id-1`,
    })
  })
})

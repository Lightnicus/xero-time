import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(async () => undefined),
  headers: vi.fn(async () => new Headers()),
  rateLimitKey: vi.fn(() => 'project-item-rate-key'),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
  requireAppSession: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }))
vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/lib/member-app/session', () => ({ requireAppSession: mocks.requireAppSession }))
vi.mock('@/lib/projects/rate-recalculation', () => ({
  confirmProjectRateRecalculation: vi.fn(),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  rateLimitKey: mocks.rateLimitKey,
}))

import { updateProjectXeroItemAction } from '@/app/(frontend)/app/settings/projects/actions'

const ITEM_ID = '11111111-1111-4111-8111-111111111111'

const form = (values: Record<string, string>): FormData => {
  const result = new FormData()
  for (const [name, value] of Object.entries(values)) result.set(name, value)
  return result
}

const owner = {
  active: true,
  collection: 'users',
  id: 'owner-1',
  role: 'owner',
}

describe('project Xero item action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a missing item before issuing a protected write', async () => {
    const update = vi.fn()
    mocks.requireAppSession.mockResolvedValue({ payload: { update }, req: {}, user: owner })

    await expect(
      updateProjectXeroItemAction(
        { message: null },
        form({ projectID: 'project-1', xeroItemId: '' }),
      ),
    ).resolves.toMatchObject({
      fieldErrors: { xeroItemId: 'Choose a Xero invoice item.' },
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('uses a system-owned write and redirects to the project resolve anchor', async () => {
    const update = vi.fn(async () => ({ id: 'project-1' }))
    mocks.requireAppSession.mockResolvedValue({ payload: { update }, req: {}, user: owner })

    await expect(
      updateProjectXeroItemAction(
        { message: null },
        form({
          commercialChangeReason: 'Apply the approved Xero services item.',
          confirmUnbilledImpact: 'yes',
          projectID: 'project-1',
          xeroItemId: ITEM_ID,
        }),
      ),
    ).rejects.toThrow(
      'REDIRECT:/app/settings/projects?item=saved&itemProject=project-1#project-item-project-1',
    )

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'projects',
        data: {
          commercialChangeReason: 'Apply the approved Xero services item.',
          confirmUnbilledImpact: true,
          xeroItemId: ITEM_ID,
        },
        id: 'project-1',
        overrideAccess: true,
      }),
    )
    expect(mocks.enforceRateLimit).toHaveBeenCalledOnce()
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/settings/projects')
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/billing')
  })

  it('does not allow a member to invoke the protected project command', async () => {
    const update = vi.fn()
    mocks.requireAppSession.mockResolvedValue({
      payload: { update },
      req: {},
      user: { ...owner, role: 'member' },
    })

    await expect(
      updateProjectXeroItemAction(
        { message: null },
        form({ projectID: 'project-1', xeroItemId: ITEM_ID }),
      ),
    ).resolves.toEqual({
      message: 'Only an owner or administrator can change project invoice items.',
    })
    expect(update).not.toHaveBeenCalled()
  })
})

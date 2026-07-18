// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import {
  LOCAL_API_ELEVATION_CONTEXT,
  userLocalOptions,
  withElevatedLocalOptions,
} from '@/lib/payload/local-api'

describe('Payload Local API access wrappers', () => {
  it('defaults user-context operations to normal access enforcement', () => {
    const req = { context: {} } as never
    expect(userLocalOptions(req)).toEqual({ overrideAccess: false, req })
  })

  it('requires a reason, propagates the request, and restores context', async () => {
    const req = { context: { existing: true } } as never
    await expect(withElevatedLocalOptions(req, 'short', async () => undefined)).rejects.toThrow(
      'requires a reason',
    )
    const operation = vi.fn(async (options) => {
      expect(options).toEqual({ overrideAccess: true, req })
      expect((req as { context: Record<string, unknown> }).context).toMatchObject({
        [LOCAL_API_ELEVATION_CONTEXT]: 'Run a protected maintenance operation.',
        existing: true,
      })
      return 'done'
    })
    await expect(
      withElevatedLocalOptions(req, 'Run a protected maintenance operation.', operation),
    ).resolves.toBe('done')
    expect((req as { context: Record<string, unknown> }).context).toEqual({ existing: true })
  })
})

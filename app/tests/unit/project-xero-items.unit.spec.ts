import { describe, expect, it, vi } from 'vitest'

import { protectCommercialChanges, validateXeroItemMappingChange } from '@/collections/Projects'
import { activeSalesItemReference, buildProjectXeroItemOptions } from '@/lib/projects/xero-items'

import type { PayloadRequest } from 'payload'

const ITEM_ID = '11111111-1111-4111-8111-111111111111'

const itemReference = (overrides: Record<string, unknown> = {}) => ({
  code: 'Time-MixedCase',
  metadata: { isSold: true, isTrackedAsInventory: false },
  name: 'Professional time',
  resourceType: 'item',
  status: 'active',
  xeroId: ITEM_ID,
  ...overrides,
})

const requestWith = (reference: unknown = itemReference()) => {
  const find = vi.fn(async (args: { collection: string }) =>
    args.collection === 'xero-connections'
      ? { docs: [{ tenantId: 'tenant-1' }] }
      : { docs: reference ? [reference] : [] },
  )
  return {
    find,
    req: { context: {}, payload: { find } } as unknown as PayloadRequest,
  }
}

describe('project Xero item references', () => {
  it('offers only active sales items, preserves code case, and labels tracked inventory', () => {
    const options = buildProjectXeroItemOptions([
      itemReference(),
      itemReference({
        code: 'TRACKED',
        metadata: { isSold: true, isTrackedAsInventory: true },
        name: 'Tracked hours',
        xeroId: '22222222-2222-4222-8222-222222222222',
      }),
      itemReference({ status: 'unavailable', xeroId: 'unavailable' }),
      itemReference({ metadata: { isSold: false }, xeroId: 'not-sold' }),
      itemReference({ resourceType: 'account', xeroId: 'account' }),
    ])

    expect(options).toEqual([
      {
        code: 'Time-MixedCase',
        id: ITEM_ID,
        label: 'Time-MixedCase — Professional time',
        name: 'Professional time',
        tracked: false,
        value: ITEM_ID,
      },
      {
        code: 'TRACKED',
        id: '22222222-2222-4222-8222-222222222222',
        label: 'TRACKED — Tracked hours (tracked inventory)',
        name: 'Tracked hours',
        tracked: true,
        value: '22222222-2222-4222-8222-222222222222',
      },
    ])
    expect(activeSalesItemReference(itemReference())?.code).toBe('Time-MixedCase')
  })

  it('resolves an actual ItemID change and writes authoritative display snapshots', async () => {
    const { find, req } = requestWith()
    const result = await validateXeroItemMappingChange({
      data: { xeroItemId: ITEM_ID },
      operation: 'update',
      originalDoc: { id: 'project-1', xeroItemId: null },
      req,
    } as never)

    expect(result).toMatchObject({
      xeroItemCodeSnapshot: 'Time-MixedCase',
      xeroItemId: ITEM_ID,
      xeroItemNameSnapshot: 'Professional time',
    })
    expect(find).toHaveBeenCalledTimes(2)
  })

  it('does not revalidate an unchanged mapping and allows clearing while disconnected', async () => {
    const unchanged = requestWith(null)
    await expect(
      validateXeroItemMappingChange({
        data: { name: 'Renamed project', xeroItemId: ITEM_ID },
        operation: 'update',
        originalDoc: { id: 'project-1', xeroItemId: ITEM_ID },
        req: unchanged.req,
      } as never),
    ).resolves.toMatchObject({ name: 'Renamed project', xeroItemId: ITEM_ID })
    expect(unchanged.find).not.toHaveBeenCalled()

    const clearing = requestWith(null)
    const cleared = await validateXeroItemMappingChange({
      data: { xeroItemId: null },
      operation: 'update',
      originalDoc: { id: 'project-1', xeroItemId: ITEM_ID },
      req: clearing.req,
    } as never)
    expect(cleared).toMatchObject({
      xeroItemCodeSnapshot: null,
      xeroItemId: null,
      xeroItemNameSnapshot: null,
    })
    expect(clearing.find).not.toHaveBeenCalled()
  })

  it('rejects an item that is not an active sale item for the connected tenant', async () => {
    const { req } = requestWith(
      itemReference({ metadata: { isSold: false }, status: 'unavailable' }),
    )

    await expect(
      validateXeroItemMappingChange({
        data: { xeroItemId: ITEM_ID },
        operation: 'update',
        originalDoc: { id: 'project-1', xeroItemId: null },
        req,
      } as never),
    ).rejects.toMatchObject({
      data: {
        errors: [
          expect.objectContaining({
            message: expect.stringContaining('active sales item'),
            path: 'xeroItemId',
          }),
        ],
      },
    })
  })

  it('requires confirmation and a reason when an item change affects unbilled time', async () => {
    const find = vi.fn(async () => ({ docs: [{ id: 'entry-1' }] }))
    const req = { context: {}, payload: { find } } as unknown as PayloadRequest

    await expect(
      protectCommercialChanges({
        data: { xeroItemId: ITEM_ID },
        operation: 'update',
        originalDoc: { id: 'project-1', xeroItemId: null },
        req,
      } as never),
    ).rejects.toMatchObject({
      data: {
        errors: expect.arrayContaining([
          expect.objectContaining({ path: 'confirmUnbilledImpact' }),
          expect.objectContaining({ path: 'commercialChangeReason' }),
        ]),
      },
    })

    await expect(
      protectCommercialChanges({
        data: {
          commercialChangeReason: 'Map approved professional-services item.',
          confirmUnbilledImpact: true,
          xeroItemId: ITEM_ID,
        },
        operation: 'update',
        originalDoc: { id: 'project-1', xeroItemId: null },
        req,
      } as never),
    ).resolves.toMatchObject({ xeroItemId: ITEM_ID })
    expect(req.context).toMatchObject({
      auditReason: 'Map approved professional-services item.',
    })
  })
})

import { describe, expect, it } from 'vitest'

import {
  type ExportDetailDocument,
  exportDetailActionAvailability,
} from '@/lib/billing/export-detail'

const exportDocument = (overrides: Partial<ExportDetailDocument> = {}): ExportDetailDocument => ({
  lastErrorCode: null,
  releaseAction: null,
  remoteStatus: null,
  state: 'action-required',
  xeroInvoiceId: null,
  ...overrides,
})

describe('export detail action availability', () => {
  it.each(['owner', 'admin'] as const)('allows an %s to refresh a saved invoice', (role) => {
    expect(
      exportDetailActionAvailability(exportDocument({ xeroInvoiceId: 'invoice-1' }), role),
    ).toMatchObject({ canRefresh: true })
  })

  it('denies every recovery action to a biller', () => {
    expect(
      exportDetailActionAvailability(
        exportDocument({
          remoteStatus: 'DRAFT',
          state: 'succeeded',
          xeroInvoiceId: 'invoice-1',
        }),
        'biller',
      ),
    ).toEqual({
      canAuthorizeReplacement: false,
      canDeleteDraft: false,
      canRefresh: false,
      canRequestRecovery: false,
      recoveryInProgress: false,
      showDraftRecovery: false,
    })
  })

  it('shows and enables draft deletion for a succeeded saved DRAFT', () => {
    expect(
      exportDetailActionAvailability(
        exportDocument({
          remoteStatus: 'DRAFT',
          state: 'succeeded',
          xeroInvoiceId: 'invoice-1',
        }),
        'owner',
      ),
    ).toMatchObject({
      canDeleteDraft: true,
      canRefresh: true,
      showDraftRecovery: true,
    })
  })

  it('shows DRAFT recovery context but blocks deletion while manual review is unresolved', () => {
    expect(
      exportDetailActionAvailability(
        exportDocument({
          remoteStatus: 'DRAFT',
          state: 'manual-review',
          xeroInvoiceId: 'invoice-1',
        }),
        'admin',
      ),
    ).toMatchObject({
      canDeleteDraft: false,
      canRequestRecovery: true,
      showDraftRecovery: true,
    })
  })

  it('marks reconciliation in progress without offering a duplicate queue action', () => {
    expect(
      exportDetailActionAvailability(exportDocument({ state: 'reconciling' }), 'owner'),
    ).toMatchObject({
      canRequestRecovery: false,
      recoveryInProgress: true,
    })
  })

  it('offers replacement approval instead of another recovery request when absence is confirmed', () => {
    expect(
      exportDetailActionAvailability(
        exportDocument({
          lastErrorCode: 'confirmed-absent-replacement-approval-required',
          state: 'manual-review',
        }),
        'admin',
      ),
    ).toMatchObject({
      canAuthorizeReplacement: true,
      canRequestRecovery: false,
    })
  })

  it.each(['DELETED', 'VOIDED'] as const)(
    'offers release rather than export recovery when Xero reports %s',
    (remoteStatus) => {
      expect(
        exportDetailActionAvailability(
          exportDocument({
            remoteStatus,
            state: 'action-required',
            xeroInvoiceId: 'invoice-1',
          }),
          'owner',
        ),
      ).toMatchObject({
        canRefresh: true,
        canRequestRecovery: false,
      })
    },
  )

  it('requires a saved invoice ID for refresh and DRAFT recovery context', () => {
    expect(
      exportDetailActionAvailability(
        exportDocument({ remoteStatus: 'DRAFT', state: 'succeeded' }),
        'owner',
      ),
    ).toMatchObject({
      canDeleteDraft: false,
      canRefresh: false,
      showDraftRecovery: false,
    })
  })

  it.each([
    { releaseAction: null, state: 'released' as const },
    { releaseAction: 'release-1', state: 'succeeded' as const },
  ])('hides DRAFT recovery after release', ({ releaseAction, state }) => {
    expect(
      exportDetailActionAvailability(
        exportDocument({
          releaseAction,
          remoteStatus: 'DRAFT',
          state,
          xeroInvoiceId: 'invoice-1',
        }),
        'owner',
      ),
    ).toMatchObject({
      canDeleteDraft: false,
      showDraftRecovery: false,
    })
  })
})

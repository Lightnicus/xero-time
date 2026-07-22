import type { UserRole } from '@/access/roles'
import type { InvoiceExport } from '@/payload-types'

export type ExportDetailDocument = Pick<
  InvoiceExport,
  'lastErrorCode' | 'releaseAction' | 'remoteStatus' | 'state' | 'xeroInvoiceId'
>

export type ExportDetailActionAvailability = {
  canAuthorizeReplacement: boolean
  canDeleteDraft: boolean
  canRefresh: boolean
  canRequestRecovery: boolean
  recoveryInProgress: boolean
  showDraftRecovery: boolean
}

const REPLACEMENT_APPROVAL_ERROR = 'confirmed-absent-replacement-approval-required'

export const exportDetailActionAvailability = (
  document: ExportDetailDocument,
  role: UserRole | null | undefined,
): ExportDetailActionAvailability => {
  const isOwnerAdmin = role === 'owner' || role === 'admin'
  if (!isOwnerAdmin) {
    return {
      canAuthorizeReplacement: false,
      canDeleteDraft: false,
      canRefresh: false,
      canRequestRecovery: false,
      recoveryInProgress: false,
      showDraftRecovery: false,
    }
  }

  const canRefresh = Boolean(document.xeroInvoiceId)
  const replacementApprovalRequired = document.lastErrorCode === REPLACEMENT_APPROVAL_ERROR
  const remoteInvoiceIsClosed =
    document.remoteStatus === 'DELETED' || document.remoteStatus === 'VOIDED'
  const showDraftRecovery =
    canRefresh &&
    document.remoteStatus === 'DRAFT' &&
    document.state !== 'released' &&
    !document.releaseAction

  return {
    canAuthorizeReplacement: document.state === 'manual-review' && replacementApprovalRequired,
    canDeleteDraft: showDraftRecovery && document.state === 'succeeded',
    canRefresh,
    canRequestRecovery:
      (document.state === 'action-required' || document.state === 'manual-review') &&
      !replacementApprovalRequired &&
      !remoteInvoiceIsClosed,
    recoveryInProgress: document.state === 'reconciling',
    showDraftRecovery,
  }
}

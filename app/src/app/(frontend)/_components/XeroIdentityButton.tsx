import type { IdentityFlowPurpose } from '@/lib/xero/identity/service'

import { PendingNavigationForm, PendingSubmitButton } from './PendingControls'

export function XeroIdentityButton({
  invitationToken,
  purpose,
  returnPath,
}: {
  invitationToken?: string
  purpose: IdentityFlowPurpose
  returnPath: string
}) {
  return (
    <PendingNavigationForm action="/api/auth/xero/identity/start" method="post">
      <input name="purpose" type="hidden" value={purpose} />
      <input name="returnPath" type="hidden" value={returnPath} />
      {invitationToken && <input name="invitationToken" type="hidden" value={invitationToken} />}
      <PendingSubmitButton
        className="button button-xero button-wide"
        pendingLabel={purpose === 'invite-acceptance' ? 'Starting Xero setup…' : 'Signing in…'}
      >
        <span aria-hidden="true" className="xero-wordmark">
          xero
        </span>
        {purpose === 'invite-acceptance' ? 'Set up with Xero' : 'Sign in with Xero'}
      </PendingSubmitButton>
    </PendingNavigationForm>
  )
}

import type { IdentityFlowPurpose } from '@/lib/xero/identity/service'

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
    <form action="/api/auth/xero/identity/start" method="post">
      <input name="purpose" type="hidden" value={purpose} />
      <input name="returnPath" type="hidden" value={returnPath} />
      {invitationToken && <input name="invitationToken" type="hidden" value={invitationToken} />}
      <button className="button button-xero button-wide" type="submit">
        <span aria-hidden="true" className="xero-wordmark">
          xero
        </span>
        {purpose === 'invite-acceptance' ? 'Set up with Xero' : 'Sign in with Xero'}
      </button>
    </form>
  )
}

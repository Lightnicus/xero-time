/**
 * Shared vocabulary for a Xero accounting connection that stopped working.
 *
 * The connection service records a machine-readable `lastErrorCode`; this module turns it into
 * the cause to act on, so the settings page, the app-wide banner, and the
 * export worker all describe the same recovery steps.
 */

/** Export `lastErrorCode` used while an export is parked until Xero is reconnected. */
export const XERO_RECONNECT_EXPORT_CODE = 'xero-reconnect-required'

export const XERO_RECONNECT_EXPORT_MESSAGE =
  'Paused until Xero is reconnected. It resumes automatically after reconnection.'

/**
 * How long a parked export waits before it checks the connection again on its own. Reconnecting
 * resumes parked exports immediately, so this is only a fallback and is kept long so a lengthy
 * outage does not fill each export's history with identical rechecks.
 */
export const XERO_RECONNECT_RECHECK_SECONDS = 6 * 60 * 60

export type ConnectionRecoveryCause =
  | 'authorization-expired'
  | 'authorizer-mismatch'
  | 'client-credentials'
  | 'disconnected'
  | 'organisation-removed'
  | 'unknown'

export function connectionRecoveryCause(
  lastErrorCode: string | null | undefined,
  status: string,
): ConnectionRecoveryCause {
  const code = lastErrorCode ?? ''
  if (/invalid-client|unauthorized-client/.test(code)) return 'client-credentials'
  if (code === 'connection-missing') return 'organisation-removed'
  if (code === 'refresh-identity-mismatch') return 'authorizer-mismatch'
  if (/^token-refresh-/.test(code)) return 'authorization-expired'
  if (status === 'disconnected') return 'disconnected'
  return 'unknown'
}

/** The stored, user-facing explanation for a refresh failure that needs a person to fix it. */
export function connectionFailureMessage(code: string): string {
  switch (connectionRecoveryCause(code, 'action-required')) {
    case 'client-credentials':
      return 'Xero rejected the saved accounting client ID or secret. Update the OAuth application credentials, then reconnect Xero.'
    case 'authorizer-mismatch':
      return 'Xero returned a token for a different Xero user than the one who connected. Reconnect Xero to confirm who authorizes the connection.'
    case 'organisation-removed':
      return 'The Xero organisation is no longer connected to this app. Reconnect Xero to resume invoice exports.'
    default:
      return 'Xero no longer accepts the saved authorization. Reconnect Xero to resume invoice exports.'
  }
}

import 'server-only'

import { canDeliverAccountEmail } from '@/lib/account-email'
import { environment } from '@/lib/env'
import { logServerEvent } from '@/lib/observability/logger'
import { requireMongoModel } from '@/lib/payload/mongo'

import { connectionFailureMessage } from './recovery'

import type { Payload } from 'payload'

const escapeHTML = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[character] ??
      character,
  )

export const reconnectAlertEmail = (input: {
  errorCode: string
  settingsURL: string
  tenantName?: null | string
}): { html: string; subject: string } => {
  const organisation = input.tenantName ? `Xero (${input.tenantName})` : 'Xero'
  return {
    html: [
      `<p>${escapeHTML(organisation)} stopped accepting Project Time's connection.</p>`,
      `<p>${escapeHTML(connectionFailureMessage(input.errorCode))}</p>`,
      '<p>Invoice exports are paused, keep their time reserved, and resume automatically once you reconnect.</p>',
      `<p><a href="${escapeHTML(input.settingsURL)}">Reconnect Xero</a></p>`,
    ].join(''),
    subject: `${organisation} needs to be reconnected`,
  }
}

/**
 * Emails the app's user once per outage when the Xero connection needs reconnecting. The claim on
 * `reconnectAlertSentAt` makes repeated failures (and concurrent workers) send a single email; a
 * successful reconnect clears it. Delivery is best-effort and never affects the caller.
 */
export async function sendReconnectAlert(
  payload: Payload,
  connectionID: number | string,
): Promise<boolean> {
  try {
    if (!canDeliverAccountEmail(payload)) return false
    const claimed = await requireMongoModel(payload, 'xero-connections').findOneAndUpdate(
      {
        _id: connectionID,
        reconnectAlertSentAt: null,
        status: 'action-required',
      },
      { $set: { reconnectAlertSentAt: new Date() } },
      { new: true },
    )
    if (!claimed) return false

    const users = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      pagination: false,
      select: { email: true },
    })
    const recipients = users.docs.map((user) => user.email).filter(Boolean)
    if (recipients.length === 0) return false

    const message = reconnectAlertEmail({
      errorCode: String(claimed.lastErrorCode ?? ''),
      settingsURL: new URL('/app/settings/xero#reconnect', environment.serverURL).toString(),
      tenantName: claimed.tenantName as null | string | undefined,
    })
    await payload.sendEmail({ ...message, to: recipients })
    logServerEvent(payload, 'info', 'xero.reconnect-alert-sent', { recipients: recipients.length })
    return true
  } catch (error) {
    logServerEvent(payload, 'warn', 'xero.reconnect-alert-failed', {
      error: error instanceof Error ? error.message : 'unknown',
    })
    return false
  }
}

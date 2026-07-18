import { resendAdapter } from '@payloadcms/email-resend'

import { environment, type AccountEmailEnvironment } from './env'

import type { EmailAdapter, Payload } from 'payload'

export const RESEND_ADAPTER_NAME = 'resend-rest'

export function createAccountEmailAdapter(
  config: AccountEmailEnvironment,
): EmailAdapter | undefined {
  if (!config.configured) return undefined

  return resendAdapter({
    apiKey: config.apiKey,
    defaultFromAddress: config.fromAddress,
    defaultFromName: config.fromName,
  })
}

export const accountEmailAdapter = createAccountEmailAdapter(environment.accountEmail)

export function canDeliverAccountEmail(payload: Payload): boolean {
  return environment.accountEmail.configured && payload.email?.name === RESEND_ADAPTER_NAME
}

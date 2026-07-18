function requiredEnvironmentValue(
  name: 'DATABASE_URL' | 'NEXT_PUBLIC_SERVER_URL' | 'PAYLOAD_SECRET',
): string {
  const value = process.env[name]?.trim()

  if (!value) throw new Error(`Missing required environment variable ${name}.`)
  return value
}

function applicationOrigin(value: string): string {
  const url = new URL(value)

  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(
      'NEXT_PUBLIC_SERVER_URL must be an origin without a path, query, credentials, or hash.',
    )
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_SERVER_URL must use http or https.')
  }

  return url.origin
}

function positiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name]
  if (!rawValue) return fallback

  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }

  return value
}

type EnvironmentValues = Readonly<Record<string, string | undefined>>

export type AccountEmailEnvironment =
  | {
      configured: false
      deliveryMode: 'manual'
    }
  | {
      apiKey: string
      configured: true
      deliveryMode: 'resend'
      fromAddress: string
      fromName: string
    }

const emailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseAccountEmailEnvironment(values: EnvironmentValues): AccountEmailEnvironment {
  const deliveryMode = values.ACCOUNT_EMAIL_DELIVERY_MODE?.trim() || 'manual'
  if (deliveryMode === 'manual') return { configured: false, deliveryMode }
  if (deliveryMode !== 'resend') {
    throw new Error('ACCOUNT_EMAIL_DELIVERY_MODE must be either manual or resend.')
  }

  const apiKey = values.RESEND_API_KEY?.trim() ?? ''
  const fromAddress = values.RESEND_FROM_ADDRESS?.trim() ?? ''
  const fromName = values.RESEND_FROM_NAME?.trim() ?? ''

  if (!apiKey || !fromAddress || !fromName) {
    throw new Error(
      'RESEND_API_KEY, RESEND_FROM_ADDRESS, and RESEND_FROM_NAME are required when account email delivery uses Resend.',
    )
  }
  if (apiKey.length > 500 || /\s/.test(apiKey)) {
    throw new Error('RESEND_API_KEY must be a valid non-whitespace API key.')
  }
  if (fromAddress.length > 320 || !emailAddressPattern.test(fromAddress)) {
    throw new Error('RESEND_FROM_ADDRESS must be a valid email address.')
  }
  if (fromName.length > 120 || /[\r\n]/.test(fromName)) {
    throw new Error('RESEND_FROM_NAME must be a single-line name of 120 characters or fewer.')
  }

  return {
    apiKey,
    configured: true,
    deliveryMode,
    fromAddress,
    fromName,
  }
}

const optionalEnvironmentValue = (name: string): string => process.env[name]?.trim() ?? ''

export type XeroIdentityEnvironment =
  | { configured: false }
  | {
      authFlowEncryptionKey: string
      authFlowEncryptionKeyVersion: number
      clientID: string
      clientSecret: string
      configured: true
      redirectURI: string
    }

function xeroIdentityEnvironment(serverURL: string): XeroIdentityEnvironment {
  const clientID = optionalEnvironmentValue('XERO_IDENTITY_CLIENT_ID')
  const clientSecret = optionalEnvironmentValue('XERO_IDENTITY_CLIENT_SECRET')
  const redirectURI = optionalEnvironmentValue('XERO_IDENTITY_REDIRECT_URI')
  const configuredValues = [clientID, clientSecret, redirectURI]

  if (configuredValues.every((value) => value.length === 0)) return { configured: false }
  if (configuredValues.some((value) => value.length === 0)) {
    throw new Error(
      'XERO_IDENTITY_CLIENT_ID, XERO_IDENTITY_CLIENT_SECRET, and XERO_IDENTITY_REDIRECT_URI must be configured together.',
    )
  }

  const callback = new URL(redirectURI)
  if (
    callback.origin !== serverURL ||
    callback.pathname !== '/api/auth/xero/identity/callback' ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password
  ) {
    throw new Error(
      'XERO_IDENTITY_REDIRECT_URI must use NEXT_PUBLIC_SERVER_URL and the identity callback path.',
    )
  }

  const authFlowEncryptionKey = optionalEnvironmentValue('AUTH_FLOW_ENCRYPTION_KEY')
  if (!/^[0-9a-f]{64}$/i.test(authFlowEncryptionKey)) {
    throw new Error(
      'AUTH_FLOW_ENCRYPTION_KEY must contain exactly 32 bytes encoded as 64 hex digits.',
    )
  }

  return {
    authFlowEncryptionKey,
    authFlowEncryptionKeyVersion: positiveInteger('AUTH_FLOW_ENCRYPTION_KEY_VERSION', 1),
    clientID,
    clientSecret,
    configured: true,
    redirectURI: callback.toString(),
  }
}

const serverURL = applicationOrigin(requiredEnvironmentValue('NEXT_PUBLIC_SERVER_URL'))
const xeroIdentity = xeroIdentityEnvironment(serverURL)

const protectedMachineSecret = (name: 'CRON_SECRET' | 'XERO_WEBHOOK_KEY'): string | undefined => {
  const value = optionalEnvironmentValue(name)
  if (!value) return undefined
  if (value.length < 32 || value.length > 500 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a single-line secret between 32 and 500 characters.`)
  }
  return value
}

export const environment = {
  accountEmail: parseAccountEmailEnvironment(process.env),
  databaseURL: requiredEnvironmentValue('DATABASE_URL'),
  mongoMaxPoolSize: positiveInteger('MONGODB_MAX_POOL_SIZE', 10),
  payloadSecret: requiredEnvironmentValue('PAYLOAD_SECRET'),
  cronSecret: protectedMachineSecret('CRON_SECRET'),
  serverURL,
  xeroWebhookKey: protectedMachineSecret('XERO_WEBHOOK_KEY'),
  xeroIdentity,
}

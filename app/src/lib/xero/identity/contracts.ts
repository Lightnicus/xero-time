export const XERO_IDENTITY_ISSUER = 'https://identity.xero.com'
export const REQUIRED_IDENTITY_SCOPES = ['openid', 'profile', 'email'] as const

const forbiddenAccountingScopePrefixes = ['accounting.', 'assets', 'files', 'projects', 'payroll']

export class IdentityIntegrationError extends Error {
  code: string

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'IdentityIntegrationError'
    this.code = code
  }
}

export type XeroIdentityClaims = {
  displayName: string
  email: string
  issuer: string
  subject: string
}

const normalizeScopes = (value: unknown): string[] | null => {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value) && value.every((scope) => typeof scope === 'string')) return value
  return null
}

/** The identity trust boundary accepts no offline or tenant/accounting permission. */
export function validateIdentityScopes(value: unknown): string[] {
  const scopes = normalizeScopes(value)
  if (!scopes) {
    throw new IdentityIntegrationError(
      'invalid-scopes',
      'Xero did not return the expected identity permissions.',
    )
  }

  const unique = new Set(scopes)
  const forbidden = [...unique].some(
    (scope) =>
      scope === 'offline_access' ||
      forbiddenAccountingScopePrefixes.some(
        (prefix) => scope === prefix || scope.startsWith(`${prefix}.`) || scope.startsWith(prefix),
      ),
  )
  if (
    forbidden ||
    unique.size !== REQUIRED_IDENTITY_SCOPES.length ||
    REQUIRED_IDENTITY_SCOPES.some((scope) => !unique.has(scope))
  ) {
    throw new IdentityIntegrationError(
      'invalid-scopes',
      'Xero did not grant exactly the required identity permissions.',
    )
  }

  return [...REQUIRED_IDENTITY_SCOPES]
}

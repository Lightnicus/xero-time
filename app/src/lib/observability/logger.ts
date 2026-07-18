import type { Payload } from 'payload'

const sensitiveKey =
  /(authorization|code|cookie|description|email|envelope|nonce|password|payload|pkce|secret|session|subject|token|verifier)/i

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 250)
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitize(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value)

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? '[redacted]' : sanitize(item, depth + 1),
      ]),
  )
}

export function logServerEvent(
  payload: Payload,
  level: 'error' | 'info' | 'warn',
  event: string,
  context: Record<string, unknown> = {},
): void {
  payload.logger[level]({
    event: event.slice(0, 100),
    ...(sanitize(context) as Record<string, unknown>),
  })
}

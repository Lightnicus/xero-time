import { createHash } from 'node:crypto'

const normalized = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    )
  }
  return value
}

export const stableJSON = (value: unknown): string => JSON.stringify(normalized(value))

export const stableHash = (value: unknown): string =>
  createHash('sha256').update(stableJSON(value), 'utf8').digest('base64url')

import { RATE_SCALE } from './validation'

const decimalAmountPattern = /^(?:(\d+)(?:\.(\d{0,4}))?|\.(\d{1,4}))$/

const scaledAmountParts = (value: number): { fraction: string; whole: number } | null => {
  if (!Number.isSafeInteger(value) || value < 0) return null

  return {
    fraction: String(value % RATE_SCALE)
      .padStart(4, '0')
      .replace(/0+$/, '')
      .padEnd(2, '0'),
    whole: Math.floor(value / RATE_SCALE),
  }
}

/** Converts an exact decimal rate into the integer representation used for billing. */
export function decimalAmountToScaled(value: string): number | null {
  const normalized = value.trim()
  if (normalized.length > 32) return null

  const match = decimalAmountPattern.exec(normalized)
  if (!match) return null

  const whole = match[1] ?? '0'
  const fraction = match[2] ?? match[3] ?? ''
  const scaled = BigInt(whole) * BigInt(RATE_SCALE) + BigInt(fraction.padEnd(4, '0'))

  return scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null
}

/** Formats a stored scaled amount for an editable decimal input without grouping separators. */
export function formatScaledDecimal(value: number): string | null {
  const parts = scaledAmountParts(value)
  return parts ? `${parts.whole}.${parts.fraction}` : null
}

/** Formats a scaled integer without passing through binary floating-point arithmetic. */
export function formatScaledAmount(value: number, currency: string): string {
  const parts = scaledAmountParts(value)
  if (!parts || !/^[A-Z]{3}$/.test(currency)) return 'Invalid rate'

  return `${currency} ${parts.whole.toLocaleString('en-NZ')}.${parts.fraction}`
}

export function multiplyDurationByRate(durationSeconds: number, rateScaled: number): number {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds % 60 !== 0 ||
    !Number.isSafeInteger(rateScaled) ||
    rateScaled < 0
  ) {
    throw new Error('Invalid duration or scaled rate.')
  }
  const numerator = BigInt(durationSeconds) * BigInt(rateScaled)
  const rounded = (numerator + 1_800n) / 3_600n
  const result = Number(rounded)
  if (!Number.isSafeInteger(result)) throw new Error('The calculated amount is too large.')
  return result
}

import { RATE_SCALE } from './validation'

/** Formats a scaled integer without passing through binary floating-point arithmetic. */
export function formatScaledAmount(value: number, currency: string): string {
  if (!Number.isSafeInteger(value) || value < 0 || !/^[A-Z]{3}$/.test(currency))
    return 'Invalid rate'
  const whole = Math.floor(value / RATE_SCALE)
  const fraction = String(value % RATE_SCALE)
    .padStart(4, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0')
  return `${currency} ${whole.toLocaleString('en-NZ')}.${fraction}`
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

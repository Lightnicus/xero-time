import { RATE_SCALE } from '@/lib/domain/validation'

export const QUANTITY_SCALE = 10_000

const assertSafeResult = (value: bigint): number => {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('The billing calculation is too large.')
  return result
}

/** Xero receives hours and unit amounts at four decimal places. */
export function durationToQuantityScaled(durationSeconds: number): number {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds % 60 !== 0
  ) {
    throw new Error('Duration must be a positive whole number of minutes.')
  }
  return assertSafeResult((BigInt(durationSeconds) * BigInt(QUANTITY_SCALE) + 1_800n) / 3_600n)
}

/** One cent in the four-decimal scale used for amounts. */
const CENT_SCALED = 100n

/** Rounds a non-negative four-decimal amount to whole cents, half up, as Xero does. */
export function roundScaledToCents(value: number | bigint): number {
  const scaled = BigInt(value)
  if (scaled < 0n) throw new Error('Amounts must not be negative.')
  return assertSafeResult(((scaled + CENT_SCALED / 2n) / CENT_SCALED) * CENT_SCALED)
}

/**
 * Xero stores each line amount as Quantity x UnitAmount rounded to cents, so line amounts (and
 * everything summed from them) are rounded per line here too.
 */
export function quantityRateAmountScaled(quantityScaled: number, rateScaled: number): number {
  if (
    !Number.isSafeInteger(quantityScaled) ||
    quantityScaled <= 0 ||
    !Number.isSafeInteger(rateScaled) ||
    rateScaled < 0
  ) {
    throw new Error('Quantity and rate must be valid scaled integers.')
  }
  return roundScaledToCents(
    (BigInt(quantityScaled) * BigInt(rateScaled) + BigInt(QUANTITY_SCALE / 2)) /
      BigInt(QUANTITY_SCALE),
  )
}

export function taxForLine(
  amountScaled: number,
  taxRatePercent: number,
  lineAmountType: 'Exclusive' | 'Inclusive' | 'NoTax',
): number {
  if (
    !Number.isSafeInteger(amountScaled) ||
    amountScaled < 0 ||
    !Number.isFinite(taxRatePercent) ||
    taxRatePercent < 0 ||
    taxRatePercent > 100
  ) {
    throw new Error('Amount and tax rate are invalid.')
  }
  if (lineAmountType === 'NoTax' || taxRatePercent === 0) return 0

  // Xero calculates tax on each line and rounds it to cents.
  const rateBasisPoints = Math.round(taxRatePercent * 100)
  if (lineAmountType === 'Exclusive') {
    return roundScaledToCents((BigInt(amountScaled) * BigInt(rateBasisPoints) + 5_000n) / 10_000n)
  }

  const denominator = 10_000 + rateBasisPoints
  const exclusive = roundScaledToCents(
    (BigInt(amountScaled) * 10_000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator),
  )
  return amountScaled - exclusive
}

export function scaledDecimal(value: number, scale = RATE_SCALE): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid scaled value.')
  return Number(`${Math.floor(value / scale)}.${String(value % scale).padStart(4, '0')}`)
}

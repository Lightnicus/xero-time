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

export function quantityRateAmountScaled(quantityScaled: number, rateScaled: number): number {
  if (
    !Number.isSafeInteger(quantityScaled) ||
    quantityScaled <= 0 ||
    !Number.isSafeInteger(rateScaled) ||
    rateScaled < 0
  ) {
    throw new Error('Quantity and rate must be valid scaled integers.')
  }
  return assertSafeResult(
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

  const rateBasisPoints = Math.round(taxRatePercent * 100)
  if (lineAmountType === 'Exclusive') {
    return assertSafeResult((BigInt(amountScaled) * BigInt(rateBasisPoints) + 5_000n) / 10_000n)
  }

  const denominator = 10_000 + rateBasisPoints
  const exclusive = assertSafeResult(
    (BigInt(amountScaled) * 10_000n + BigInt(Math.floor(denominator / 2))) / BigInt(denominator),
  )
  return amountScaled - exclusive
}

export function scaledDecimal(value: number, scale = RATE_SCALE): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid scaled value.')
  return Number(`${Math.floor(value / scale)}.${String(value % scale).padStart(4, '0')}`)
}

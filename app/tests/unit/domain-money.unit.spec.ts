import { describe, expect, it } from 'vitest'

import {
  decimalAmountToScaled,
  formatScaledAmount,
  formatScaledDecimal,
  formatScaledDisplayDecimal,
} from '@/lib/domain/money'

describe('domain money presentation', () => {
  it.each([
    ['0', 0],
    ['.5', 5_000],
    ['0.50', 5_000],
    ['150', 1_500_000],
    ['150.00', 1_500_000],
    ['150.10', 1_501_000],
    ['150.1234', 1_501_234],
    ['000150.0100', 1_500_100],
    ['900719925474.0991', Number.MAX_SAFE_INTEGER],
  ])('converts the decimal rate %s to exact scaled storage', (value, expected) => {
    expect(decimalAmountToScaled(value)).toBe(expected)
  })

  it.each([
    '',
    '.',
    '-1',
    '150.12345',
    '1e2',
    '1,500',
    'NaN',
    'Infinity',
    '900719925474.0992',
    '9'.repeat(1_000),
  ])('rejects the invalid or unsupported decimal rate %s', (value) => {
    expect(decimalAmountToScaled(value)).toBeNull()
  })

  it.each([
    [0, '0.00'],
    [1, '0.0001'],
    [5_000, '0.50'],
    [1_500_000, '150.00'],
    [1_501_000, '150.10'],
    [1_501_234, '150.1234'],
    [Number.MAX_SAFE_INTEGER, '900719925474.0991'],
  ])('formats stored value %d for ordinary decimal editing', (value, expected) => {
    expect(formatScaledDecimal(value)).toBe(expected)
  })

  it.each([
    [0, 'NZD 0.00'],
    [1, 'NZD 0.00'],
    [49, 'NZD 0.00'],
    [50, 'NZD 0.01'],
    [1_501_234, 'NZD 150.12'],
    [1_501_250, 'NZD 150.13'],
    [1_509_999, 'NZD 151.00'],
    [123_456_789, 'NZD 12,345.68'],
    [Number.MAX_SAFE_INTEGER, 'NZD 900,719,925,474.10'],
  ])('formats stored currency value %d with exactly two decimals', (value, expected) => {
    expect(formatScaledAmount(value, 'NZD')).toBe(expected)
  })

  it('formats a currency-free display value while preserving exact editable decimals', () => {
    expect(formatScaledDisplayDecimal(1_501_234)).toBe('150.12')
    expect(formatScaledDecimal(1_501_234)).toBe('150.1234')
  })

  it('uses two display decimals regardless of the currency code', () => {
    expect(formatScaledAmount(1_501_234, 'JPY')).toBe('JPY 150.12')
    expect(formatScaledAmount(1_501_234, 'KWD')).toBe('KWD 150.12')
  })

  it('rejects invalid display storage and currency codes', () => {
    expect(formatScaledDecimal(-1)).toBeNull()
    expect(formatScaledDecimal(1.5)).toBeNull()
    expect(formatScaledDisplayDecimal(-1)).toBeNull()
    expect(formatScaledAmount(1_500_000, 'nzd')).toBe('Invalid amount')
  })
})

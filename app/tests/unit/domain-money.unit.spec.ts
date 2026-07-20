import { describe, expect, it } from 'vitest'

import { decimalAmountToScaled, formatScaledAmount, formatScaledDecimal } from '@/lib/domain/money'

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

  it('formats list values with currency while rejecting invalid storage', () => {
    expect(formatScaledAmount(1_500_000, 'NZD')).toBe('NZD 150.00')
    expect(formatScaledDecimal(-1)).toBeNull()
    expect(formatScaledDecimal(1.5)).toBeNull()
    expect(formatScaledAmount(1_500_000, 'nzd')).toBe('Invalid rate')
  })
})

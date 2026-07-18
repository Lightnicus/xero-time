import { describe, expect, it } from 'vitest'

import {
  formatCalendarDateInTimezone,
  isValidCalendarDate,
  isValidCurrencyCode,
  isValidIanaTimezone,
  isValidLocalTime,
  normalizeCurrencyCode,
  relationshipID,
} from '@/lib/domain/validation'

describe('domain validation', () => {
  it.each(['2026-01-01', '2024-02-29', '1999-12-31'])('accepts calendar date %s', (value) => {
    expect(isValidCalendarDate(value)).toBe(true)
  })

  it.each(['2026-02-29', '2026-13-01', '01-01-2026', ''])('rejects calendar date %s', (value) => {
    expect(isValidCalendarDate(value)).toBe(false)
  })

  it('validates supported timezone syntax through Intl', () => {
    expect(isValidIanaTimezone('Pacific/Auckland')).toBe(true)
    expect(isValidIanaTimezone('UTC')).toBe(true)
    expect(isValidIanaTimezone('Auckland')).toBe(false)
    expect(isValidIanaTimezone('Pacific/Not_A_Zone')).toBe(false)
  })

  it.each(['NZD', 'USD', 'EUR'])('accepts formatted currency code %s', (value) => {
    expect(isValidCurrencyCode(value)).toBe(true)
  })

  it.each(['nzd', 'NZ', 'EURO', '12D'])('rejects malformed currency code %s', (value) => {
    expect(isValidCurrencyCode(value)).toBe(false)
  })

  it.each(['00:00', '09:05', '23:59'])('accepts local time %s', (value) => {
    expect(isValidLocalTime(value)).toBe(true)
  })

  it.each(['24:00', '9:05', '12:60', ''])('rejects local time %s', (value) => {
    expect(isValidLocalTime(value)).toBe(false)
  })

  it('normalizes currency codes without coercing non-strings', () => {
    expect(normalizeCurrencyCode(' nzd ')).toBe('NZD')
    expect(normalizeCurrencyCode(null)).toBeNull()
  })

  it('extracts relationship identifiers safely', () => {
    expect(relationshipID('abc')).toBe('abc')
    expect(relationshipID({ id: 42 })).toBe(42)
    expect(relationshipID({ toHexString: () => '507f1f77bcf86cd799439011' })).toBe(
      '507f1f77bcf86cd799439011',
    )
    expect(relationshipID({ toHexString: () => 'not-an-object-id' })).toBeNull()
    expect(relationshipID({ id: null })).toBeNull()
    expect(relationshipID(undefined)).toBeNull()
  })

  it('derives the local calendar date without depending on the machine timezone', () => {
    const instant = new Date('2026-07-18T12:30:00.000Z')

    expect(formatCalendarDateInTimezone(instant, 'Pacific/Auckland')).toBe('2026-07-19')
    expect(formatCalendarDateInTimezone(instant, 'America/Los_Angeles')).toBe('2026-07-18')
  })
})

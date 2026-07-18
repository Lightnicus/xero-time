export const DEFAULT_TIMEZONE = 'Pacific/Auckland'
export const DEFAULT_CURRENCY = 'NZD'
export const RATE_SCALE = 10_000
export const MAX_TIME_ENTRY_SECONDS = 24 * 60 * 60

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/
const currencyCodePattern = /^[A-Z]{3}$/
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const xeroIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const fallbackCurrencies = ['AUD', 'CAD', 'EUR', 'GBP', 'NZD', 'USD']
const fallbackTimezones = ['Australia/Brisbane', 'Australia/Sydney', DEFAULT_TIMEZONE]

function supportedValues(key: 'currency' | 'timeZone', fallback: string[]): string[] {
  try {
    return Intl.supportedValuesOf(key)
  } catch {
    return fallback
  }
}

const currencies = new Set([...supportedValues('currency', fallbackCurrencies), DEFAULT_CURRENCY])
const timezones = new Set([
  ...supportedValues('timeZone', fallbackTimezones),
  DEFAULT_TIMEZONE,
  'UTC',
])
const currencyDisplayNames = new Intl.DisplayNames(['en-NZ'], { type: 'currency' })

export const currencyOptions = [...currencies]
  .sort((left, right) => {
    if (left === DEFAULT_CURRENCY) return -1
    if (right === DEFAULT_CURRENCY) return 1
    return left.localeCompare(right)
  })
  .map((currency) => ({
    label: `${currency} — ${currencyDisplayNames.of(currency) ?? currency}`,
    value: currency,
  }))

export const timezoneOptions = [...timezones]
  .sort((left, right) => {
    if (left === DEFAULT_TIMEZONE) return -1
    if (right === DEFAULT_TIMEZONE) return 1
    return left.localeCompare(right)
  })
  .map((timezone) => ({ label: timezone.replaceAll('_', ' '), value: timezone }))

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !calendarDatePattern.test(value)) return false

  const parts = value.split('-').map(Number)
  const year = parts[0]
  const month = parts[1]
  const day = parts[2]
  if (year === undefined || month === undefined || day === undefined) return false
  const parsed = new Date(Date.UTC(year, month - 1, day))

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

export function validateCalendarDate(value: unknown): true | string {
  return isValidCalendarDate(value) || 'Enter a valid calendar date in YYYY-MM-DD format.'
}

export function isValidCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && currencyCodePattern.test(value) && currencies.has(value)
}

export function validateCurrencyCode(value: unknown): true | string {
  return isValidCurrencyCode(value) || 'Enter a three-letter uppercase ISO currency code.'
}

export function isValidIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false

  try {
    new Intl.DateTimeFormat('en-NZ', { timeZone: value }).format()
    return value.includes('/') || value === 'UTC'
  } catch {
    return false
  }
}

export function validateIanaTimezone(value: unknown): true | string {
  return isValidIanaTimezone(value) || 'Select a valid IANA timezone such as Pacific/Auckland.'
}

export function validateLocale(value: unknown): true | string {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'Enter a valid BCP 47 locale such as en-NZ.'
  }

  try {
    new Intl.Locale(value)
    return true
  } catch {
    return 'Enter a valid BCP 47 locale such as en-NZ.'
  }
}

export function validateOptionalXeroID(value: unknown): true | string {
  if (value === null || typeof value === 'undefined' || value === '') return true

  return (typeof value === 'string' && xeroIDPattern.test(value)) || 'Enter a valid Xero UUID.'
}

export function validateScaledInteger(
  value: unknown,
  { allowZero = true }: { allowZero?: boolean } = {},
): true | string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return 'Enter a whole scaled-unit value within JavaScript safe-integer range.'
  }

  if (allowZero ? value < 0 : value <= 0) {
    return allowZero ? 'Value cannot be negative.' : 'Value must be greater than zero.'
  }

  return true
}

export function validateWholeNumber(
  value: unknown,
  { max, min }: { max: number; min: number },
): true | string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return 'Enter a whole number.'
  }

  return value >= min && value <= max ? true : `Enter a whole number from ${min} to ${max}.`
}

export function isValidLocalTime(value: unknown): value is string {
  return typeof value === 'string' && timePattern.test(value)
}

export function validateLocalTime(value: unknown): true | string {
  return isValidLocalTime(value) || 'Enter a time in 24-hour HH:mm format.'
}

export function normalizeCurrencyCode(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value
}

export function relationshipID(value: unknown): null | number | string {
  if (typeof value === 'string' || typeof value === 'number') return value

  if (value && typeof value === 'object' && 'id' in value) {
    const id = value.id
    if (typeof id === 'string' || typeof id === 'number') return id
  }

  // Raw Mongo/Mongoose operations return relationship values as BSON ObjectIds
  // instead of Payload's string or populated-document forms.
  if (value && typeof value === 'object' && 'toHexString' in value) {
    const toHexString = value.toHexString
    if (typeof toHexString === 'function') {
      const id = toHexString.call(value)
      return typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? id : null
    }
  }

  return null
}

export function formatCalendarDateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}

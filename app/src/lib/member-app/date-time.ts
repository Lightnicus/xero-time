import { isValidCalendarDate, isValidIanaTimezone, timezoneOptions } from '@/lib/domain/validation'

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/

type DateTimeParts = {
  day: number
  hour: number
  minute: number
  month: number
  year: number
}

const dateTimePartsInTimezone = (date: Date, timeZone: string): DateTimeParts => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    month: Number(values.month),
    year: Number(values.year),
  }
}

const partsAsUTC = ({ day, hour, minute, month, year }: DateTimeParts): number =>
  Date.UTC(year, month - 1, day, hour, minute)

const sameParts = (left: DateTimeParts, right: DateTimeParts): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute

export function isValidLocalDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false

  const match = localDateTimePattern.exec(value)
  if (!match) return false

  return isValidCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)
}

/**
 * Converts a wall-clock value in an IANA timezone to an instant. Non-existent
 * local times during a daylight-saving jump and ambiguous fall-back times are
 * rejected instead of shifted or guessed.
 */
export function localDateTimeToISOString(value: unknown, timeZone: unknown): string | null {
  if (!isValidLocalDateTime(value) || !isValidIanaTimezone(timeZone)) return null

  const match = localDateTimePattern.exec(value)
  if (!match) return null

  const desired: DateTimeParts = {
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    month: Number(match[2]),
    year: Number(match[1]),
  }
  const desiredAsUTC = partsAsUTC(desired)
  const offsets = new Set<number>()

  // Sampling either side discovers both offsets near a transition without
  // assuming that every timezone changes by exactly one hour.
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = desiredAsUTC + hours * 60 * 60 * 1_000
    offsets.add(partsAsUTC(dateTimePartsInTimezone(new Date(sample), timeZone)) - sample)
  }

  const candidates = [...offsets]
    .map((offset) => new Date(desiredAsUTC - offset))
    .filter((candidate) => sameParts(dateTimePartsInTimezone(candidate, timeZone), desired))
  const uniqueCandidates = new Map(
    candidates.map((candidate) => [candidate.getTime(), candidate.toISOString()]),
  )

  // Zero candidates is a DST gap; two candidates is a repeated wall time.
  return uniqueCandidates.size === 1 ? ([...uniqueCandidates.values()][0] ?? null) : null
}

export function instantToLocalDateTime(value: string | Date, timeZone: string): string | null {
  if (!isValidIanaTimezone(timeZone)) return null

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const parts = dateTimePartsInTimezone(date, timeZone)
  const pad = (number: number): string => String(number).padStart(2, '0')

  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

/** Keeps a valid stored alias selectable even when Intl returns only canonical zones. */
export function timezoneOptionsIncluding(...timezones: string[]) {
  const existing = new Set(timezoneOptions.map((option) => option.value))
  const additions = timezones
    .filter((timezone) => isValidIanaTimezone(timezone) && !existing.has(timezone))
    .filter((timezone, index, values) => values.indexOf(timezone) === index)
    .map((timezone) => ({
      label: `${timezone.replaceAll('_', ' ')} — current value`,
      value: timezone,
    }))

  return [...additions, ...timezoneOptions]
}

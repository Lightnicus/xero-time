import { describe, expect, it } from 'vitest'

import {
  instantToLocalDateTime,
  isValidLocalDateTime,
  localDateTimeToISOString,
  timezoneOptionsIncluding,
} from '@/lib/member-app/date-time'

describe('member app date and time conversion', () => {
  it('converts winter and summer Auckland wall-clock values to exact instants', () => {
    expect(localDateTimeToISOString('2026-07-18T09:30', 'Pacific/Auckland')).toBe(
      '2026-07-17T21:30:00.000Z',
    )
    expect(localDateTimeToISOString('2026-01-18T09:30', 'Pacific/Auckland')).toBe(
      '2026-01-17T20:30:00.000Z',
    )
  })

  it('round-trips an instant into a datetime-local value', () => {
    expect(instantToLocalDateTime('2026-07-17T21:30:00.000Z', 'Pacific/Auckland')).toBe(
      '2026-07-18T09:30',
    )
    expect(instantToLocalDateTime('2026-07-18T09:30:00.000Z', 'UTC')).toBe('2026-07-18T09:30')
  })

  it('preserves the intended duration across local midnight', () => {
    const start = localDateTimeToISOString('2026-07-18T23:30', 'Pacific/Auckland')
    const end = localDateTimeToISOString('2026-07-19T00:45', 'Pacific/Auckland')

    expect(start).not.toBeNull()
    expect(end).not.toBeNull()
    expect((new Date(end as string).getTime() - new Date(start as string).getTime()) / 60_000).toBe(
      75,
    )
  })

  it('rejects a local time skipped by the daylight-saving transition', () => {
    expect(localDateTimeToISOString('2026-09-27T02:30', 'Pacific/Auckland')).toBeNull()
  })

  it('rejects an ambiguous fall-back time rather than guessing a billable duration', () => {
    expect(localDateTimeToISOString('2026-04-05T02:30', 'Pacific/Auckland')).toBeNull()
  })

  it('keeps valid non-canonical timezone aliases selectable', () => {
    const options = timezoneOptionsIncluding('US/Eastern')

    expect(options[0]).toMatchObject({ value: 'US/Eastern' })
    expect(options.filter((option) => option.value === 'US/Eastern')).toHaveLength(1)
  })

  it('rejects malformed dates and timezones', () => {
    expect(isValidLocalDateTime('2026-02-29T09:00')).toBe(false)
    expect(localDateTimeToISOString('2026-07-18T24:00', 'Pacific/Auckland')).toBeNull()
    expect(localDateTimeToISOString('2026-07-18T09:00', 'Not/A_Timezone')).toBeNull()
    expect(instantToLocalDateTime('not-a-date', 'Pacific/Auckland')).toBeNull()
  })
})

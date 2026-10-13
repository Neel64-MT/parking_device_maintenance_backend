import { z } from 'zod'
import { isCalendarDate, istDayRange, todayIst } from './eod-report.js'

export const MAX_REPORT_DAYS = 366

/** Whole IST days from `from` to `to`, both included. */
export function reportDayCount(from: string, to: string): number {
  return Math.round((istDayRange(to).from.getTime() - istDayRange(from).from.getTime()) / 86400000) + 1
}

const calendarDate = z
  .string()
  .trim()
  .refine(isCalendarDate, 'Date must be a valid calendar date in YYYY-MM-DD format')

/**
 * Dashboard report period: `from` / `to` (inclusive IST calendar days) or the single-day alias
 * `date`. A missing end takes the other end; nothing at all means today (IST).
 */
export const reportRangeQuerySchema = z
  .object({ date: calendarDate.optional(), from: calendarDate.optional(), to: calendarDate.optional() })
  .strict()
  .refine((q) => !(q.date && (q.from || q.to)), {
    message: 'Use either date or from / to, not both',
    path: ['date'],
  })
  .transform(({ date, from, to }) => {
    if (date) return { from: date, to: date }
    const today = todayIst()
    return { from: from || to || today, to: to || from || today }
  })
  .refine(({ from, to }) => from <= to, { message: 'From date must be on or before To date', path: ['from'] })
  .refine(({ from, to }) => reportDayCount(from, to) <= MAX_REPORT_DAYS, {
    message: `Date range cannot be longer than ${MAX_REPORT_DAYS} days`,
    path: ['to'],
  })

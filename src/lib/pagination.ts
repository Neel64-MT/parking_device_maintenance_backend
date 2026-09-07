import { z } from 'zod'

export const ALLOWED_PAGE_LIMITS = [10, 25, 50, 100] as const
export type AllowedPageLimit = (typeof ALLOWED_PAGE_LIMITS)[number]

/** page query: positive int, default 1 */
export const pageSchema = z.coerce.number().int().positive().default(1)

/** limit query: only 10 | 25 | 50 | 100, default 10 */
export const limitSchema = z.coerce
  .number()
  .int()
  .refine((n): n is AllowedPageLimit => (ALLOWED_PAGE_LIMITS as readonly number[]).includes(n), {
    message: 'limit must be one of 10, 25, 50, 100',
  })
  .default(10)

export function paginationMeta(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
  }
}

export function sqlOffset(page: number, limit: number) {
  return (page - 1) * limit
}

import type { Response } from 'express'
import type { ApiResponse, PaginatedResponse } from '../types/api.js'

export function ok<T>(res: Response, data: T, message?: string, status = 200) {
  const body: ApiResponse<T> = { success: true, data }
  if (message) body.message = message
  return res.status(status).json(body)
}

export function created<T>(res: Response, data: T, message?: string) {
  return ok(res, data, message, 201)
}

export function paginated<T>(
  res: Response,
  data: T[],
  pagination: PaginatedResponse<T>['pagination'],
  message?: string,
) {
  const body: PaginatedResponse<T> = {
    success: true,
    data,
    pagination,
  }
  if (message) body.message = message
  return res.status(200).json(body)
}

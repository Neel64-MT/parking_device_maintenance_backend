import type { Request, Response, NextFunction } from 'express'
import { handleApiError, sendError } from '../lib/api-error.js'

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  return handleApiError(res, error)
}

export function notFoundHandler(_req: Request, res: Response) {
  return sendError(res, 404, 'Not found', 'NOT_FOUND')
}

import { z } from 'zod'
import type { Response } from 'express'
import type { ApiResponse } from '../types/api.js'

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  status = 200,
  message?: string,
) {
  const body: ApiResponse<T> = { success: true, data }
  if (message) body.message = message
  return res.status(status).json(body)
}

export function sendError(
  res: Response,
  statusCode: number,
  error: string,
  code?: string,
  details?: unknown,
) {
  const body: ApiResponse = { success: false, error }
  if (code) body.code = code
  if (details !== undefined) body.details = details
  return res.status(statusCode).json(body)
}

export function handleApiError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    return sendError(res, 400, 'Validation failed', 'VALIDATION_ERROR', error.issues.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    })))
  }

  if (error instanceof ApiError) {
    return sendError(res, error.statusCode, error.message, error.code, error.details)
  }

  if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
    return sendError(res, 409, 'Resource already exists', 'DUPLICATE_ERROR')
  }

  console.error('Unexpected error:', error)
  return sendError(res, 500, 'Internal server error', 'INTERNAL_ERROR')
}

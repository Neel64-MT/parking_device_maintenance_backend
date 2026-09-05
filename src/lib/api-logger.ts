import type { Request, Response, NextFunction } from 'express'

interface LogData {
  method: string
  url: string
  status?: number
  duration: number
  ip?: string
  userAgent?: string
  error?: string
}

export class ApiLogger {
  private startTime: number

  constructor(private request: Request) {
    this.startTime = Date.now()
  }

  log(status: number, error?: string) {
    const duration = Date.now() - this.startTime
    const logData: LogData = {
      method: this.request.method,
      url: this.request.originalUrl || this.request.url,
      status,
      duration,
      ip: (this.request.headers['x-forwarded-for'] as string) || this.request.ip || 'unknown',
      userAgent: this.request.headers['user-agent'] || 'unknown',
      error,
    }
    const logLevel = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO'
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [${logLevel}] ${JSON.stringify(logData)}`)
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const logger = new ApiLogger(req)
  res.on('finish', () => {
    logger.log(res.statusCode)
  })
  next()
}

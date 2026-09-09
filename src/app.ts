import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { env } from './config/env.js'
import { requestLogger } from './lib/api-logger.js'
import { errorHandler, notFoundHandler } from './middleware/error-handler.js'
import healthRouter from './routes/health.js'
import authRouter from './routes/auth.js'
import lookupsRouter from './routes/lookups.js'
import roadsRouter from './routes/roads.js'
import issuesRouter from './routes/issues.js'
import partsRouter from './routes/parts.js'
import usersRouter from './routes/users.js'
import rolesRouter from './routes/roles.js'
import devicesRouter from './routes/devices.js'
import deviceSyncRouter from './routes/device-sync.js'
import ticketsRouter from './routes/tickets.js'
import dashboardRouter from './routes/dashboard.js'
import reportsRouter from './routes/reports.js'
import uploadsRouter from './routes/uploads.js'

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '10mb' }))
  app.use(requestLogger)
  app.use('/uploads', express.static(path.resolve(env.UPLOAD_DIR)))

  app.use('/api/health', healthRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/lookups', lookupsRouter)
  app.use('/api/roads', roadsRouter)
  app.use('/api/issues', issuesRouter)
  app.use('/api/parts', partsRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/roles', rolesRouter)
  app.use('/api/devices', devicesRouter)
  app.use('/api/device-sync', deviceSyncRouter)
  app.use('/api/tickets', ticketsRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/uploads', uploadsRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

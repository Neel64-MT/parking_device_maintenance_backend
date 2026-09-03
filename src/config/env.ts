import 'dotenv/config'
import { z } from 'zod'

const envSchema = z
  .object({
    PORT: z.coerce.number().default(5000),
    // Discrete Postgres settings (preferred)
    DB_HOST: z.string().optional(),
    DB_PORT: z.coerce.number().default(5432),
    DB_USERNAME: z.string().optional(),
    DB_PASSWORD: z.string().optional(),
    DB_NAME: z.string().optional(),
    // Optional overrides
    DATABASE_URL: z.string().optional(),
    USE_PGLITE: z.string().optional(),
    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('7d'),
    FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
    UPLOAD_DIR: z.string().default('uploads'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .superRefine((data, ctx) => {
    const hasDiscrete =
      Boolean(data.DB_HOST) && Boolean(data.DB_USERNAME) && Boolean(data.DB_NAME)
    const hasUrl = Boolean(data.DATABASE_URL)
    const usePglite = data.USE_PGLITE === '1' || data.DATABASE_URL?.startsWith('pglite:')
    if (!hasDiscrete && !hasUrl && !usePglite) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Set DB_HOST, DB_USERNAME, DB_NAME (and DB_PASSWORD) or DATABASE_URL',
        path: ['DB_HOST'],
      })
    }
  })

const parsed = envSchema.parse(process.env)

export const env = {
  ...parsed,
  /** True when using embedded PGlite instead of real Postgres */
  usePglite:
    parsed.USE_PGLITE === '1' ||
    Boolean(parsed.DATABASE_URL?.startsWith('pglite:')) ||
    Boolean(parsed.DATABASE_URL?.startsWith('file:')),
}

export function getPgConfig() {
  if (env.DATABASE_URL && !env.usePglite) {
    return { connectionString: env.DATABASE_URL }
  }
  return {
    host: env.DB_HOST!,
    port: env.DB_PORT,
    user: env.DB_USERNAME!,
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME!,
  }
}

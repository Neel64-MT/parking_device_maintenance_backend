import 'dotenv/config'
import { z } from 'zod'

/** Strip accidental surrounding quotes from .env values. */
function unquote(value: string | undefined) {
  if (value == null) return value
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

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
    /** Public app URL for reset links (defaults to FRONTEND_ORIGIN). */
    APP_URL: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    UPLOAD_DIR: z.string().default('uploads'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DEVICE_SYNC_BASE_URL: z
      .string()
      .default('https://v2smartpark.mtapps.in/api/v1/engineer/device-binding'),
    /** SmartPark Authorization token (Bearer). Required to run device sync. */
    DEVICE_SYNC_API_TOKEN: z.string().optional(),
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

const raw = {
  ...process.env,
  DB_HOST: unquote(process.env.DB_HOST),
  DB_USERNAME: unquote(process.env.DB_USERNAME),
  DB_PASSWORD: unquote(process.env.DB_PASSWORD),
  DB_NAME: unquote(process.env.DB_NAME),
  JWT_SECRET: unquote(process.env.JWT_SECRET),
  DATABASE_URL: unquote(process.env.DATABASE_URL),
  APP_URL: unquote(process.env.APP_URL),
  SMTP_HOST: unquote(process.env.SMTP_HOST),
  SMTP_USER: unquote(process.env.SMTP_USER),
  SMTP_PASS: unquote(process.env.SMTP_PASS),
  MAIL_FROM: unquote(process.env.MAIL_FROM),
  DEVICE_SYNC_BASE_URL: unquote(process.env.DEVICE_SYNC_BASE_URL),
  DEVICE_SYNC_API_TOKEN: unquote(process.env.DEVICE_SYNC_API_TOKEN),
}

const parsed = envSchema.parse(raw)

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

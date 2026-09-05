import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { env } from '../config/env.js'
import { query } from '../db/pool.js'

const BCRYPT_ROUNDS = 10
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

/** Shared password rule for create user, admin patch, and reset. */
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters')

export async function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, passwordHash: string) {
  if (!passwordHash) return false
  return bcrypt.compare(password, passwordHash)
}

export function normalizeMobile(value: string) {
  return value.replace(/[\s\-()]/g, '')
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

export function isEmailIdentifier(value: string) {
  return value.includes('@')
}

export function omitPasswordHash<T extends Record<string, unknown>>(row: T) {
  const { password_hash: _passwordHash, ...rest } = row
  return rest
}

export function signAccessToken(userId: string, jti?: string, passwordVersion = 0) {
  const id = jti || crypto.randomUUID()
  const token = jwt.sign({ sub: userId, jti: id, pv: passwordVersion }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
  return { token, jti: id }
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as {
    sub: string
    jti: string
    exp: number
    iat: number
    pv?: number
  }
}

export async function isTokenDenied(jti: string) {
  const result = await query('SELECT jti FROM token_denylist WHERE jti = $1', [jti])
  return (result.rowCount ?? 0) > 0
}

export async function denyToken(jti: string, expiresAt: Date) {
  await query(
    `INSERT INTO token_denylist (jti, expires_at) VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt.toISOString()],
  )
}

export function initialsFromName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '??'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function hashResetToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

export function createRawResetToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** Invalidate unused tokens and create a new one. Returns raw token (never persist/log casually). */
export async function issuePasswordResetToken(userId: string) {
  await query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  )
  const rawToken = createRawResetToken()
  const tokenHash = hashResetToken(rawToken)
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS)
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt.toISOString()],
  )
  return rawToken
}

export async function consumePasswordResetToken(rawToken: string) {
  const tokenHash = hashResetToken(rawToken)
  const result = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash],
  )
  return result.rows[0] || null
}

export async function markPasswordResetTokenUsed(tokenId: string) {
  await query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [tokenId])
}

export async function invalidatePasswordResetTokensForUser(userId: string) {
  await query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  )
}

export async function markPasswordChanged(userId: string) {
  await query(
    `UPDATE users SET
       password_changed_at = NOW(),
       password_version = COALESCE(password_version, 0) + 1,
       updated_at = NOW()
     WHERE id = $1`,
    [userId],
  )
  await invalidatePasswordResetTokensForUser(userId)
}

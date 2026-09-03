import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { query } from '../db/pool.js'

const BCRYPT_ROUNDS = 10

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

export function signAccessToken(userId: string, jti?: string) {
  const id = jti || crypto.randomUUID()
  const token = jwt.sign({ sub: userId, jti: id }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
  return { token, jti: id }
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string; jti: string; exp: number }
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

import pg from 'pg'
import { PGlite } from '@electric-sql/pglite'
import { env, getPgConfig } from '../config/env.js'

type QueryResult<T> = { rows: T[]; rowCount: number | null }

export type DbClient = {
  query: <T = any>(
    text: string,
    params?: unknown[],
  ) => Promise<QueryResult<T>>
}

let pglite: PGlite | null = null
let pool: pg.Pool | null = null

async function getPglite() {
  if (!pglite) {
    const path =
      env.DATABASE_URL?.replace(/^pglite:/, '').replace(/^file:/, '') || './data/pdm'
    pglite = new PGlite(path)
    await pglite.waitReady
  }
  return pglite
}

function getPool() {
  if (!pool) {
    pool = new pg.Pool(getPgConfig())
  }
  return pool
}

export async function query<T = any>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  if (env.usePglite) {
    const db = await getPglite()
    const result = await db.query<T>(text, params as never[])
    return { rows: result.rows as T[], rowCount: result.rows.length }
  }
  const result = await getPool().query(text, params)
  return { rows: result.rows as T[], rowCount: result.rowCount }
}

/** Run multi-statement SQL (migrations). */
export async function execSql(sql: string) {
  if (env.usePglite) {
    const db = await getPglite()
    await db.exec(sql)
    return
  }
  await getPool().query(sql)
}

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  if (env.usePglite) {
    const db = await getPglite()
    await db.query('BEGIN')
    try {
      const client: DbClient = {
        query: async (text, params) => {
          const result = await db.query(text, params as never[])
          return { rows: result.rows as never[], rowCount: result.rows.length }
        },
      }
      const out = await fn(client)
      await db.query('COMMIT')
      return out
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    }
  }

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const wrapped: DbClient = {
      query: async (text, params) => {
        const result = await client.query(text, params)
        return { rows: result.rows as never[], rowCount: result.rowCount }
      },
    }
    const out = await fn(wrapped)
    await client.query('COMMIT')
    return out
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closeDb() {
  if (pglite) {
    await pglite.close()
    pglite = null
  }
  if (pool) {
    await pool.end()
    pool = null
  }
}

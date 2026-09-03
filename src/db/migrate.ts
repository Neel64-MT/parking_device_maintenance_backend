import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, execSql, query } from './pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const dir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

  for (const file of files) {
    const id = file
    const existing = await query<{ id: string }>(
      'SELECT id FROM schema_migrations WHERE id = $1',
      [id],
    )
    if (existing.rowCount) {
      console.log(`skip ${id}`)
      continue
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    await execSql(sql)
    await query('INSERT INTO schema_migrations (id) VALUES ($1)', [id])
    console.log(`applied ${id}`)
  }

  await closeDb()
  console.log('Migrations complete')
}

migrate().catch((err) => {
  console.error(err)
  process.exit(1)
})

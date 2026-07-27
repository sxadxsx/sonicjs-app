/**
 * SonicJS Application (v3)
 *
 * Entry point for your SonicJS headless CMS on Cloudflare Workers.
 */

import { createSonicJSApp, registerCollections } from '@sonicjs-cms/core'
import type { SonicJSConfig } from '@sonicjs-cms/core'

import blogPostsCollection from './collections/blog-posts.collection'
import { CORE_MIGRATIONS } from './db/core-migrations'

// Register collections BEFORE creating the app
registerCollections([
  blogPostsCollection,
  // Add more collections here as you create them
])

const config: SonicJSConfig = {
  name: 'sonicjs-app',
  plugins: {
    // directory/autoLoad are no-ops on Workers; register plugins explicitly if needed
    register: []
  }
}

const app = createSonicJSApp(config)

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (!inSingle && !inDouble) {
      if (ch === '-' && next === '-') {
        inLineComment = true
        i++
        continue
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true
        i++
        continue
      }
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      current += ch
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      current += ch
      continue
    }
    if (ch === ';' && !inSingle && !inDouble) {
      const stmt = current.trim()
      if (stmt) statements.push(stmt)
      current = ''
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements
}


/**
 * One-shot bootstrap endpoint to apply core SQL migrations when the Cloudflare
 * API token lacks D1 permissions for `wrangler d1 migrations apply`.
 *
 * POST /_setup/migrate
 * Header: x-setup-secret: <JWT_SECRET or BETTER_AUTH_SECRET>
 */
app.post('/_setup/migrate', async (c) => {
  const secret = c.req.header('x-setup-secret')
  const expected =
    (c.env as any).MIGRATION_SECRET || c.env.JWT_SECRET || c.env.BETTER_AUTH_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const db = c.env.DB
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run()

  const applied: string[] = []
  const skipped: string[] = []
  const errors: Array<{ name: string; error: string }> = []

  for (const migration of CORE_MIGRATIONS) {
    const existing = await db
      .prepare('SELECT name FROM d1_migrations WHERE name = ?')
      .bind(migration.name)
      .first()

    if (existing) {
      skipped.push(migration.name)
      continue
    }

    try {
      const statements = splitSqlStatements(migration.sql)
      for (const statement of statements) {
        await db.prepare(statement).run()
      }
      await db
        .prepare('INSERT INTO d1_migrations (name) VALUES (?)')
        .bind(migration.name)
        .run()
      applied.push(migration.name)
    } catch (err) {
      errors.push({
        name: migration.name,
        error: err instanceof Error ? err.message : String(err)
      })
      break
    }
  }

  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()

  return c.json({
    success: errors.length === 0,
    applied,
    skipped,
    errors,
    tables: (tables.results || []).map((r: any) => r.name)
  })
})

app.get('/_setup/status', async (c) => {
  const secret = c.req.header('x-setup-secret')
  const expected =
    (c.env as any).MIGRATION_SECRET || c.env.JWT_SECRET || c.env.BETTER_AUTH_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const tables = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all()
    let migrations: any[] = []
    try {
      const rows = await c.env.DB.prepare(
        'SELECT name, applied_at FROM d1_migrations ORDER BY id'
      ).all()
      migrations = rows.results || []
    } catch {
      migrations = []
    }
    return c.json({
      ok: true,
      tables: (tables.results || []).map((r: any) => r.name),
      migrations
    })
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }, 500)
  }
})

export default app

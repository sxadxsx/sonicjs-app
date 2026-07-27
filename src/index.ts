/**
 * SonicJS Application (v3)
 *
 * Entry point for your SonicJS headless CMS on Cloudflare Workers.
 */

import { createSonicJSApp, registerCollections } from '@sonicjs-cms/core'
import type { SonicJSConfig } from '@sonicjs-cms/core'

import blogPostsCollection from './collections/blog-posts.collection'
import { CORE_MIGRATIONS } from './db/core-migrations'
import { migrateV2ToV3 } from './setup/v2-to-v3-migrate'

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

    const count = async (sql: string) => {
      try {
        const row = await c.env.DB.prepare(sql).first<{ c: number }>()
        return Number(row?.c ?? 0)
      } catch {
        return null
      }
    }

    return c.json({
      ok: true,
      tables: (tables.results || []).map((r: any) => r.name),
      migrations,
      data: {
        v2_users: await count('SELECT COUNT(*) AS c FROM users'),
        v2_content: await count('SELECT COUNT(*) AS c FROM content'),
        v2_media: await count('SELECT COUNT(*) AS c FROM media'),
        v2_collections: await count('SELECT COUNT(*) AS c FROM collections'),
        v3_auth_user: await count('SELECT COUNT(*) AS c FROM auth_user'),
        v3_documents: await count('SELECT COUNT(*) AS c FROM documents'),
        v3_document_types: await count('SELECT COUNT(*) AS c FROM document_types'),
        v3_media_assets: await count(
          "SELECT COUNT(*) AS c FROM documents WHERE type_id = 'media_asset' AND deleted_at IS NULL"
        )
      }
    })
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }, 500)
  }
})

/**
 * Migrate legacy v2 rows into the v3 auth/document model.
 *
 * POST /_setup/migrate-data?dryRun=1
 * POST /_setup/migrate-data          (apply)
 * Header: x-setup-secret: <MIGRATION_SECRET>
 */
app.post('/_setup/migrate-data', async (c) => {
  const secret = c.req.header('x-setup-secret')
  const expected =
    (c.env as any).MIGRATION_SECRET || c.env.JWT_SECRET || c.env.BETTER_AUTH_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const url = new URL(c.req.url)
  const dryRun =
    url.searchParams.get('dryRun') === '1' ||
    url.searchParams.get('dry_run') === '1' ||
    c.req.query('dryRun') === 'true'
  const force =
    url.searchParams.get('force') === '1' || c.req.query('force') === 'true'

  try {
    const report = await migrateV2ToV3(c.env.DB, { dryRun, force })
    return c.json({
      success:
        report.users.errors.length +
          report.collections.errors.length +
          report.content.errors.length +
          report.media.errors.length ===
        0,
      report
    })
  } catch (err) {
    return c.json({
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }, 500)
  }
})


app.get('/_setup/inspect-v2', async (c) => {
  const secret = c.req.header('x-setup-secret')
  const expected =
    (c.env as any).MIGRATION_SECRET || c.env.JWT_SECRET || c.env.BETTER_AUTH_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const content = await c.env.DB.prepare(
    'SELECT id, title, slug, status, typeof(status) as status_type, collection_id, published_at, created_at FROM content'
  ).all()
  const users = await c.env.DB.prepare(
    'SELECT id, email, role, length(password_hash) as pw_len, substr(password_hash,1,20) as pw_prefix FROM users'
  ).all()
  const cols = await c.env.DB.prepare(
    'SELECT id, name, display_name, is_active FROM collections'
  ).all()
  const existingDocs = await c.env.DB.prepare(
    "SELECT id, type_id, status, title, slug FROM documents WHERE type_id NOT IN ('plugin','rbac_role','rbac_verb','rbac_user_roles','site_settings','tenant','media_asset','user_profile') OR type_id IN ('blog_post','pages','news','blogcms','blog-posts','form_contact')"
  ).all()
  const allTypes = await c.env.DB.prepare(
    'SELECT id, name, display_name FROM document_types ORDER BY name'
  ).all()
  return c.json({
    content: content.results,
    users: users.results,
    collections: cols.results,
    contentLikeDocs: existingDocs.results,
    migratedContentDocs: (await c.env.DB.prepare(
      "SELECT id, root_id, type_id, status, is_published, is_current_draft, deleted_at, title, slug FROM documents WHERE id IN (SELECT id FROM content) OR root_id IN (SELECT id FROM content)"
    ).all()).results,
    blogDocs: (await c.env.DB.prepare(
      "SELECT id, type_id, status, is_published, deleted_at, title, slug FROM documents WHERE type_id = 'blog_post'"
    ).all()).results,
    documentTypes: allTypes.results
  })
})


app.post('/_setup/repair-type-ids', async (c) => {
  const secret = c.req.header('x-setup-secret')
  const expected =
    (c.env as any).MIGRATION_SECRET || c.env.JWT_SECRET || c.env.BETTER_AUTH_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const before = await c.env.DB.prepare(
    "SELECT id, type_id, status, deleted_at, title FROM documents WHERE id IN (SELECT id FROM content)"
  ).all()
  await c.env.DB.prepare(
    `UPDATE documents
     SET type_id = 'blog_post'
     WHERE type_id IN ('blogcms', 'blog-posts', 'blog_posts', 'blog', 'posts')`
  ).run()
  // Ensure published rows are visible
  await c.env.DB.prepare(
    `UPDATE documents
     SET status = 'published', is_published = 1, deleted_at = NULL, is_current_draft = 1
     WHERE id IN (SELECT id FROM content WHERE status = 'published')`
  ).run()
  // Map deleted content to archived + deleted_at
  await c.env.DB.prepare(
    `UPDATE documents
     SET status = 'archived', is_published = 0,
         deleted_at = COALESCE(deleted_at, updated_at)
     WHERE id IN (SELECT id FROM content WHERE status = 'deleted')`
  ).run()
  const after = await c.env.DB.prepare(
    "SELECT id, type_id, status, is_published, deleted_at, title, slug FROM documents WHERE id IN (SELECT id FROM content)"
  ).all()
  return c.json({ before: before.results, after: after.results })
})

export default app

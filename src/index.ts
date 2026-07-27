/**
 * SonicJS Application (v3)
 *
 * Entry point for your SonicJS headless CMS on Cloudflare Workers.
 */

// Disable SonicJS product telemetry before core bootstrap runs.
// Core reads process.env (not Worker bindings) via safeGetEnv().
;(() => {
  const g = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }
  if (!g.process) g.process = { env: {} }
  if (!g.process.env) g.process.env = {}
  g.process.env.SONICJS_TELEMETRY = 'false'
  g.process.env.DO_NOT_TRACK = '1'
})()

import { createSonicJSApp, registerCollections } from '@sonicjs-cms/core'
import type { SonicJSConfig } from '@sonicjs-cms/core'

import blogcmsCollection from './collections/blogcms.collection'
import { CORE_MIGRATIONS } from './db/core-migrations'
import { migrateV2ToV3 } from './setup/v2-to-v3-migrate'

// Register collections BEFORE creating the app
registerCollections([
  blogcmsCollection,
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
      "SELECT id, type_id, status, is_published, deleted_at, title, slug FROM documents WHERE type_id = 'blogcms'"
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
     SET type_id = 'blogcms'
     WHERE type_id IN ('blog_post', 'blog-posts', 'blog_posts', 'blog', 'posts')`
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


/**
 * Reset a user's password to a Better Auth–compatible scrypt hash.
 *
 * POST /_setup/reset-password
 * Header: x-setup-secret
 * JSON body: { "email": "...", "password": "..." }
 *   or { "email": "...", "hash": "salt:key" }
 */
app.post('/_setup/reset-password', async (c) => {
  const secret = c.req.header('x-setup-secret')
  const expected =
    (c.env as any).MIGRATION_SECRET || c.env.JWT_SECRET || c.env.BETTER_AUTH_SECRET
  if (!expected || secret !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const email = String(body.email || '').toLowerCase().trim()
  if (!email) return c.json({ error: 'email required' }, 400)

  let passwordHash = body.hash ? String(body.hash) : ''
  if (!passwordHash) {
    const password = String(body.password || '')
    if (password.length < 8) {
      return c.json({ error: 'password must be at least 8 chars (or pass hash)' }, 400)
    }
    // Prefer Better Auth scrypt via dynamic import when available in the isolate.
    try {
      const mod = await import('@better-auth/utils/password')
      passwordHash = await mod.hashPassword(password)
    } catch {
      // Fallback: SonicJS AuthManager PBKDF2 (works for AuthManager paths, not BA sign-in)
      const { AuthManager } = await import('@sonicjs-cms/core')
      passwordHash = await AuthManager.hashPassword(password)
    }
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, role FROM auth_user WHERE email = ?'
  ).bind(email).first<any>()

  if (!user) {
    return c.json({ error: `user not found: ${email}` }, 404)
  }

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    `UPDATE auth_user
     SET password_hash = ?, is_active = 1, failed_login_count = 0, locked_until = NULL, updated_at = ?
     WHERE id = ?`
  ).bind(passwordHash, now, user.id).run()

  const cred = await c.env.DB.prepare(
    "SELECT id FROM auth_account WHERE user_id = ? AND provider_id = 'credential'"
  ).bind(user.id).first<any>()

  if (cred) {
    await c.env.DB.prepare(
      `UPDATE auth_account
       SET password = ?, account_id = ?, updated_at = ?
       WHERE id = ?`
    ).bind(passwordHash, user.id, now, cred.id).run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO auth_account (id, user_id, account_id, provider_id, password, created_at, updated_at)
       VALUES (?, ?, ?, 'credential', ?, ?, ?)`
    ).bind(`cred-${user.id}`, user.id, user.id, passwordHash, now, now).run()
  }

  // Ensure admin role stays admin if requested
  let rbac: string | null = null
  if (body.makeAdmin !== false) {
    await c.env.DB.prepare(
      `UPDATE auth_user SET role = 'admin', is_super_admin = 1, updated_at = ? WHERE id = ?`
    ).bind(now, user.id).run()
    try {
      const { RbacService } = await import('@sonicjs-cms/core')
      const rbacSvc = new RbacService(c.env.DB, c.env.CACHE_KV)
      // Seed system roles/grants if missing, then attach admin role to this user
      if (typeof (rbacSvc as any).ensureSystemRbacSeed === 'function') {
        await (rbacSvc as any).ensureSystemRbacSeed()
      }
      await rbacSvc.addUserRoleByName(String(user.id), 'admin')
      // Clear cached empty perms if any
      try {
        await c.env.CACHE_KV.delete(`rbac:perms:${user.id}`)
      } catch {}
      rbac = 'admin'
    } catch (err) {
      rbac = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const refreshed = await c.env.DB.prepare(
    'SELECT id, email, role, is_super_admin FROM auth_user WHERE id = ?'
  ).bind(user.id).first<any>()

  return c.json({
    success: true,
    user: {
      id: refreshed?.id || user.id,
      email: refreshed?.email || user.email,
      role: refreshed?.role || user.role,
      isSuperAdmin: refreshed?.is_super_admin
    },
    rbac,
    hashPrefix: passwordHash.slice(0, 24),
    hashFormat: passwordHash.includes(':') && !passwordHash.startsWith('pbkdf2:')
      ? 'better-auth-scrypt'
      : passwordHash.startsWith('pbkdf2:')
        ? 'pbkdf2'
        : 'unknown'
  })
})


export default app

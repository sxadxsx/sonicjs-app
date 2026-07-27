/**
 * One-shot V2 → V3 data migration for SonicJS.
 *
 * Migrates:
 * - users          → auth_user + auth_account (credential)
 * - content        → documents (type_id from collection name)
 * - media          → documents (type_id = media_asset)
 * - collections    → document_types (for types not already seeded)
 *
 * Idempotent: skips rows that already exist in the destination tables.
 * Does NOT delete or modify v2 source tables.
 */

type D1 = D1Database

export type MigrateOptions = {
  dryRun?: boolean
  /** Force re-write of existing destination rows (still keeps same IDs). */
  force?: boolean
}

export type MigrateReport = {
  dryRun: boolean
  counts: Record<string, number>
  users: { migrated: number; skipped: number; errors: string[] }
  collections: { migrated: number; skipped: number; errors: string[] }
  content: { migrated: number; skipped: number; errors: string[] }
  media: { migrated: number; skipped: number; errors: string[] }
  notes: string[]
}

function toSeconds(ts: unknown): number | null {
  if (ts == null || ts === '') return null
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return null
  // Heuristic: ms timestamps are > year 2001 in ms (~1e12)
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function normalizeStatus(raw: unknown): 'draft' | 'published' | 'archived' {
  const s = String(raw ?? 'draft').toLowerCase().trim()
  if (s === 'published' || s === 'publish' || s === 'live' || s === 'public') return 'published'
  if (s === 'archived' || s === 'archive' || s === 'deleted' || s === 'trash') return 'archived'
  // draft / pending / review / scheduled / empty / unknown → draft
  return 'draft'
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function parseJson<T = any>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

/** Map v2 collection machine names onto v3 document type ids. */
function mapCollectionToTypeId(name: string): string {
  const n = (name || '').trim().toLowerCase()
  if (!n) return 'unknown'
  // Map common v2 blog-ish collections onto the built-in v3 blog_post type so
  // /api/content (which only lists code-registered collections) can see them.
  if (
    n === 'blog_posts' ||
    n === 'blog-posts' ||
    n === 'blogposts' ||
    n === 'blog' ||
    n === 'blog_post' ||
    n === 'blogcms' ||
    n === 'blog-cms' ||
    n === 'posts'
  ) {
    return 'blog_post'
  }
  // Prefer snake_case type ids
  return n.replace(/-/g, '_').replace(/\s+/g, '_')
}

async function tableExists(db: D1, name: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .bind(name)
    .first()
  return !!row
}

async function count(db: D1, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(...binds).first<{ c: number }>()
    return Number(row?.c ?? 0)
  } catch {
    return 0
  }
}

async function ensureDocumentType(
  db: D1,
  typeId: string,
  displayName: string,
  description: string | null,
  schema: unknown,
  dryRun: boolean
): Promise<'created' | 'exists' | 'would_create'> {
  const existing = await db
    .prepare('SELECT id FROM document_types WHERE id = ? OR name = ?')
    .bind(typeId, typeId)
    .first()
  if (existing) return 'exists'
  if (dryRun) return 'would_create'

  const ts = nowSec()
  await db
    .prepare(
      `INSERT INTO document_types (
        id, name, display_name, description, schema, queryable_fields, settings,
        plugin_id, source, schema_version, is_system, is_active, is_auth, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '[]', ?, NULL, 'system', 1, 0, 1, 0, ?, ?)`
    )
    .bind(
      typeId,
      typeId,
      displayName || typeId,
      description,
      JSON.stringify(schema ?? { type: 'object', properties: {} }),
      JSON.stringify({
        versioning: true,
        maxVersionsPerRoot: 50,
        baseGrants: {
          public: ['read'],
          admin: ['read', 'create', 'update', 'delete', 'publish', 'manage'],
          editor: ['read', 'create', 'update', 'publish'],
          viewer: ['read']
        }
      }),
      ts,
      ts
    )
    .run()
  return 'created'
}

export async function migrateV2ToV3(db: D1, opts: MigrateOptions = {}): Promise<MigrateReport> {
  const dryRun = !!opts.dryRun
  const force = !!opts.force
  const notes: string[] = []

  const report: MigrateReport = {
    dryRun,
    counts: {},
    users: { migrated: 0, skipped: 0, errors: [] },
    collections: { migrated: 0, skipped: 0, errors: [] },
    content: { migrated: 0, skipped: 0, errors: [] },
    media: { migrated: 0, skipped: 0, errors: [] },
    notes
  }

  // Source presence
  const hasUsers = await tableExists(db, 'users')
  const hasContent = await tableExists(db, 'content')
  const hasCollections = await tableExists(db, 'collections')
  const hasMedia = await tableExists(db, 'media')
  const hasAuthUser = await tableExists(db, 'auth_user')
  const hasDocuments = await tableExists(db, 'documents')
  const hasDocumentTypes = await tableExists(db, 'document_types')

  if (!hasAuthUser || !hasDocuments || !hasDocumentTypes) {
    notes.push('v3 tables missing — run POST /_setup/migrate first')
    return report
  }

  report.counts = {
    v2_users: hasUsers ? await count(db, 'SELECT COUNT(*) AS c FROM users') : 0,
    v2_content: hasContent ? await count(db, 'SELECT COUNT(*) AS c FROM content') : 0,
    v2_collections: hasCollections ? await count(db, 'SELECT COUNT(*) AS c FROM collections') : 0,
    v2_media: hasMedia ? await count(db, 'SELECT COUNT(*) AS c FROM media') : 0,
    v3_auth_user: await count(db, 'SELECT COUNT(*) AS c FROM auth_user'),
    v3_documents: await count(db, 'SELECT COUNT(*) AS c FROM documents'),
    v3_document_types: await count(db, 'SELECT COUNT(*) AS c FROM document_types'),
    v3_media_assets: await count(
      db,
      "SELECT COUNT(*) AS c FROM documents WHERE type_id = 'media_asset' AND deleted_at IS NULL"
    )
  }

  // ── Users ───────────────────────────────────────────────────────────────
  if (hasUsers) {
    const { results: users } = await db.prepare('SELECT * FROM users').all<any>()
    for (const u of users || []) {
      try {
        const id = String(u.id)
        const email = String(u.email || '').toLowerCase().trim()
        if (!email) {
          report.users.errors.push(`user ${id}: missing email`)
          continue
        }

        const existing = await db
          .prepare('SELECT id FROM auth_user WHERE id = ? OR email = ?')
          .bind(id, email)
          .first()

        if (existing && !force) {
          report.users.skipped++
          // Still ensure credential account exists if password present
          if (u.password_hash && !dryRun) {
            const cred = await db
              .prepare(
                "SELECT id FROM auth_account WHERE user_id = ? AND provider_id = 'credential'"
              )
              .bind(existing.id || id)
              .first()
            if (!cred) {
              const ts = nowSec()
              const uid = String(existing.id || id)
              await db
                .prepare(
                  `INSERT OR IGNORE INTO auth_account
                    (id, user_id, account_id, provider_id, password, created_at, updated_at)
                   VALUES (?, ?, ?, 'credential', ?, ?, ?)`
                )
                .bind(`cred-${uid}`, uid, uid, u.password_hash, ts, ts)
                .run()
            }
          }
          continue
        }

        if (dryRun) {
          report.users.migrated++
          continue
        }

        const createdAt = toSeconds(u.created_at) ?? nowSec()
        const updatedAt = toSeconds(u.updated_at) ?? createdAt
        const first = u.first_name || u.firstName || email.split('@')[0] || 'User'
        const last = u.last_name || u.lastName || ''
        const name = [first, last].filter(Boolean).join(' ').trim() || email
        const role = u.role || 'viewer'
        const isActive = u.is_active == null ? 1 : Number(u.is_active) ? 1 : 0
        const isSuper = role === 'admin' ? 1 : 0

        if (existing && force) {
          await db
            .prepare(
              `UPDATE auth_user SET
                name = ?, email = ?, first_name = ?, last_name = ?, role = ?,
                avatar = ?, password_hash = ?, is_active = ?, is_super_admin = ?,
                last_login_at = ?, updated_at = ?
               WHERE id = ?`
            )
            .bind(
              name,
              email,
              first,
              last,
              role,
              u.avatar ?? null,
              u.password_hash ?? null,
              isActive,
              isSuper,
              toSeconds(u.last_login_at),
              updatedAt,
              id
            )
            .run()
        } else {
          await db
            .prepare(
              `INSERT INTO auth_user (
                id, name, email, email_verified, image, created_at, updated_at,
                first_name, last_name, role, is_super_admin, avatar, password_hash,
                is_active, last_login_at, failed_login_count, two_factor_enabled
              ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
            )
            .bind(
              id,
              name,
              email,
              u.avatar ?? null,
              createdAt,
              updatedAt,
              first,
              last,
              role,
              isSuper,
              u.avatar ?? null,
              u.password_hash ?? null,
              isActive,
              toSeconds(u.last_login_at)
            )
            .run()
        }

        if (u.password_hash) {
          await db
            .prepare(
              `INSERT OR REPLACE INTO auth_account
                (id, user_id, account_id, provider_id, password, created_at, updated_at)
               VALUES (?, ?, ?, 'credential', ?, ?, ?)`
            )
            .bind(`cred-${id}`, id, id, u.password_hash, createdAt, updatedAt)
            .run()
        }

        report.users.migrated++
      } catch (err) {
        report.users.errors.push(
          `user ${u?.id}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    notes.push(
      'Passwords are copied as-is into auth_account. If v2 used a different hash format than Better Auth (scrypt salt:key), users may need to reset passwords.'
    )
  } else {
    notes.push('v2 users table not found — skipped user migration')
  }

  // ── Collections → document_types ────────────────────────────────────────
  const typeIdByCollectionId = new Map<string, string>()
  if (hasCollections) {
    const { results: cols } = await db.prepare('SELECT * FROM collections').all<any>()
    for (const col of cols || []) {
      try {
        const typeId = mapCollectionToTypeId(col.name)
        typeIdByCollectionId.set(String(col.id), typeId)
        const schema = parseJson(col.schema, { type: 'object', properties: {} })
        const result = await ensureDocumentType(
          db,
          typeId,
          col.display_name || col.name,
          col.description ?? null,
          schema,
          dryRun
        )
        if (result === 'exists') report.collections.skipped++
        else report.collections.migrated++
      } catch (err) {
        report.collections.errors.push(
          `collection ${col?.name}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  // Always ensure media_asset + blog_post exist (bootstrap usually creates them)
  await ensureDocumentType(
    db,
    'media_asset',
    'Media Asset',
    'Uploaded media file',
    { type: 'object', properties: {} },
    dryRun
  )
  await ensureDocumentType(
    db,
    'blog_post',
    'Blog Post',
    'Blog post',
    { type: 'object', properties: {} },
    dryRun
  )

  // ── Content → documents ─────────────────────────────────────────────────
  if (hasContent) {
    const { results: rows } = await db
      .prepare(
        `SELECT c.*, col.name AS collection_name, col.id AS col_id
         FROM content c
         LEFT JOIN collections col ON col.id = c.collection_id`
      )
      .all<any>()

    for (const row of rows || []) {
      try {
        const id = String(row.id)
        const typeId = mapCollectionToTypeId(
          row.collection_name ||
            typeIdByCollectionId.get(String(row.collection_id)) ||
            'content'
        )

        // Ensure type exists even if collection row missing
        await ensureDocumentType(
          db,
          typeId,
          row.collection_name || typeId,
          null,
          { type: 'object', properties: {} },
          dryRun
        )

        const existing = await db
          .prepare('SELECT id FROM documents WHERE id = ? OR root_id = ?')
          .bind(id, id)
          .first()

        if (existing && !force) {
          report.content.skipped++
          continue
        }

        if (dryRun) {
          report.content.migrated++
          continue
        }

        const data = parseJson<Record<string, unknown>>(row.data, {})
        // Promote common fields into data if only top-level in v2
        if (row.title && data.title == null) data.title = row.title
        if (row.slug && data.slug == null) data.slug = row.slug

        const createdAt = toSeconds(row.created_at) ?? nowSec()
        const updatedAt = toSeconds(row.updated_at) ?? createdAt
        const publishedAt = toSeconds(row.published_at)
        const rawStatus = String(row.status ?? '')
        const status = normalizeStatus(rawStatus)
        // v3 CHECK only allows draft|published|archived
        const statusValue: 'draft' | 'published' | 'archived' =
          status === 'published' ? 'published' : status === 'archived' ? 'archived' : 'draft'
        const isPublished = statusValue === 'published' ? 1 : 0
        const deletedAt =
          String(rawStatus).toLowerCase() === 'deleted' || statusValue === 'archived'
            ? updatedAt
            : null

        if (existing && force) {
          await db
            .prepare(
              `UPDATE documents SET
                type_id = ?, status = ?, is_published = ?, slug = ?, title = ?,
                published_at = ?, data = ?, owner_id = ?, created_by = ?, updated_by = ?,
                created_at = ?, updated_at = ?, deleted_at = ?
               WHERE id = ?`
            )
            .bind(
              typeId,
              statusValue,
              isPublished,
              row.slug ?? null,
              row.title ?? null,
              isPublished ? publishedAt ?? createdAt : null,
              JSON.stringify(data),
              row.author_id ?? null,
              row.author_id ?? null,
              row.author_id ?? null,
              createdAt,
              updatedAt,
              deletedAt,
              id
            )
            .run()
        } else {
          // Use named-order plain inserts; bind is_published as integer and status as text explicitly.
          await db
            .prepare(
              `INSERT INTO documents (
                id, root_id, type_id, type_version, version_of_id, version_number,
                is_current_draft, is_published, status, parent_root_id, slug, path, title, zone,
                sort_order, visible, published_at, scheduled_at, expires_at, deleted_at,
                tenant_id, locale, translation_group_id, data, metadata,
                owner_id, created_by, updated_by, created_at, updated_at
              ) VALUES (
                ?1, ?2, ?3, 1, NULL, 1,
                1, ?4, ?5, '', ?6, NULL, ?7, NULL,
                0, 1, ?8, NULL, NULL, ?9,
                'default', 'default', '', ?10, '{}',
                ?11, ?12, ?13, ?14, ?15
              )`
            )
            .bind(
              id, //1
              id, //2
              typeId, //3
              isPublished, //4
              statusValue, //5
              row.slug ?? null, //6
              row.title ?? null, //7
              isPublished ? publishedAt ?? createdAt : null, //8
              deletedAt, //9
              JSON.stringify(data), //10
              row.author_id ?? null, //11
              row.author_id ?? null, //12
              row.author_id ?? null, //13
              createdAt, //14
              updatedAt //15
            )
            .run()
        }

        report.content.migrated++
      } catch (err) {
        report.content.errors.push(
          `content ${row?.id}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  } else {
    notes.push('v2 content table not found — skipped content migration')
  }

  // Repair earlier migrations that used raw collection names instead of blog_post
  if (!dryRun) {
    try {
      await db
        .prepare(
          `UPDATE documents
           SET type_id = 'blog_post'
           WHERE type_id IN ('blogcms', 'blog-posts', 'blog_posts', 'blog', 'posts')`
        )
        .run()
      notes.push("Repaired type_id aliases → blog_post where needed")
    } catch (err) {
      notes.push(`type_id repair skipped: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Media → media_asset documents ───────────────────────────────────────
  if (hasMedia) {
    let files: any[] = []
    try {
      const res = await db.prepare('SELECT * FROM media').all<any>()
      files = (res.results || []).filter((m) => !m.deleted_at)
    } catch (err) {
      report.media.errors.push(`media list failed: ${err instanceof Error ? err.message : String(err)}`)
      files = []
    }

    for (const m of files || []) {
      try {
        const id = String(m.id)
        const existing = await db
          .prepare(
            "SELECT id FROM documents WHERE (id = ? OR root_id = ?) AND type_id = 'media_asset'"
          )
          .bind(id, id)
          .first()

        if (existing && !force) {
          report.media.skipped++
          continue
        }
        if (dryRun) {
          report.media.migrated++
          continue
        }

        const createdAt = toSeconds(m.uploaded_at) ?? toSeconds(m.created_at) ?? nowSec()
        const updatedAt = toSeconds(m.updated_at) ?? createdAt
        const data = {
          filename: m.filename,
          originalName: m.original_name || m.filename,
          mimeType: m.mime_type,
          size: Number(m.size || 0),
          width: m.width ?? null,
          height: m.height ?? null,
          folder: m.folder || 'uploads',
          r2Key: m.r2_key,
          publicUrl: m.public_url ?? null,
          thumbnailUrl: m.thumbnail_url ?? null,
          alt: m.alt ?? '',
          caption: m.caption ?? '',
          tags: parseJson(m.tags, [])
        }

        if (existing && force) {
          await db
            .prepare(
              `UPDATE documents SET
                title = ?, data = ?, owner_id = ?, created_by = ?, updated_by = ?,
                created_at = ?, updated_at = ?, deleted_at = NULL, is_published = 1, status = 'published'
               WHERE id = ?`
            )
            .bind(
              data.originalName,
              JSON.stringify(data),
              m.uploaded_by ?? null,
              m.uploaded_by ?? null,
              m.uploaded_by ?? null,
              createdAt,
              updatedAt,
              id
            )
            .run()
        } else {
          await db
            .prepare(
              `INSERT INTO documents (
                id, root_id, type_id, type_version, version_of_id, version_number,
                is_current_draft, is_published, status, parent_root_id, slug, path, title, zone,
                sort_order, visible, published_at, scheduled_at, expires_at, deleted_at,
                tenant_id, locale, translation_group_id, data, metadata,
                owner_id, created_by, updated_by, created_at, updated_at
              ) VALUES (
                ?, ?, 'media_asset', 1, NULL, 1,
                1, 1, 'published', '', ?, NULL, ?, NULL,
                0, 1, ?, NULL, NULL, NULL,
                'default', 'default', '', ?, '{}',
                ?, ?, ?, ?, ?
              )`
            )
            .bind(
              id,
              id,
              m.filename ?? null,
              data.originalName,
              createdAt,
              JSON.stringify(data),
              m.uploaded_by ?? null,
              m.uploaded_by ?? null,
              m.uploaded_by ?? null,
              createdAt,
              updatedAt
            )
            .run()
        }

        report.media.migrated++
      } catch (err) {
        report.media.errors.push(
          `media ${m?.id}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  } else {
    notes.push('v2 media table not found — skipped media migration')
  }

  // Final counts
  report.counts.v3_auth_user_after = await count(db, 'SELECT COUNT(*) AS c FROM auth_user')
  report.counts.v3_documents_after = await count(db, 'SELECT COUNT(*) AS c FROM documents')
  report.counts.v3_media_assets_after = await count(
    db,
    "SELECT COUNT(*) AS c FROM documents WHERE type_id = 'media_asset' AND deleted_at IS NULL"
  )
  report.counts.v3_content_docs_after = await count(
    db,
    "SELECT COUNT(*) AS c FROM documents WHERE type_id != 'media_asset' AND deleted_at IS NULL"
  )

  notes.push(
    'v2 source tables were left intact. You can drop them later after verifying the admin UI and APIs.'
  )
  return report
}

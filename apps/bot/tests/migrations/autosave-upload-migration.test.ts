import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

describe('autosave multipart migration', () => {
  test('removes unrecoverable legacy rows before creating active-upload constraints', async () => {
    const sqlite = new Database(':memory:')
    try {
      await applyMigration(sqlite, '0021_autosave_uploads.sql')
      insertLegacyUpload(sqlite, 'uploaded-a', 'owner-1', 'uploaded', 101)
      insertLegacyUpload(sqlite, 'uploaded-b', 'owner-1', 'uploaded', 202)
      insertLegacyUpload(sqlite, 'pending-a', 'owner-1', 'pending_upload', 303)
      insertLegacyUpload(sqlite, 'pending-b', 'owner-1', 'pending_upload', 404)
      insertLegacyUpload(sqlite, 'failed-a', 'owner-2', 'upload_failed', 505)

      await applyMigration(sqlite, '0022_autosave_multipart_upload_id.sql')

      const rows = sqlite.prepare(`
        SELECT id, status, file_size_bytes AS fileSizeBytes
        FROM autosave_uploads
        ORDER BY id
      `).all() as Array<{ id: string, status: string, fileSizeBytes: number }>
      expect(rows).toEqual([
        { id: 'uploaded-a', status: 'uploaded', fileSizeBytes: 101 },
        { id: 'uploaded-b', status: 'uploaded', fileSizeBytes: 202 },
      ])

      insertCurrentUpload(sqlite, 'active-a', 'owner-1', 'pending_upload')
      expect(() => insertCurrentUpload(sqlite, 'active-b', 'owner-1', 'initializing')).toThrow(/unique constraint/i)
    }
    finally {
      sqlite.close()
    }
  })
})

async function applyMigration(sqlite: Database, fileName: string): Promise<void> {
  const migration = await Bun.file(new URL(`../../../../packages/db/migrations/${fileName}`, import.meta.url)).text()
  for (const statement of migration.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) sqlite.exec(sql)
  }
}

function insertLegacyUpload(sqlite: Database, id: string, userId: string, status: string, size: number): void {
  sqlite.prepare(`
    INSERT INTO autosave_uploads (
      id, uploaded_at, uploader_user_id, file_name, file_size_bytes, r2_key, status
    ) VALUES (?, 1, ?, ?, ?, ?, ?)
  `).run(id, userId, `${id}.zip`, size, `legacy/${id}`, status)
}

function insertCurrentUpload(sqlite: Database, id: string, userId: string, status: string): void {
  sqlite.prepare(`
    INSERT INTO autosave_uploads (
      id, uploaded_at, uploader_user_id, file_name, file_size_bytes, r2_key, status
    ) VALUES (?, 1, ?, ?, 1, ?, ?)
  `).run(id, userId, `${id}.zip`, `current/${id}`, status)
}

import type { CloudflareStorageSelection } from '../../../config/cloudflare-targets.ts'
import { createHash, createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCloudflareStorage } from '../../../config/cloudflare-targets.ts'

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url).href)

// Miniflare/workerd idFromName, shared by the pinned cf and Wrangler v3 persistence.
export function localObjectId(uniqueKey: string, name: string): string {
  const key = createHash('sha256').update(uniqueKey).digest()
  const nameHash = createHmac('sha256', key).update(name).digest().subarray(0, 16)
  const check = createHmac('sha256', key).update(nameHash).digest().subarray(0, 16)
  return Buffer.concat([nameHash, check]).toString('hex')
}

export function localResourcePaths(selection: CloudflareStorageSelection) {
  if (selection.location !== 'local' || !selection.persistenceDirectory)
    throw new Error('Choose local storage and an explicit persistence directory.')
  const persistenceDirectory = resolve(repositoryRoot, selection.persistenceDirectory)
  const d1Object = 'miniflare-D1DatabaseObject'
  const kvObject = 'miniflare-KVNamespaceObject'
  return {
    persistenceDirectory,
    d1Sqlite: resolve(persistenceDirectory, 'v3/d1', d1Object, `${localObjectId(d1Object, selection.d1.id)}.sqlite`),
    kvSqlite: resolve(persistenceDirectory, 'v3/kv', kvObject, `${localObjectId(kvObject, selection.kv.id)}.sqlite`),
    kvBlobs: resolve(persistenceDirectory, 'v3/kv', selection.kv.id, 'blobs'),
  }
}

export function resolveLocalD1SqlitePath(
  options: { target?: string; override?: string; selection?: CloudflareStorageSelection } = {},
): string {
  if (options.override) return options.override
  const selection =
    options.selection ?? resolveCloudflareStorage(options.target ?? process.env.CIVUP_TARGET ?? 'standard', 'local')
  const path = localResourcePaths(selection).d1Sqlite
  if (!existsSync(path))
    throw new Error(
      `Local D1 for ${selection.target} (${selection.d1.id}) was not found at ${path}. Run local migrations for that target, or set DRIZZLE_DB_URL.`,
    )
  return path
}

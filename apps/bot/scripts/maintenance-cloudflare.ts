import type {
  CloudflareStorageLocation,
  CloudflareTargetName,
  CloudflareTargetOptions,
} from '../../../config/cloudflare-targets.ts'
import type {
  CloudflareClient,
  CloudflareClientOptions,
  CloudflareD1Parameter,
  CloudflareD1Statement,
} from '../../../scripts/cloudflare-client.ts'
import { basename, resolve } from 'node:path'
import { resolveCloudflareStorage } from '../../../config/cloudflare-targets.ts'
import { createCloudflareClient } from '../../../scripts/cloudflare-client.ts'
import { repositoryRoot } from './local-storage.ts'

export function maintenanceTargetName(
  options: { target?: string; config?: string; defaultTarget?: CloudflareTargetName; environmentTarget?: string } = {},
): CloudflareTargetName {
  // Compatibility for ignored owner tools passing the former config flag.
  // Never parse it or accept arbitrary files as a second identity source.
  const config = options.config
  const legacy =
    config === undefined
      ? undefined
      : config === 'ppl' || basename(config) === 'wrangler.ppl.jsonc'
        ? 'ppl'
        : config === 'standard' || basename(config) === 'wrangler.jsonc'
          ? 'standard'
          : undefined
  if (config !== undefined && !legacy)
    throw new Error('Use --target standard|ppl instead of an arbitrary --config file.')
  const selected =
    options.target ??
    options.environmentTarget ??
    process.env.CIVUP_TARGET ??
    legacy ??
    options.defaultTarget ??
    'standard'
  if (selected !== 'standard' && selected !== 'ppl') throw new Error('Choose --target standard or ppl.')
  if (legacy && config !== 'ppl' && config !== 'standard' && legacy !== selected)
    throw new Error('The old --config selection conflicts with the selected target. Use --target only.')
  return selected
}

export function createMaintenanceClient(
  options: {
    target?: string
    config?: string
    database?: string
    defaultTarget?: CloudflareTargetName
    environmentTarget?: string
  },
  location: CloudflareStorageLocation,
  targetOptions: CloudflareTargetOptions = {},
  clientOptions: CloudflareClientOptions = {},
) {
  const name = maintenanceTargetName(options)
  const selection = resolveCloudflareStorage(name, location, targetOptions)
  if (options.database && options.database !== selection.d1.name && options.database !== selection.d1.id)
    throw new Error('The database override does not match the selected target. Choose the target instead.')
  const client = createCloudflareClient(
    { accountId: selection.accountId, databaseId: selection.d1.id, namespaceId: selection.kv.id },
    location === 'local'
      ? { location, persistenceDirectory: resolve(repositoryRoot, selection.persistenceDirectory!) }
      : { location },
    clientOptions,
  )
  const provenance = {
    target: name,
    location,
    accountId: selection.accountId,
    databaseId: selection.d1.id,
    namespaceId: selection.kv.id,
    ...(client.storage.location === 'local' ? { persistenceDirectory: client.storage.persistenceDirectory } : {}),
  }
  return { client, selection, provenance }
}

export function matchesMaintenanceProvenance(saved: unknown, expected: Record<string, unknown>): boolean {
  return (
    typeof saved === 'object' &&
    saved !== null &&
    Object.entries(expected).every(([key, value]) => (saved as Record<string, unknown>)[key] === value)
  )
}

export function maintenanceCacheKey(provenance: {
  accountId: string
  databaseId: string
  namespaceId: string
  location: string
}): string {
  return `${provenance.accountId}-${provenance.databaseId}-${provenance.namespaceId}-${provenance.location}`
}

function parameters(values: unknown[]): CloudflareD1Parameter[] {
  return values.map(value => {
    if (typeof value === 'boolean') return Number(value)
    if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      return value
    throw new Error('Maintenance D1 bindings must be strings, finite numbers, booleans, or null.')
  })
}

export function createMaintenanceBindings(client: CloudflareClient): { d1: D1Database; kv: KVNamespace } {
  const statements = new WeakMap<object, CloudflareD1Statement>()
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const params = parameters(values)
    const body = { sql, params }
    const all = async <T>() => {
      const results = await client.d1Query<T>(body.sql, body.params)
      if (results.length !== 1) throw new Error('Expected one D1 statement result.')
      return results[0]! as unknown as D1Result<T>
    }
    const prepared = {
      bind: (...next: unknown[]) => statement(sql, next),
      all,
      run: all,
      first: async <T>(column?: string) => {
        const result = await all<Record<string, unknown>>()
        const row = result.results[0] ?? null
        return (column && row ? row[column] : row) as T | null
      },
      raw: async <T>() => (await all<Record<string, unknown>>()).results.map(row => Object.values(row)) as T[],
    } as D1PreparedStatement
    statements.set(prepared, body)
    return prepared
  }
  return {
    d1: {
      prepare: statement,
      batch: async (batch: D1PreparedStatement[]) =>
        client.d1Batch(
          batch.map(prepared => {
            const body = statements.get(prepared)
            if (!body) throw new Error('Batch statements must belong to this maintenance database.')
            return body
          }),
        ),
    } as unknown as D1Database,
    kv: {
      async get(key: string, type?: string) {
        const value = await client.kvGet(key)
        return value === null || type !== 'json' ? value : JSON.parse(value)
      },
      put: (
        key: string,
        value: string,
        options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
      ) => client.kvPut(key, value, options),
      delete: (key: string) => client.kvDelete(key),
      list: (options?: { prefix?: string }) => client.kvList(options),
    } as unknown as KVNamespace,
  }
}

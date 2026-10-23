import type { CloudflareTarget } from '../../../config/cloudflare-targets.ts'
import type { CloudflareCommand, CloudflareCommandResult } from '../../../scripts/cloudflare-client.ts'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { cloudflareTargets } from '../../../config/cloudflare-targets.ts'
import { parseCivBackfillOptions } from '../scripts/backfill-civ-leaderboard.ts'
import { localObjectId, localResourcePaths, resolveLocalD1SqlitePath } from '../scripts/local-storage.ts'
import {
  createMaintenanceBindings,
  createMaintenanceClient,
  maintenanceCacheKey,
  maintenanceTargetName,
  matchesMaintenanceProvenance,
} from '../scripts/maintenance-cloudflare.ts'

const custom: CloudflareTarget = {
  ...cloudflareTargets.standard,
  accountId: '11111111111111111111111111111111',
  d1: { ...cloudflareTargets.standard.d1, id: '33333333-3333-4333-8333-333333333333' },
  kv: { binding: 'KV', id: '44444444444444444444444444444444' },
}
const targetOptions = { localTargets: { standard: cloudflareTargets.standard, alternate: custom } }
const response = (payload: unknown): CloudflareCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify(payload),
  stderr: '',
})
const d1Result = {
  success: true,
  results: [{ value: 7 }],
  meta: { rows_read: 12, rows_written: 3, changes: 1, duration: 1, size_after: 10, last_row_id: 1, changed_db: true },
}

function fixture(location: 'local' | 'remote', responses: CloudflareCommandResult[]) {
  const commands: CloudflareCommand[] = []
  const runtime = createMaintenanceClient({ target: 'alternate' }, location, targetOptions, {
    env: { CLOUDFLARE_ACCOUNT_ID: cloudflareTargets.standard.accountId },
    runner(command) {
      commands.push(command)
      const result = responses.shift()
      if (!result) throw new Error('Unexpected fixture request')
      return result
    },
  })
  return { ...runtime, ...createMaintenanceBindings(runtime.client), commands }
}

describe('maintenance target defaults and identity', () => {
  test('local commands default to standard storage unless a target is explicit', () => {
    expect(parseCivBackfillOptions([])).toMatchObject({ location: 'local', defaultTarget: 'standard', execute: false })
    expect(parseCivBackfillOptions([], { target: 'alternate', location: 'remote' })).toMatchObject({
      location: 'remote',
      defaultTarget: 'alternate',
      execute: false,
    })
    expect(parseCivBackfillOptions(['--local'], { target: 'alternate', location: 'remote' })).toMatchObject({
      location: 'local',
      defaultTarget: 'standard',
    })
    expect(parseCivBackfillOptions(['apply', '--repair', '--target', 'alternate', '--execute'])).toMatchObject({
      source: 'contributions',
      target: 'alternate',
      execute: true,
      location: 'local',
    })
    expect(
      parseCivBackfillOptions(['--target', 'alternate', '--local'], { target: 'standard', location: 'remote' }),
    ).toMatchObject({
      target: 'alternate',
      location: 'local',
    })
  })

  test('rejects ambiguous old config and independent database selection', () => {
    expect(maintenanceTargetName({ config: 'wrangler.jsonc', environmentTarget: 'standard' })).toBe('standard')
    expect(() => maintenanceTargetName({ config: 'custom.jsonc', target: 'alternate' })).toThrow('arbitrary')
    expect(() => maintenanceTargetName({ config: 'wrangler.jsonc', target: 'alternate' })).toThrow('conflicts')
    expect(() => maintenanceTargetName({ config: 'standard', target: 'alternate' })).toThrow('conflicts')
    expect(() => maintenanceTargetName({ config: 'wrangler.alternate.jsonc', target: 'alternate' })).toThrow('--target')
    expect(() =>
      createMaintenanceClient({ target: 'alternate', database: 'another-database' }, 'remote', targetOptions),
    ).toThrow('does not match')
  })

  test('accepts arbitrary configured names without changing the storage location', () => {
    const target = 'team-archive'
    const settings = { ...custom, d1: { ...custom.d1, name: 'archive-matches' } }
    const options = { localTargets: { [target]: settings } }
    for (const location of ['local', 'remote'] as const) {
      const runtime = createMaintenanceClient({ target }, location, options)
      expect(runtime.selection).toMatchObject({ target, location, accountId: settings.accountId, d1: settings.d1 })
      expect(createMaintenanceClient({ target, database: settings.d1.name }, location, options).selection.d1).toEqual(
        settings.d1,
      )
    }
    expect(maintenanceTargetName({ environmentTarget: target })).toBe(target)
    expect(() => createMaintenanceClient({ target: 'unconfigured' }, 'local', options)).toThrow('missing')
  })

  test.each(['../outside', 'invalid name', '__proto__', 'constructor'])(
    'validates target names centrally: %s',
    target => {
      expect(() => maintenanceTargetName({ target })).toThrow()
    },
  )

  test.each(['local', 'remote'] as const)(
    'binds the same-name database and KV to the selected account for %s',
    async location => {
      const runtime = fixture(location, [response([d1Result]), response({ values: { key: null } })])
      expect((await runtime.d1.prepare('SELECT value FROM fixture').all()).meta).toEqual(d1Result.meta)
      expect(await runtime.kv.get('key')).toBeNull()
      expect(runtime.commands[0]!.args).toContain(custom.d1.id)
      expect(runtime.commands[1]!.args).toContain(custom.kv.id)
      expect(runtime.commands.every(command => command.env.CLOUDFLARE_ACCOUNT_ID === custom.accountId)).toBe(true)
      expect(runtime.commands.every(command => !command.args.includes('--config'))).toBe(true)
      if (location === 'local') {
        expect(runtime.client.storage.location).toBe('local')
        expect(isAbsolute(runtime.provenance.persistenceDirectory!)).toBe(true)
        expect(runtime.commands[0]!.args).toContain(runtime.provenance.persistenceDirectory!)
      }
    },
  )

  test('cache provenance rejects another account, resource, location, or old unnamed cache', () => {
    const { provenance } = fixture('remote', [])
    expect(matchesMaintenanceProvenance(provenance, provenance)).toBe(true)
    for (const field of ['accountId', 'databaseId', 'namespaceId', 'location']) {
      expect(matchesMaintenanceProvenance({ ...provenance, [field]: 'wrong' }, provenance)).toBe(false)
      expect(maintenanceCacheKey({ ...provenance, [field]: 'wrong' })).not.toBe(maintenanceCacheKey(provenance))
    }
    expect(matchesMaintenanceProvenance({ database: 'civup' }, provenance)).toBe(false)
  })
})

describe('maintenance Workers-compatible bridge', () => {
  test('passes numeric/null parameters without coercion through local SDK transport', async () => {
    const runtime = fixture('local', [response({ success: true, statement_count: 1, result: [d1Result] })])
    const statement = runtime.d1.prepare('SELECT ? AS a, ? AS b, ? AS c').bind(7, null, 'text')
    expect(await statement.first<number>('value')).toBe(7)
    expect(runtime.commands[0]!.tool).toBe('local-d1')
    expect(runtime.commands[0]!.body).toMatchObject({
      databaseId: custom.d1.id,
      statements: [{ sql: 'SELECT ? AS a, ? AS b, ? AS c', params: [7, null, 'text'] }],
    })
  })

  test('keeps D1 batch results and metering, rejecting foreign prepared statements', async () => {
    const runtime = fixture('remote', [response([d1Result, d1Result])])
    const result = await runtime.d1.batch([
      runtime.d1.prepare('SELECT ?').bind(1),
      runtime.d1.prepare('SELECT ?').bind(2),
    ])
    expect(result.map(row => row.meta)).toEqual([d1Result.meta, d1Result.meta])
    expect(runtime.commands[0]!.body).toEqual({
      batch: [
        { sql: 'SELECT ?', params: [1] },
        { sql: 'SELECT ?', params: [2] },
      ],
    })
    await expect(runtime.d1.batch([fixture('remote', []).d1.prepare('SELECT 1')])).rejects.toThrow('belong')
  })

  test('preserves KV missing, empty, whitespace, and errors; empty JSON is not absence', async () => {
    const runtime = fixture('remote', [
      response({ values: { key: null } }),
      response({ values: { key: '' } }),
      response({ values: { key: '  ' } }),
      response({ values: { key: '' } }),
      { exitCode: 1, stdout: '', stderr: 'fixture failure' },
    ])
    expect(await runtime.kv.get('key')).toBeNull()
    expect(await runtime.kv.get('key')).toBe('')
    expect(await runtime.kv.get('key')).toBe('  ')
    await expect(runtime.kv.get('key', 'json')).rejects.toThrow()
    await expect(runtime.kv.get('key')).rejects.toThrow('failed')
  })

  test('keeps TTL seconds and complete listing from the adapter', async () => {
    const runtime = fixture('remote', [
      response({ successful_key_count: 1, unsuccessful_keys: [] }),
      response([{ name: 'prefix:a', expiration: 99 }]),
    ])
    await runtime.kv.put('key', 'value', { expirationTtl: 120 })
    expect(runtime.commands[0]!.body).toEqual([{ key: 'key', value: 'value', expiration_ttl: 120 }])
    expect(await runtime.kv.list({ prefix: 'prefix:' })).toMatchObject({
      keys: [{ name: 'prefix:a', expiration: 99 }],
      list_complete: true,
    })
  })
})

describe('resource-specific local inspection', () => {
  test('uses the pinned Miniflare idFromName paths, not a filename heuristic', () => {
    expect(localObjectId('miniflare-D1DatabaseObject', custom.d1.id)).toBe(
      '9ec83b7cc49efb3e8df8c5ebd15c3ddcdbf52a2274ec1a2d1f16345944834470',
    )
    expect(localObjectId('miniflare-KVNamespaceObject', custom.kv.id)).toBe(
      'ec3c090bd533792dc0c4ceb11a65cfb989c9295eb44656621b4967268859374b',
    )
  })

  test('never selects another SQLite file and preserves explicit Drizzle override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'maintenance-targets-'))
    try {
      const selection = { ...fixture('local', []).selection, persistenceDirectory: root }
      const paths = localResourcePaths(selection)
      await mkdir(dirname(paths.d1Sqlite), { recursive: true })
      await writeFile(join(dirname(paths.d1Sqlite), 'zzz-unrelated.sqlite'), 'fixture')
      expect(() => resolveLocalD1SqlitePath({ selection })).toThrow(custom.d1.id)
      await writeFile(paths.d1Sqlite, 'selected fixture')
      expect(resolveLocalD1SqlitePath({ selection })).toBe(paths.d1Sqlite)
      expect(paths.kvBlobs).toBe(join(root, 'v3', 'kv', custom.kv.id, 'blobs'))
      expect(localObjectId('miniflare-KVNamespaceObject', custom.kv.id)).not.toBe(
        localObjectId('miniflare-KVNamespaceObject', cloudflareTargets.standard.kv.id),
      )
      expect(resolveLocalD1SqlitePath({ override: 'file:explicit.sqlite', target: 'invalid' })).toBe(
        'file:explicit.sqlite',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

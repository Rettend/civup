import type { CloudflareTarget, CloudflareTargetOptions } from '../../../config/cloudflare-targets.ts'
import type {
  CloudflareClientOptions,
  CloudflareCommand,
  CloudflareCommandResult,
} from '../../../scripts/cloudflare-client.ts'
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// PPL helpers are intentionally local and ignored. Clean checkouts still run
// every tracked bridge test; local PPL integration fixtures are optional.
const statsUrl = new URL('../../../ppl/civ-stats.shared.ts', import.meta.url).href
const historyUrl = new URL('../../../ppl/season-history.ts', import.meta.url).href
const statsModule = existsSync(fileURLToPath(statsUrl)) ? await import(statsUrl) : null
const historyModule = existsSync(fileURLToPath(historyUrl)) ? await import(historyUrl) : null
const { getKvJson, getKvText, loadCompletedMatchRows, statsStorage } = statsModule ?? {}
const auditedQuery = historyModule?.query

interface PplStatsSourceOptions {
  target: string
  database: string
  guildId: string
  cacheDir?: string
  targetOptions: CloudflareTargetOptions
  clientOptions: CloudflareClientOptions
}

const ppl: CloudflareTarget = {
  ...cloudflareTargets.standard,
  accountId: '33333333333333333333333333333333',
  d1: { ...cloudflareTargets.standard.d1, id: '33333333-3333-4333-8333-333333333333' },
  kv: { binding: 'KV', id: '44444444444444444444444444444444' },
}
const targetOptions = { localTargets: { ppl } }
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
  const runtime = createMaintenanceClient({ target: 'ppl' }, location, targetOptions, {
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
  test('standard and PPL preserve separate location defaults', () => {
    expect(parseCivBackfillOptions([])).toMatchObject({ location: 'local', defaultTarget: 'standard', execute: false })
    expect(parseCivBackfillOptions([], { target: 'ppl', location: 'remote' })).toMatchObject({
      location: 'remote',
      defaultTarget: 'ppl',
      execute: false,
    })
    expect(parseCivBackfillOptions(['--local'], { target: 'ppl', location: 'remote' })).toMatchObject({
      location: 'local',
      defaultTarget: 'standard',
    })
    expect(parseCivBackfillOptions(['apply', '--repair', '--target', 'ppl', '--execute'])).toMatchObject({
      source: 'contributions',
      target: 'ppl',
      execute: true,
      location: 'local',
    })
  })

  test('rejects ambiguous old config and independent database selection', () => {
    expect(maintenanceTargetName({ config: 'wrangler.ppl.jsonc', environmentTarget: 'ppl' })).toBe('ppl')
    expect(() => maintenanceTargetName({ config: 'custom.jsonc', target: 'ppl' })).toThrow('arbitrary')
    expect(() => maintenanceTargetName({ config: 'wrangler.ppl.jsonc', target: 'standard' })).toThrow('conflicts')
    expect(() =>
      createMaintenanceClient({ target: 'ppl', database: 'another-database' }, 'remote', targetOptions),
    ).toThrow('does not match')
  })

  test.each(['local', 'remote'] as const)(
    'binds the same-name database and KV to the selected account for %s',
    async location => {
      const runtime = fixture(location, [response([d1Result]), response({ values: { key: null } })])
      expect((await runtime.d1.prepare('SELECT value FROM fixture').all()).meta).toEqual(d1Result.meta)
      expect(await runtime.kv.get('key')).toBeNull()
      expect(runtime.commands[0]!.args).toContain(ppl.d1.id)
      expect(runtime.commands[1]!.args).toContain(ppl.kv.id)
      expect(runtime.commands.every(command => command.env.CLOUDFLARE_ACCOUNT_ID === ppl.accountId)).toBe(true)
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
      databaseId: ppl.d1.id,
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
    expect(localObjectId('miniflare-D1DatabaseObject', ppl.d1.id)).toBe(
      '9ec83b7cc49efb3e8df8c5ebd15c3ddcdbf52a2274ec1a2d1f16345944834470',
    )
    expect(localObjectId('miniflare-KVNamespaceObject', ppl.kv.id)).toBe(
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
      expect(() => resolveLocalD1SqlitePath({ selection })).toThrow(ppl.d1.id)
      await writeFile(paths.d1Sqlite, 'selected fixture')
      expect(resolveLocalD1SqlitePath({ selection })).toBe(paths.d1Sqlite)
      expect(paths.kvBlobs).toBe(join(root, 'v3', 'kv', ppl.kv.id, 'blobs'))
      expect(localObjectId('miniflare-KVNamespaceObject', ppl.kv.id)).not.toBe(
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

describe.skipIf(!statsModule)('PPL stats adapter and cache-only reads', () => {
  test('missing or mismatched caches never make a live request; matching fixture cache is reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'maintenance-cache-'))
    let calls = 0
    const options: PplStatsSourceOptions = {
      target: 'ppl',
      database: 'civup',
      guildId: 'fixture-guild',
      cacheDir: root,
      targetOptions,
      clientOptions: {
        env: {},
        runner() {
          calls++
          throw new Error('No live reads allowed')
        },
      },
    }
    try {
      await expect(loadCompletedMatchRows(options)).rejects.toThrow('Missing cached')
      const { provenance } = statsStorage(options)
      const cache = join(root, `${maintenanceCacheKey(provenance)}-completed-matches.json`)
      const row = {
        id: 'fixture-match',
        season_id: null,
        game_mode: '1v1',
        is_old: false,
        created_at: 1,
        completed_at: 2,
        draft_data: null,
      }
      await writeFile(
        cache,
        JSON.stringify({ source: { ...provenance, guildId: options.guildId, accountId: 'wrong' }, rows: [row] }),
      )
      await expect(loadCompletedMatchRows(options)).rejects.toThrow('Missing cached')
      await writeFile(cache, JSON.stringify({ source: { ...provenance, guildId: options.guildId }, rows: [row] }))
      expect(await loadCompletedMatchRows(options)).toEqual([row])
      expect(calls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('shared PPL KV reader preserves empty text and rejects malformed JSON', async () => {
    const options: PplStatsSourceOptions = {
      target: 'ppl',
      database: 'civup',
      guildId: 'fixture-guild',
      targetOptions,
      clientOptions: { env: {}, runner: () => response({ values: { key: '' } }) },
    }
    expect(await getKvText('key', options)).toBe('')
    await expect(getKvJson('key', options)).rejects.toThrow('parse JSON')
  })
})

describe.skipIf(!historyModule)('audited PPL maintenance outcomes', () => {
  test('records identity before submission and refuses to overwrite an existing request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'maintenance-journal-'))
    const audit = join(root, 'request.json')
    const token = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = 'fixture-only'
    let calls = 0
    const runtime = createMaintenanceClient({ target: 'ppl' }, 'remote', targetOptions, {
      env: {},
      async runner() {
        calls++
        const journal = JSON.parse(await readFile(audit, 'utf8'))
        expect(journal.identity).toEqual({ accountId: ppl.accountId, databaseId: ppl.d1.id })
        expect(journal.outcome).toContain('unknown')
        return response([d1Result])
      },
    })
    try {
      expect((await auditedQuery(['SELECT 7'], audit, runtime))[0]!.meta.rows_read).toBe(12)
      const saved = JSON.parse(await readFile(`${audit}.result.json`, 'utf8'))
      expect(saved.confirmed).toBe(true)
      expect(saved.payload.result[0].meta).toEqual(d1Result.meta)
      await expect(auditedQuery(['SELECT 7'], audit, runtime)).rejects.toThrow()
      expect(calls).toBe(1)
    } finally {
      if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = token
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves an uncertain outcome and failed payload rather than treating it as absence or success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode', 'maintenance-uncertain-'))
    const audit = join(root, 'request.json')
    const token = process.env.CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = 'fixture-only'
    const payload = [{ success: false, error: 'fixture failure', results: [], meta: { rows_read: 2, rows_written: 0 } }]
    const runtime = fixture('remote', [response(payload)])
    try {
      await expect(auditedQuery(['SELECT 7'], audit, runtime)).rejects.toThrow('do not retry')
      const request = JSON.parse(await readFile(audit, 'utf8'))
      const saved = JSON.parse(await readFile(`${audit}.result.json`, 'utf8'))
      expect(request.outcome).toContain('unknown')
      expect(saved.confirmed).toBe(false)
      expect(saved.payload).toEqual(payload)
      expect(runtime.commands).toHaveLength(1)
    } finally {
      if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = token
      await rm(root, { recursive: true, force: true })
    }
  })
})

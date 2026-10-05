// Opt-in, credential-free integration: node tests/cloudflare-local.node.ts --run
// Add --bun /path/to/bun if Node's PATH selects a different Bun executable.
// Uses two tiny fixture migrations, never the repository migrations or development state.
import type { CloudflareTarget } from '../config/cloudflare-targets.ts'
import type { CloudflareClient } from '../scripts/cloudflare-client.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CloudflareD1Error,
  createCloudflareClient,
  createNodeCloudflareRunner,
  resolveCloudflareExecutable,
} from '../scripts/cloudflare-client.ts'

interface MigrationPlan {
  cmd: string[]
  cwd?: string
  env: Record<string, string>
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    TEMP: root,
    TMP: root,
    NO_COLOR: '1',
    CF_QUIET: '1',
    CF_NO_OSC_PROGRESS: '1',
    CF_TELEMETRY: 'false',
    WRANGLER_SEND_METRICS: 'false',
    DO_NOT_TRACK: '1',
    CI: '1',
  }
}

async function runProbe(): Promise<void> {
  const bunOption = process.argv.indexOf('--bun')
  const bunExecutable =
    (bunOption >= 0 ? process.argv[bunOption + 1] : process.versions.bun ? process.execPath : 'bun') ?? ''
  assert.ok(bunExecutable, '--bun needs an executable path.')
  const temporaryRoot = join(tmpdir(), 'opencode')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'cloudflare-local-test-'))
  try {
    const persistenceDirectory = join(root, 'persist')
    const migrationsDirectory = join(root, 'migrations')
    await mkdir(migrationsDirectory)
    await writeFile(
      join(migrationsDirectory, '0001_create.sql'),
      'CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL, optional INTEGER);\n',
    )
    await writeFile(
      join(migrationsDirectory, '0002_seed.sql'),
      "INSERT INTO fixture_rows VALUES (1, 'from migration', NULL);\n",
    )
    const target: CloudflareTarget = {
      accountId: '11111111111111111111111111111111',
      workers: { bot: 'civup-bot', activity: 'civup-activity' },
      discord: { applicationId: '111111111111111111', publicKey: '0'.repeat(64), guildId: '222222222222222222' },
      activityOrigin: 'https://fixture.invalid',
      d1: {
        binding: 'DB',
        name: 'fixture',
        id: '11111111-1111-4111-8111-111111111111',
        migrationsDirectory,
        migrationsPattern: '*.sql',
        migrationsTable: 'fixture_migrations',
      },
      kv: { binding: 'KV', id: '22222222222222222222222222222222' },
      bot: { compatibilityDate: '2026-08-15', compatibilityFlags: [], keepVars: true, variables: {}, fontGlobs: [] },
      activity: { compatibilityDate: '2026-08-15', compatibilityFlags: [] },
    }
    const env = isolatedEnvironment(root)
    const adminUrl = new URL('../scripts/cloudflare-admin.ts', import.meta.url).href
    const adapterUrl = new URL('../scripts/cloudflare-client.ts', import.meta.url).href
    function bun(source: string): string {
      const result = spawnSync(bunExecutable, ['--no-env-file', '--eval', source], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 120_000,
      })
      assert.equal(result.status, 0, result.stderr || String(result.error ?? 'Bun child failed'))
      return result.stdout
    }
    // The real admin constructor is Bun-specific. Do not duplicate its migration command here.
    const plan: MigrationPlan = JSON.parse(
      bun(`
      import { cloudflareAdminCommand } from ${JSON.stringify(adminUrl)}
      console.log(JSON.stringify(cloudflareAdminCommand('migrate', 'standard', ${JSON.stringify(target)}, ${JSON.stringify({ location: 'local', persistenceDirectory })})))
    `),
    )
    assert.equal(plan.cmd[0], 'node')
    assert.equal(plan.env.CLOUDFLARE_ACCOUNT_ID, target.accountId)
    assert.ok(plan.cmd.includes(target.d1.id))
    assert.ok(plan.cmd.includes('--local'))
    assert.ok(plan.cmd.includes(persistenceDirectory))
    assert.ok(plan.cmd.includes('fixture_migrations'))
    assert.equal(plan.cwd, undefined)
    function migrate(): { name: string; status: string }[] {
      const result = spawnSync(plan.cmd[0]!, plan.cmd.slice(1), {
        cwd: root,
        env: { ...env, ...plan.env },
        encoding: 'utf8',
        timeout: 120_000,
      })
      assert.equal(result.status, 0, result.stderr || String(result.error ?? 'Migration child failed'))
      bun(
        `import { checkMigrationResult } from ${JSON.stringify(adminUrl)}; checkMigrationResult(${JSON.stringify(result.stdout)})`,
      )
      return JSON.parse(result.stdout)
    }
    const migrated = migrate()
    assert.deepEqual(
      migrated.map(result => result.name),
      ['0001_create.sql', '0002_seed.sql'],
    )
    assert.ok(migrated.every(result => result.status === '✅'))
    assert.deepEqual(migrate(), [], 'The same migration plan must not reapply fixture migrations.')

    const resources = { accountId: target.accountId, databaseId: target.d1.id, namespaceId: target.kv.id }
    const storage = { location: 'local' as const, persistenceDirectory }
    const tools = new Set<string>()
    const nodeRunner = createNodeCloudflareRunner({ timeoutMs: 30_000 })
    const client = createCloudflareClient(resources, storage, {
      env,
      runner: command => {
        tools.add(command.tool)
        assert.equal(resolveCloudflareExecutable(command.tool).executable, 'node')
        return nodeRunner(command)
      },
    })
    async function rows<Row>(storageClient: CloudflareClient, sql: string): Promise<Row[]> {
      const [result] = await storageClient.d1Query<Row>(sql)
      assert.ok(result?.success)
      return result.results
    }
    assert.deepEqual(await rows(client, 'SELECT id, value, optional FROM fixture_rows'), [
      { id: 1, value: 'from migration', optional: null },
    ])
    assert.deepEqual(await rows(client, 'SELECT name FROM fixture_migrations ORDER BY id'), [
      { name: '0001_create.sql' },
      { name: '0002_seed.sql' },
    ])

    // A Bun maintenance caller writes through the same adapter, whose CLI/SDK children use Node.
    const bunWrite = JSON.parse(
      bun(`
      import { createCloudflareClient } from ${JSON.stringify(adapterUrl)}
      const client = createCloudflareClient(${JSON.stringify(resources)}, ${JSON.stringify(storage)}, { env: process.env, timeoutMs: 30000 })
      const [result] = await client.d1Query('INSERT INTO fixture_rows VALUES (?, ?, ?)', [2, 'from Bun', null])
      await client.kvPut('fixture:empty', '', { expirationTtl: 3600, metadata: { runtime: 'Bun' } })
      await client.kvPut('fixture:value', 'from Bun')
      console.log(JSON.stringify({ changes: result.meta.changes }))
    `),
    )
    assert.equal(bunWrite.changes, 1)
    assert.deepEqual(await rows(client, 'SELECT id, value, optional FROM fixture_rows WHERE id = 2'), [
      { id: 2, value: 'from Bun', optional: null },
    ])
    const [typed] = await client.d1Query<{ numeric_value: number; numeric_type: string; optional: null }>(
      'SELECT ? AS numeric_value, typeof(?) AS numeric_type, ? AS optional',
      [27, 27, null],
    )
    assert.equal(typed!.results[0]!.numeric_value, 27)
    assert.ok(
      ['integer', 'real'].includes(typed!.results[0]!.numeric_type),
      'A number must stay numeric, not become a text binding.',
    )
    assert.equal(typed!.results[0]!.optional, null)
    const batch = await client.d1Batch([
      { sql: 'INSERT INTO fixture_rows VALUES (?, ?, ?)', params: [3, 'typed batch', null] },
      { sql: 'SELECT id FROM fixture_rows WHERE id = ?', params: [3] },
    ])
    assert.equal(batch.length, 2)
    assert.equal(batch[0]!.meta.changes, 1)
    assert.deepEqual(batch[1]!.results, [{ id: 3 }])
    const script = await client.d1Query(
      "INSERT INTO fixture_rows VALUES (4, 'script; value', NULL); SELECT COUNT(*) AS total FROM fixture_rows;",
    )
    assert.equal(script.length, 2)
    assert.equal(script[0]!.meta.changes, 1)
    assert.deepEqual(script[1]!.results, [{ total: 4 }])
    const boundScript = await client.d1Query('INSERT INTO fixture_rows VALUES (?, ?, ?); SELECT ? AS bound;', [
      5,
      "quote'; semicolon?",
      null,
      6,
    ])
    assert.equal(boundScript.length, 2)
    assert.equal(boundScript[0]!.meta.changes, 1)
    assert.deepEqual(boundScript[1]!.results, [{ bound: 6 }])
    const trigger = await client.d1Query(`
      CREATE TABLE fixture_audit (message TEXT);
      CREATE TRIGGER fixture_trigger AFTER INSERT ON fixture_rows BEGIN
        INSERT INTO fixture_audit VALUES ('first; semicolon');
        INSERT INTO fixture_audit VALUES ('second');
      END;
      INSERT INTO fixture_rows VALUES (6, 'trigger', NULL);
      SELECT message FROM fixture_audit ORDER BY rowid;
    `)
    assert.equal(trigger.length, 4, 'A trigger body is one SQL statement, not separate inserts.')
    assert.deepEqual(trigger[3]!.results, [{ message: 'first; semicolon' }, { message: 'second' }])
    await assert.rejects(
      client.d1Batch([
        { sql: 'INSERT INTO fixture_rows VALUES (?, ?, ?)', params: [7, 'must roll back', null] },
        { sql: 'INSERT INTO fixture_rows VALUES (?, ?, ?)', params: [1, 'duplicate ID', null] },
      ]),
      error => {
        assert.ok(error instanceof CloudflareD1Error)
        assert.deepEqual(error.results, [])
        assert.ok(error.errors.some(entry => entry.message?.includes('UNIQUE constraint failed')))
        return true
      },
    )
    assert.deepEqual(await rows(client, 'SELECT COUNT(*) AS total FROM fixture_rows WHERE id = 7'), [{ total: 0 }])
    const transaction = await client.d1Query(`
      BEGIN TRANSACTION;
      INSERT INTO fixture_rows VALUES (8, 'BEGIN TRANSACTION; COMMIT;', NULL);
      COMMIT;
      SELECT value FROM fixture_rows WHERE id = 8;
    `)
    assert.equal(transaction.length, 2)
    assert.deepEqual(transaction[1]!.results, [{ value: 'BEGIN TRANSACTION; COMMIT;' }])

    assert.equal(await client.kvGet('fixture:missing'), null)
    assert.equal(await client.kvGet('fixture:empty'), '')
    assert.equal(await client.kvGet('fixture:value'), 'from Bun')
    await client.kvPut('fixture:node', 'from Node', { expirationTtl: 3600 })
    const listed = await client.kvList({ prefix: 'fixture:', pageSize: 1 })
    assert.equal(listed.list_complete, true)
    assert.deepEqual(listed.keys.map(key => key.name).sort(), ['fixture:empty', 'fixture:node', 'fixture:value'])
    const empty = listed.keys.find(key => key.name === 'fixture:empty')!
    assert.deepEqual(empty.metadata, { runtime: 'Bun' })
    assert.ok(empty.expiration! > Date.now() / 1000 + 3500, 'KV TTL is seconds, not milliseconds.')
    await client.kvDelete('fixture:empty')
    await client.kvDelete('fixture:missing')
    assert.equal(await client.kvGet('fixture:empty'), null)
    const bunRead = JSON.parse(
      bun(`
      import { createCloudflareClient } from ${JSON.stringify(adapterUrl)}
      const client = createCloudflareClient(${JSON.stringify(resources)}, ${JSON.stringify(storage)}, { env: process.env })
      console.log(JSON.stringify({ value: await client.kvGet('fixture:node') }))
    `),
    )
    assert.equal(bunRead.value, 'from Node')
    assert.deepEqual([...tools].sort(), ['cf', 'local-d1', 'local-kv-list'])
    process.stdout.write(
      'Local Cloudflare integration passed: fixture migrations, shared Node/Bun D1 and KV state, typed bindings, script/trigger results, batch rollback, TTL and complete pagination.\n',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv.includes('--run')) {
  await runProbe()
} else {
  process.stdout.write(
    'Skipped local Cloudflare integration. Run node tests/cloudflare-local.node.ts --run to use temporary fixture storage.\n',
  )
}

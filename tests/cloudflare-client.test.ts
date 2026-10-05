import type {
  CloudflareCommand,
  CloudflareCommandResult,
  CloudflareResources,
  CloudflareStorageOptions,
} from '../scripts/cloudflare-client.ts'
import { describe, expect, test } from 'bun:test'
import { isAbsolute, resolve } from 'node:path'
import {
  CloudflareClientError,
  CloudflareD1Error,
  createCloudflareClient,
  resolveCloudflareExecutable,
} from '../scripts/cloudflare-client.ts'
import { countSqlBindings } from '../scripts/cloudflare-client/sql-bindings.ts'

const standard: CloudflareResources = {
  accountId: '11111111111111111111111111111111',
  databaseId: '11111111-1111-4111-8111-111111111111',
  namespaceId: '22222222222222222222222222222222',
}
const ppl: CloudflareResources = {
  accountId: '33333333333333333333333333333333',
  databaseId: '33333333-3333-4333-8333-333333333333',
  namespaceId: '44444444444444444444444444444444',
}
const remote: CloudflareStorageOptions = { location: 'remote' }
const local: CloudflareStorageOptions = { location: 'local', persistenceDirectory: 'tests/fixtures/unused-storage' }

function response(payload: unknown, overrides: Partial<CloudflareCommandResult> = {}): CloudflareCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '', ...overrides }
}

function fixture(responses: CloudflareCommandResult[], storage = remote, resources = standard) {
  const commands: CloudflareCommand[] = []
  const client = createCloudflareClient(resources, storage, {
    env: { CLOUDFLARE_ACCOUNT_ID: ppl.accountId, CF_QUIET: '0', NO_COLOR: '0', CF_NO_OSC_PROGRESS: '0' },
    runner(command) {
      commands.push(command)
      const next = responses.shift()
      if (!next) throw new Error('The fixture did not expect another command.')
      return next
    },
  })
  return { client, commands }
}

async function rejected(action: Promise<unknown>): Promise<unknown> {
  try {
    await action
  } catch (error) {
    return error
  }
  throw new Error('Expected the operation to reject.')
}

describe('Cloudflare storage selection and process boundary', () => {
  test('resolves the installed CLI entry points and invokes Node, not the Bun caller runtime', () => {
    for (const tool of ['cf', 'wrangler', 'local-kv-list', 'local-d1'] as const) {
      const executable = resolveCloudflareExecutable(tool)
      expect(executable.executable).toBe('node')
      expect(isAbsolute(executable.entryPoint)).toBe(true)
      expect(resolveCloudflareExecutable(tool, 'C:/node24/node.exe').executable).toBe('C:/node24/node.exe')
    }
    expect(resolveCloudflareExecutable('cf').entryPoint.replaceAll('\\', '/')).toEndWith('/cf/bin/cf')
    expect(resolveCloudflareExecutable('wrangler').entryPoint.replaceAll('\\', '/')).toEndWith(
      '/wrangler/bin/wrangler.js',
    )
  })

  test.each([standard, ppl])(
    'explicit resources override the environment without selecting remote implicitly',
    async resources => {
      const { client, commands } = fixture([response({ values: { key: null } })], local, resources)
      expect(await client.kvGet('key')).toBeNull()
      expect(commands[0]!.args).toContain(resources.namespaceId!)
      expect(commands[0]!.args).toContain('--local')
      expect(commands[0]!.args).toContain(resolve(local.persistenceDirectory!))
      expect(commands[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe(resources.accountId)
      expect(client.resources).toEqual(resources)
      expect(client.storage.location).toBe('local')
      expect(commands[0]!.args).not.toContain('--config')
      expect(commands[0]!.args).not.toContain('--remote')
    },
  )

  test('remote D1 uses its database ID and JSON output without a quiet flag', async () => {
    const { client, commands } = fixture([response([{ success: true, results: [], meta: {} }])], remote, ppl)
    await client.d1Query('SELECT 1')
    expect(commands[0]!.tool).toBe('cf')
    expect(commands[0]!.args).toEqual(['d1', 'query', ppl.databaseId!])
    expect(commands[0]!.env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: ppl.accountId,
      NO_COLOR: '1',
      CF_QUIET: '1',
      CF_NO_OSC_PROGRESS: '1',
    })
    expect(commands[0]!.args).not.toContain('-q')
    expect(commands[0]!.args).not.toContain('--quiet')
  })

  test('identity and transport are snapshots rather than mutable caller state', async () => {
    const resources = { ...standard }
    const storage: CloudflareStorageOptions = { location: 'local', persistenceDirectory: 'initial' }
    const { client, commands } = fixture([response({ values: { key: null } })], storage, resources)
    resources.namespaceId = ppl.namespaceId
    resources.accountId = ppl.accountId
    storage.persistenceDirectory = 'changed'
    await client.kvGet('key')
    expect(commands[0]!.args).toContain(standard.namespaceId!)
    expect(commands[0]!.args).toContain(resolve('initial'))
    expect(commands[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe(standard.accountId)
    expect(Object.isFrozen(client.resources)).toBe(true)
  })

  test.each([
    { accountId: '' },
    { ...standard, accountId: 'standard' },
    { ...standard, databaseId: 'civup-db' },
    { ...standard, namespaceId: 'KV' },
  ])('rejects names, bindings and implicit identities before any subprocess', resources => {
    expect(() => createCloudflareClient(resources, remote)).toThrow('ID')
  })

  test('requires an explicit location and rejects ambiguous persistence settings', () => {
    expect(() => createCloudflareClient(standard, undefined as unknown as CloudflareStorageOptions)).toThrow(
      'Choose local or remote',
    )
    expect(() => createCloudflareClient(standard, { location: 'local', persistenceDirectory: '' })).toThrow(
      'persistence directory',
    )
    expect(() =>
      createCloudflareClient(standard, {
        location: 'remote',
        persistenceDirectory: 'state',
      } as unknown as CloudflareStorageOptions),
    ).toThrow('Remote storage')
  })

  test('missing resource IDs reject before the runner starts', async () => {
    const { client, commands } = fixture([], remote, { accountId: standard.accountId })
    await expect(client.d1Query('SELECT 1')).rejects.toThrow('database ID')
    await expect(client.kvGet('key')).rejects.toThrow('namespace ID')
    expect(commands).toHaveLength(0)
  })
})

describe('D1 results', () => {
  test('preserves rows and all metadata from an API envelope', async () => {
    const meta = {
      changes: 2,
      last_row_id: 17,
      rows_read: 8,
      rows_written: 2,
      size_after: 4096,
      timings: { sql_duration_ms: 3 },
      future_field: 'retained',
    }
    const { client } = fixture([
      response({ success: true, errors: [], result: [{ success: true, results: [{ id: 17 }], meta }] }),
    ])
    expect(await client.d1Query<{ id: number }>('SELECT id FROM probe')).toEqual([
      { success: true, results: [{ id: 17 }], meta, errors: [] },
    ])
  })

  test('normalizes local raw rows without losing null, empty values or prototype-like column names', async () => {
    const { client, commands } = fixture(
      [
        response([
          {
            success: true,
            results: { columns: ['id', 'text', 'optional', '__proto__'], rows: [[3, '', null, 'value']] },
            meta: { served_by: 'miniflare.db', changes: 0 },
          },
        ]),
      ],
      local,
    )
    const results = await client.d1Query('SELECT ?, NULL', [''])
    expect(results[0]!.results[0]).toEqual(JSON.parse('{"id":3,"text":"","optional":null,"__proto__":"value"}'))
    expect(results[0]!.meta.served_by).toBe('miniflare.db')
    expect(commands[0]!.args.slice(0, 3)).toEqual(['d1', 'raw', standard.databaseId!])
    expect(commands[0]!.body).toEqual({ sql: 'SELECT ?, NULL', params: [''] })
  })

  test('uses an actual batch body and retains each statement result in order', async () => {
    const { client, commands } = fixture([
      response([
        { success: true, results: [{ n: 1 }], meta: { changes: 0 } },
        { success: true, results: [], meta: { changes: 4 } },
      ]),
    ])
    const statements = [
      { sql: 'SELECT ?', params: [1] },
      { sql: 'UPDATE probe SET n = ?', params: [null] },
    ]
    const results = await client.d1Batch(statements)
    expect(commands[0]!.body).toEqual({ batch: statements })
    expect(results.map(result => result.meta.changes)).toEqual([0, 4])
  })

  test.each([0, 1])(
    'throws on a failed statement even when the process exit code is %s, preserving all results',
    async exitCode => {
      const { client } = fixture([
        response(
          {
            success: true,
            result: [
              { success: true, results: [{ saved: 1 }], meta: { changes: 1 } },
              {
                success: false,
                results: [],
                meta: { changes: 0 },
                error: 'constraint failed',
                errors: [{ code: 1000, message: 'invalid row' }],
              },
            ],
          },
          { exitCode },
        ),
      ])
      const error = await rejected(
        client.d1Batch([{ sql: 'INSERT INTO probe VALUES (1)' }, { sql: 'INSERT INTO probe VALUES (1)' }]),
      )
      expect(error).toBeInstanceOf(CloudflareD1Error)
      const d1Error = error as CloudflareD1Error
      expect(d1Error.results[0]!.results).toEqual([{ saved: 1 }])
      expect(d1Error.results[0]!.meta.changes).toBe(1)
      expect(d1Error.results[1]!.success).toBe(false)
      expect(d1Error.results[1]!.errors).toEqual([
        { code: 1000, message: 'invalid row' },
        { message: 'constraint failed' },
      ])
      expect(d1Error.commandResult!.exitCode).toBe(exitCode)
    },
  )

  test('an unsuccessful outer envelope cannot be hidden by successful inner statements', async () => {
    const { client } = fixture([
      response({
        success: false,
        errors: [{ code: 10000, message: 'access denied' }],
        result: [{ success: true, results: [], meta: {} }],
      }),
    ])
    const error = (await rejected(client.d1Query('SELECT 1'))) as CloudflareD1Error
    expect(error).toBeInstanceOf(CloudflareD1Error)
    expect(error.errors[0]!.message).toBe('access denied')
    expect(error.results).toHaveLength(1)
  })

  test('an outer failure with no statement results retains its API errors', async () => {
    const { client } = fixture([
      response({ success: false, errors: [{ message: 'database unavailable' }], result: null }),
    ])
    const error = (await rejected(client.d1Query('SELECT 1'))) as CloudflareD1Error
    expect(error.results).toEqual([])
    expect(error.errors).toEqual([{ message: 'database unavailable' }])
  })

  test.each(
    [
      [],
      [{ results: [], meta: {} }],
      [{ success: true, results: { columns: ['id'], rows: [[1, 2]] } }],
      [{ success: true, results: [{ id: 1 }], meta: 'lost' }],
    ].map(payload => [payload]),
  )('rejects malformed or unconfirmed D1 responses', async payload => {
    const { client } = fixture([response(payload)])
    await expect(client.d1Query('SELECT 1')).rejects.toThrow('unexpected response')
  })

  test('does not silently lose a statement in a batch', async () => {
    const { client } = fixture([response([{ success: true, results: [], meta: {} }])])
    await expect(client.d1Batch([{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }])).rejects.toThrow('unexpected response')
  })

  test('keeps numeric and null local bindings typed through the Node SDK fallback', async () => {
    const { client, commands } = fixture(
      [
        response({
          success: true,
          result: [{ success: true, results: [{ number: 123, optional: null }], meta: { rows_read: 0 } }],
          statement_count: 1,
        }),
      ],
      local,
    )
    expect((await client.d1Query('SELECT ? AS number, ? AS optional', [123, null]))[0]!.results).toEqual([
      { number: 123, optional: null },
    ])
    expect(commands[0]!.tool).toBe('local-d1')
    expect(commands[0]!.body).toEqual({
      databaseId: standard.databaseId,
      persistenceDirectory: resolve(local.persistenceDirectory!),
      statements: [{ sql: 'SELECT ? AS number, ? AS optional', params: [123, null] }],
    })
  })

  test('local SQL scripts use the SDK and preserve every statement result', async () => {
    const { client, commands } = fixture(
      [
        response({
          success: true,
          result: [
            { success: true, results: [{ n: 1 }], meta: { changes: 0 } },
            { success: true, results: [{ n: 2 }], meta: { changes: 0 } },
          ],
          statement_count: 2,
        }),
      ],
      local,
    )
    const results = await client.d1Query('SELECT 1 AS n; SELECT 2 AS n')
    expect(results.map(result => result.results)).toEqual([[{ n: 1 }], [{ n: 2 }]])
    expect(commands[0]!.tool).toBe('local-d1')
  })

  test('a local batch with typed values stays one SDK transaction and keeps expanded script results', async () => {
    const { client, commands } = fixture(
      [
        response({
          success: true,
          result: [
            { success: true, results: [], meta: { changes: 1 } },
            { success: true, results: [{ n: 1 }], meta: {} },
            { success: true, results: [{ n: 2 }], meta: {} },
          ],
          statement_count: 3,
        }),
      ],
      local,
    )
    const statements = [{ sql: 'INSERT INTO probe VALUES (?)', params: [1] }, { sql: 'SELECT 1 AS n; SELECT 2 AS n' }]
    const results = await client.d1Batch(statements)
    expect(results).toHaveLength(3)
    expect(commands).toHaveLength(1)
    expect(commands[0]!.body).toMatchObject({ statements })
  })

  test('SDK batch failure exposes the reported failure without inventing successful statements', async () => {
    const { client } = fixture(
      [response({ success: false, result: null, errors: [{ message: 'constraint failed' }] }, { exitCode: 1 })],
      local,
    )
    const error = (await rejected(
      client.d1Batch([{ sql: 'INSERT INTO probe VALUES (?)', params: [1] }]),
    )) as CloudflareD1Error
    expect(error).toBeInstanceOf(CloudflareD1Error)
    expect(error.results).toEqual([])
    expect(error.errors).toEqual([{ message: 'constraint failed' }])
  })

  test('the SDK fallback cannot silently return fewer results than its declared statement count', async () => {
    const { client } = fixture(
      [response({ success: true, result: [{ success: true, results: [], meta: {} }], statement_count: 2 })],
      local,
    )
    await expect(client.d1Query('SELECT 1; SELECT 2')).rejects.toThrow('unexpected response')
  })

  test('semicolons inside SQL strings, quoted identifiers and comments do not split a local statement', async () => {
    const { client } = fixture(
      [response([{ success: true, results: { columns: ['value'], rows: [[';']] }, meta: {} }])],
      local,
    )
    const sql = "/* ; */ SELECT ';' AS [semi;colon] -- ;\n; /* trailing ; */"
    expect((await client.d1Query(sql))[0]!.results).toEqual([{ value: ';' }])
  })

  test('rejects invalid statements and parameters without invoking cf', () => {
    const { client, commands } = fixture([])
    expect(() => client.d1Batch([])).toThrow('at least one')
    expect(() => client.d1Query('  ')).toThrow('nonempty')
    expect(() => client.d1Query('SELECT ?', [Number.NaN])).toThrow('finite numbers')
    expect(commands).toHaveLength(0)
  })
})

describe('SQL script binding slots', () => {
  test.each([
    ['SELECT ?, ?', 2],
    ['SELECT ?3, ?1, ?', 4],
    ['SELECT :value, :value, @value, $value', 3],
    ['SELECT :with$dollar, :with$dollar', 1],
    ['SELECT $tcl::name(suffix), $tcl::name(suffix)', 1],
    ["SELECT '?' AS [ignore?], `ignore:`, \"ignore@\", 'it''s?' -- ?\n, ? /* ? */", 1],
  ] as const)('counts SQLite slots in %s', (sql, expected) => {
    expect(countSqlBindings(sql)).toBe(expected)
  })
})

describe('KV values and writes', () => {
  test.each([null, '', 'hello', ' \n '])(
    'preserves the exact distinction between a missing key and a text value: %j',
    async value => {
      const { client, commands } = fixture([response({ values: { 'ranked:dirty': value } })], local)
      expect(await client.kvGet('ranked:dirty')).toBe(value)
      expect(commands[0]!.args.slice(0, 4)).toEqual(['kv', 'bulk', 'get', standard.namespaceId!])
      expect(commands[0]!.body).toEqual({ keys: ['ranked:dirty'], type: 'text', withMetadata: false })
    },
  )

  test('prototype names are not mistaken for returned values', async () => {
    const { client } = fixture([response({ values: {} })])
    await expect(client.kvGet('__proto__')).rejects.toThrow('unexpected response')
  })

  test.each([
    { values: {} },
    { values: { key: false } },
    { success: false, errors: [{ code: 10000, message: 'not authorized' }], result: { values: { key: null } } },
  ])('malformed or failed requests are errors, not absent values', async payload => {
    const { client } = fixture([response(payload)])
    await expect(client.kvGet('key')).rejects.toBeInstanceOf(CloudflareClientError)
  })

  test('a nonzero process exit with a missing-key-shaped response still fails', async () => {
    const { client } = fixture([response({ values: { key: null } }, { exitCode: 1, stderr: 'HTTP 503' })])
    const error = (await rejected(client.kvGet('key'))) as CloudflareClientError
    expect(error).toBeInstanceOf(CloudflareClientError)
    expect(error.commandResult!.stderr).toBe('HTTP 503')
  })

  test('writes an empty value with TTL seconds and metadata using structured bulk put', async () => {
    const { client, commands } = fixture([response({ successful_key_count: 1, unsuccessful_keys: [] })])
    await client.kvPut('pending:release', '', {
      expirationTtl: 3600,
      expiration: 2_000_000_000,
      metadata: { version: '1.2.3' },
    })
    expect(commands[0]!.args).toEqual(['kv', 'bulk', 'put', standard.namespaceId!])
    expect(commands[0]!.body).toEqual([
      {
        key: 'pending:release',
        value: '',
        expiration_ttl: 3600,
        expiration: 2_000_000_000,
        metadata: { version: '1.2.3' },
      },
    ])
  })

  test('delete confirms its one key and bypasses the interactive prompt', async () => {
    const { client, commands } = fixture([response({ successful_key_count: 1, unsuccessful_keys: [] })], local)
    await client.kvDelete('--looks-like-a-flag')
    expect(commands[0]!.args.slice(0, 5)).toEqual(['kv', 'bulk', 'delete', standard.namespaceId!, '--force'])
    expect(commands[0]!.body).toEqual(['--looks-like-a-flag'])
    expect(commands[0]!.args).not.toContain('--looks-like-a-flag')
  })

  test.each([
    { successful_key_count: 0, unsuccessful_keys: ['key'] },
    { successful_key_count: 1, unsuccessful_keys: ['key'] },
    { successful_key_count: 2, unsuccessful_keys: [] },
    {},
    null,
  ])('does not equate process success with a confirmed write', async payload => {
    const { client } = fixture([response(payload)])
    await expect(client.kvPut('key', 'value')).rejects.toThrow('did not confirm')
  })

  test.each([0, 59, 60.5, Number.NaN])('rejects invalid TTL %s before a write', expirationTtl => {
    const { client, commands } = fixture([])
    expect(() => client.kvPut('key', 'value', { expirationTtl })).toThrow('whole number of seconds')
    expect(commands).toHaveLength(0)
  })

  test('preserves spawn/timeout failures for callers instead of guessing an outcome', async () => {
    const { client } = fixture([
      response({}, { exitCode: null, error: new Error('timeout'), stderr: 'connection lost' }),
    ])
    const error = (await rejected(client.kvPut('key', 'value'))) as CloudflareClientError
    expect(error.commandResult!.error!.message).toBe('timeout')
    expect(error.commandResult!.exitCode).toBeNull()
  })

  test('keeps runner failures and malformed stdout distinct from missing keys', async () => {
    const client = createCloudflareClient(standard, remote, {
      env: {},
      runner: () => {
        throw new Error('node is unavailable')
      },
    })
    await expect(client.kvGet('key')).rejects.toThrow('could not start')
    const { client: malformed } = fixture([response({}, { stdout: 'not JSON' })])
    await expect(malformed.kvGet('key')).rejects.toThrow('did not return JSON')
  })
})

describe('complete KV enumeration', () => {
  test('remote lists use only the narrow all-pages Wrangler fallback with explicit account and namespace', async () => {
    const keys = Array.from({ length: 1001 }, (_, index) => ({ name: `prefix:${index}`, metadata: { index } }))
    const { client, commands } = fixture([response(keys)], remote, ppl)
    expect(await client.kvList({ prefix: 'prefix:' })).toEqual({ keys, list_complete: true, cursor: '' })
    expect(commands).toHaveLength(1)
    expect(commands[0]!.tool).toBe('wrangler')
    expect(commands[0]!.args).toEqual([
      'kv',
      'key',
      'list',
      '--namespace-id',
      ppl.namespaceId!,
      '--remote',
      '--prefix=prefix:',
    ])
    expect(commands[0]!.env.CLOUDFLARE_ACCOUNT_ID).toBe(ppl.accountId)
    expect(commands[0]!.args).not.toContain('--config')
  })

  test('local listing follows opaque cursors, including an empty incomplete page', async () => {
    const { client, commands } = fixture(
      [
        response({
          keys: [{ name: 'p:a', expiration: 2_000_000_000, metadata: { version: 1 } }],
          list_complete: false,
          cursor: 'opaque+/=',
        }),
        response({ keys: [], list_complete: false, cursor: 'next-token' }),
        response({ keys: [{ name: 'p:b' }], list_complete: true }),
      ],
      local,
    )
    const result = await client.kvList({ prefix: 'p:', pageSize: 10 })
    expect(result).toEqual({
      keys: [{ name: 'p:a', expiration: 2_000_000_000, metadata: { version: 1 } }, { name: 'p:b' }],
      list_complete: true,
      cursor: '',
    })
    expect(commands.map(command => command.tool)).toEqual(['local-kv-list', 'local-kv-list', 'local-kv-list'])
    expect(commands.map(command => (command.body as { cursor?: string }).cursor)).toEqual([
      undefined,
      'opaque+/=',
      'next-token',
    ])
    expect(commands[0]!.body).toMatchObject({
      namespaceId: standard.namespaceId,
      persistenceDirectory: resolve(local.persistenceDirectory!),
      prefix: 'p:',
      limit: 10,
    })
  })

  test.each(
    [
      [],
      { keys: [], list_complete: false },
      { keys: [], list_complete: false, cursor: '' },
      { keys: [{ name: 'key' }] },
    ].map(payload => [payload]),
  )('never claims completeness when pagination information is missing', async payload => {
    const { client } = fixture([response(payload)], local)
    await expect(client.kvList()).rejects.toBeInstanceOf(CloudflareClientError)
  })

  test('repeated cursors fail rather than looping or returning a partial successful list', async () => {
    const { client, commands } = fixture(
      [
        response({ keys: [], list_complete: false, cursor: 'same' }),
        response({ keys: [], list_complete: false, cursor: 'same' }),
      ],
      local,
    )
    await expect(client.kvList()).rejects.toThrow('new cursor')
    expect(commands).toHaveLength(2)
  })

  test('the local page limit rejects an incomplete list without another request', async () => {
    const { client, commands } = fixture(
      [response({ keys: [{ name: 'key' }], list_complete: false, cursor: 'next' })],
      local,
    )
    await expect(client.kvList({ maxPages: 1 })).rejects.toThrow('page limit')
    expect(commands).toHaveLength(1)
  })

  test('a failed later page rejects the whole list', async () => {
    const { client } = fixture(
      [
        response({ keys: [{ name: 'first' }], list_complete: false, cursor: 'next' }),
        response({}, { exitCode: 1, stderr: 'storage error' }),
      ],
      local,
    )
    await expect(client.kvList()).rejects.toThrow('KV list failed')
  })

  test.each([[{ name: 'same' }, { name: 'same' }], [{ name: 'other' }], [{ id: 'missing name' }]].map(keys => [keys]))(
    'rejects inconsistent list results instead of masking data loss',
    async keys => {
      const { client } = fixture([response(keys)])
      await expect(client.kvList({ prefix: 'same' })).rejects.toThrow('unexpected response')
    },
  )
})

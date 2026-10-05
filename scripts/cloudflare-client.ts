import type { ExecFileException } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

/** Public identities only. Selecting an account never selects local or remote storage. */
export interface CloudflareResources {
  accountId: string
  databaseId?: string
  namespaceId?: string
}

export type CloudflareStorageOptions =
  | { location: 'local'; persistenceDirectory: string }
  | { location: 'remote'; persistenceDirectory?: never }

export interface CloudflareCommand {
  tool: 'cf' | 'wrangler' | 'local-kv-list' | 'local-d1'
  args: readonly string[]
  env: NodeJS.ProcessEnv
  /** Written to a private temporary JSON file, not passed on the command line. */
  body?: unknown
}

export interface CloudflareCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  error?: Error
}

export type CloudflareCommandRunner = (
  command: CloudflareCommand,
) => Promise<CloudflareCommandResult> | CloudflareCommandResult

export interface CloudflareClientOptions {
  runner?: CloudflareCommandRunner
  env?: NodeJS.ProcessEnv
  nodeExecutable?: string
  timeoutMs?: number
  maxBufferBytes?: number
}

export interface CloudflareApiMessage {
  code?: string | number
  message?: string
  [key: string]: unknown
}

export interface CloudflareD1Result<Row = Record<string, unknown>> {
  success: boolean
  results: Row[]
  meta: Record<string, unknown>
  errors: CloudflareApiMessage[]
}

export type CloudflareD1Parameter = string | number | null

export interface CloudflareD1Statement {
  sql: string
  params?: readonly CloudflareD1Parameter[]
}

export interface CloudflareKvKey {
  name: string
  expiration?: number
  metadata?: unknown
}

export interface CloudflareKvList {
  keys: CloudflareKvKey[]
  list_complete: true
  cursor: ''
}

export interface CloudflareKvPutOptions {
  /** Seconds, matching Workers KV's expirationTtl option. Minimum: 60. */
  expirationTtl?: number
  /** Unix timestamp in seconds. expirationTtl takes precedence when both are set. */
  expiration?: number
  metadata?: unknown
}

export interface CloudflareKvListOptions {
  prefix?: string
  /** Local SDK page size. The remote Wrangler fallback chooses its own page size. */
  pageSize?: number
  /** Local pagination guard. Remote listing is bounded by the runner timeout/output limit. */
  maxPages?: number
}

export class CloudflareClientError extends Error {
  readonly operation: string
  readonly commandResult?: CloudflareCommandResult
  readonly payload?: unknown

  constructor(message: string, operation: string, commandResult?: CloudflareCommandResult, payload?: unknown) {
    super(message, { cause: commandResult?.error })
    this.name = 'CloudflareClientError'
    this.operation = operation
    this.commandResult = commandResult
    this.payload = payload
  }
}

/** Failed statements retain every returned result, including successful rows and metadata. */
export class CloudflareD1Error<Row = Record<string, unknown>> extends CloudflareClientError {
  readonly results: CloudflareD1Result<Row>[]
  readonly errors: CloudflareApiMessage[]

  constructor(
    operation: string,
    results: CloudflareD1Result<Row>[],
    errors: CloudflareApiMessage[],
    commandResult: CloudflareCommandResult,
    payload: unknown,
  ) {
    super(`Cloudflare ${operation} failed.`, operation, commandResult, payload)
    this.name = 'CloudflareD1Error'
    this.results = results
    this.errors = errors
  }
}

const require = createRequire(import.meta.url)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

/** Always invoke installed CLIs with Node, even when the maintenance caller runs under Bun. */
export function resolveCloudflareExecutable(
  tool: CloudflareCommand['tool'],
  nodeExecutable = 'node',
): { executable: string; entryPoint: string } {
  if (tool === 'local-kv-list' || tool === 'local-d1') {
    return {
      executable: nodeExecutable,
      entryPoint: fileURLToPath(new URL(`./cloudflare-client/${tool}.ts`, import.meta.url)),
    }
  }
  const packageJson = require.resolve(`${tool}/package.json`, {
    paths: [repositoryRoot, join(repositoryRoot, 'apps/bot'), join(repositoryRoot, 'apps/activity')],
  })
  return {
    executable: nodeExecutable,
    entryPoint: join(dirname(packageJson), 'bin', tool === 'cf' ? 'cf' : 'wrangler.js'),
  }
}

export function createNodeCloudflareRunner(
  options: Pick<CloudflareClientOptions, 'nodeExecutable' | 'timeoutMs' | 'maxBufferBytes'> = {},
): CloudflareCommandRunner {
  return async command => {
    const { executable, entryPoint } = resolveCloudflareExecutable(command.tool, options.nodeExecutable)
    const temporaryRoot = join(tmpdir(), 'opencode')
    await mkdir(temporaryRoot, { recursive: true })
    const cwd = await mkdtemp(join(temporaryRoot, 'civup-storage-'))
    try {
      const args = [...command.args]
      if (command.body !== undefined) {
        const bodyPath = join(cwd, 'body.json')
        await writeFile(bodyPath, JSON.stringify(command.body), { mode: 0o600 })
        const sdk = command.tool === 'local-kv-list' || command.tool === 'local-d1'
        args.push(sdk ? bodyPath : '--body')
        if (!sdk) args.push(`@${bodyPath}`)
      }
      // An isolated cwd prevents config/.env discovery from overriding explicit identities.
      return await new Promise<CloudflareCommandResult>(resolveResult => {
        execFile(
          executable,
          [entryPoint, ...args],
          {
            cwd,
            env: command.env,
            encoding: 'utf8',
            timeout: options.timeoutMs ?? 120_000,
            maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
            windowsHide: true,
          },
          (error: ExecFileException | null, stdout, stderr) => {
            resolveResult({
              exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
              stdout,
              stderr,
              ...(error ? { error } : {}),
            })
          },
        )
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolError(operation: string, payload?: unknown): never {
  throw new CloudflareClientError(
    `Cloudflare ${operation} returned an unexpected response.`,
    operation,
    undefined,
    payload,
  )
}

function parseJson(result: CloudflareCommandResult, operation: string): unknown {
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new CloudflareClientError(`Cloudflare ${operation} did not return JSON.`, operation, result)
  }
}

function apiMessages(value: unknown): CloudflareApiMessage[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return [{ message: 'Unexpected API error data', detail: value }]
  return value.map(entry =>
    typeof entry === 'string'
      ? { message: entry }
      : isRecord(entry)
        ? entry
        : { message: 'Unexpected API error data', detail: entry },
  )
}

function hasMultipleLocalStatements(sql: string): boolean {
  let quote: string | undefined
  let comment: 'line' | 'block' | undefined
  let ended = false
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    const next = sql[index + 1]
    if (comment === 'line') {
      if (char === '\n' || char === '\r') comment = undefined
      continue
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = undefined
        index++
      }
      continue
    }
    if (quote !== undefined) {
      if (char === quote) {
        if (next === quote && quote !== ']') index++
        else quote = undefined
      }
      continue
    }
    if (char === '-' && next === '-') {
      comment = 'line'
      index++
      continue
    }
    if (char === '/' && next === '*') {
      comment = 'block'
      index++
      continue
    }
    if (/\s/.test(char)) continue
    if (char === ';') {
      ended = true
      continue
    }
    if (ended) return true
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '[') quote = ']'
  }
  return false
}

function normalizeD1<Row>(
  payload: unknown,
  operation: string,
): { results: CloudflareD1Result<Row>[]; errors: CloudflareApiMessage[]; success: boolean } {
  const envelope = isRecord(payload) && 'result' in payload ? payload : undefined
  const entries = envelope ? envelope.result : payload
  const errors = apiMessages(envelope?.errors)
  if (envelope && typeof envelope.success !== 'boolean') protocolError(operation, payload)
  if (envelope?.success === false && (entries === undefined || entries === null))
    return { results: [], errors, success: false }
  if (!Array.isArray(entries) || entries.length === 0) protocolError(operation, payload)
  const results = entries.map(entry => {
    if (!isRecord(entry) || typeof entry.success !== 'boolean') protocolError(operation, payload)
    const statementErrors = apiMessages(entry.errors)
    if (typeof entry.error === 'string') statementErrors.push({ message: entry.error })
    if (entry.meta !== undefined && !isRecord(entry.meta)) protocolError(operation, payload)
    let rows: unknown[] = []
    if (Array.isArray(entry.results)) {
      if (!entry.results.every(isRecord)) protocolError(operation, payload)
      rows = entry.results
    } else if (isRecord(entry.results)) {
      const columns = entry.results.columns ?? []
      const values = entry.results.rows ?? []
      if (!Array.isArray(columns) || !columns.every(column => typeof column === 'string') || !Array.isArray(values))
        protocolError(operation, payload)
      rows = values.map(row => {
        if (!Array.isArray(row) || row.length !== columns.length) protocolError(operation, payload)
        return Object.fromEntries(columns.map((column, index) => [column, row[index]]))
      })
    } else if (entry.results !== undefined && !(entry.success === false && entry.results === null)) {
      protocolError(operation, payload)
    }
    return {
      success: entry.success,
      results: rows as Row[],
      meta: entry.meta ?? {},
      errors: statementErrors,
    }
  })
  return {
    results,
    errors,
    success:
      envelope?.success !== false &&
      errors.length === 0 &&
      results.every(result => result.success && result.errors.length === 0),
  }
}

function normalizeKvKeys(payload: unknown, operation: string): CloudflareKvKey[] {
  if (!Array.isArray(payload)) protocolError(operation, payload)
  return payload.map(entry => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      (entry.expiration !== undefined && typeof entry.expiration !== 'number')
    )
      protocolError(operation, payload)
    return {
      name: entry.name,
      ...(entry.expiration !== undefined ? { expiration: entry.expiration } : {}),
      ...('metadata' in entry ? { metadata: entry.metadata } : {}),
    }
  })
}

function requireIdentifier(value: unknown, pattern: RegExp, name: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new Error(`Pass an explicit Cloudflare ${name} ID, not a name or binding.`)
}

export function createCloudflareClient(
  resources: CloudflareResources,
  storage: CloudflareStorageOptions,
  options: CloudflareClientOptions = {},
) {
  requireIdentifier(resources.accountId, /^[a-f0-9]{32}$/i, 'account')
  if (resources.databaseId !== undefined)
    requireIdentifier(resources.databaseId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'database')
  if (resources.namespaceId !== undefined) requireIdentifier(resources.namespaceId, /^[a-f0-9]{32}$/i, 'namespace')
  if (storage?.location !== 'local' && storage?.location !== 'remote')
    throw new Error('Choose local or remote storage explicitly.')
  if (storage.location === 'remote' && storage.persistenceDirectory !== undefined)
    throw new Error('Remote storage cannot use a local persistence directory.')
  if (
    storage.location === 'local' &&
    (typeof storage.persistenceDirectory !== 'string' || !storage.persistenceDirectory.trim())
  )
    throw new Error('Choose a local persistence directory explicitly.')
  const identity = Object.freeze({ ...resources })
  const local = storage.location === 'local'
  const persistenceDirectory = local ? resolve(storage.persistenceDirectory) : undefined
  const runner = options.runner ?? createNodeCloudflareRunner(options)
  const env = {
    ...(options.env ?? process.env),
    CLOUDFLARE_ACCOUNT_ID: identity.accountId,
    CLOUDFLARE_COMPLIANCE_REGION: 'public',
    NO_COLOR: '1',
    CF_QUIET: '1',
    CF_NO_OSC_PROGRESS: '1',
    CF_TELEMETRY: 'false',
    WRANGLER_SEND_METRICS: 'false',
    DO_NOT_TRACK: '1',
    CI: '1',
  }
  const locationArgs = local ? ['--local', '--persist-to', persistenceDirectory!] : []

  function resourceId(name: 'databaseId' | 'namespaceId'): string {
    const id = identity[name]
    if (!id) {
      throw new Error(
        `Pass an explicit Cloudflare ${name === 'databaseId' ? 'database' : 'namespace'} ID for this operation.`,
      )
    }
    return id
  }

  async function run(command: Omit<CloudflareCommand, 'env'>, operation: string): Promise<CloudflareCommandResult> {
    try {
      return await runner({ ...command, env: { ...env } })
    } catch (cause) {
      throw new CloudflareClientError(`Cloudflare ${operation} could not start.`, operation, {
        exitCode: null,
        stdout: '',
        stderr: '',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }
  }

  async function json(command: Omit<CloudflareCommand, 'env'>, operation: string): Promise<unknown> {
    const result = await run(command, operation)
    if (result.exitCode !== 0 || result.error)
      throw new CloudflareClientError(`Cloudflare ${operation} failed.`, operation, result)
    const payload = parseJson(result, operation)
    if (isRecord(payload) && (payload.success === false || apiMessages(payload.errors).length > 0))
      throw new CloudflareClientError(`Cloudflare ${operation} failed.`, operation, result, payload)
    if (isRecord(payload) && 'result' in payload && payload.success !== true) protocolError(operation, payload)
    return isRecord(payload) && 'result' in payload ? payload.result : payload
  }

  function statementBody(statement: CloudflareD1Statement): CloudflareD1Statement {
    if (!statement.sql.trim()) throw new Error('Pass a nonempty SQL statement.')
    for (const param of statement.params ?? []) {
      if (param !== null && typeof param !== 'string' && (typeof param !== 'number' || !Number.isFinite(param)))
        throw new Error('D1 parameters must be strings, finite numbers, or null.')
    }
    return { sql: statement.sql, ...(statement.params ? { params: [...statement.params] } : {}) }
  }

  async function d1<Row>(
    body: CloudflareD1Statement | { batch: CloudflareD1Statement[] },
    operation: string,
    expectedResults?: number,
  ): Promise<CloudflareD1Result<Row>[]> {
    const databaseId = resourceId('databaseId')
    const statements = 'batch' in body ? body.batch : [body]
    // The pinned local explorer only permits string bindings and drops earlier script results.
    // Use the Node-hosted D1 SDK for precisely those unsupported requests, never string coercion.
    const sdk =
      local &&
      statements.some(
        statement =>
          hasMultipleLocalStatements(statement.sql) || statement.params?.some(param => typeof param !== 'string'),
      )
    const result = await run(
      sdk
        ? { tool: 'local-d1', args: [], body: { databaseId, persistenceDirectory, statements } }
        : { tool: 'cf', args: ['d1', local ? 'raw' : 'query', databaseId, ...locationArgs], body },
      operation,
    )
    if (!result.stdout.trim() && (result.exitCode !== 0 || result.error))
      throw new CloudflareClientError(`Cloudflare ${operation} failed.`, operation, result)
    const payload = parseJson(result, operation)
    const normalized = normalizeD1<Row>(payload, operation)
    if (result.exitCode !== 0 || result.error || !normalized.success)
      throw new CloudflareD1Error(operation, normalized.results, normalized.errors, result, payload)
    if (sdk) {
      if (
        !isRecord(payload) ||
        !Number.isSafeInteger(payload.statement_count) ||
        payload.statement_count !== normalized.results.length ||
        normalized.results.length < statements.length
      )
        protocolError(operation, payload)
    } else if (expectedResults !== undefined && normalized.results.length !== expectedResults) {
      protocolError(operation, payload)
    }
    return normalized.results
  }

  async function kvWrite(key: string, body: unknown, action: 'put' | 'delete'): Promise<void> {
    const operation = `KV ${action}`
    const payload = await json(
      {
        tool: 'cf',
        args: [
          'kv',
          'bulk',
          action,
          resourceId('namespaceId'),
          ...(action === 'delete' ? ['--force'] : []),
          ...locationArgs,
        ],
        body,
      },
      operation,
    )
    if (
      !isRecord(payload) ||
      payload.successful_key_count !== 1 ||
      !Array.isArray(payload.unsuccessful_keys) ||
      payload.unsuccessful_keys.length !== 0
    ) {
      throw new CloudflareClientError(
        `Cloudflare ${operation} did not confirm the write for key ${JSON.stringify(key)}.`,
        operation,
        undefined,
        payload,
      )
    }
  }

  return {
    resources: identity,
    storage: Object.freeze(
      local
        ? { location: 'local' as const, persistenceDirectory: persistenceDirectory! }
        : { location: 'remote' as const },
    ),

    /** Local scripts return one result per SQL statement through the narrow D1 SDK fallback. */
    d1Query<Row = Record<string, unknown>>(sql: string, params?: readonly CloudflareD1Parameter[]) {
      return d1<Row>(statementBody({ sql, params }), 'D1 query')
    },

    d1Batch<Row = Record<string, unknown>>(statements: readonly CloudflareD1Statement[]) {
      if (statements.length === 0) throw new Error('Pass at least one D1 statement.')
      return d1<Row>({ batch: statements.map(statementBody) }, 'D1 batch', statements.length)
    },

    async kvGet(key: string): Promise<string | null> {
      const payload = await json(
        {
          tool: 'cf',
          args: ['kv', 'bulk', 'get', resourceId('namespaceId'), ...locationArgs],
          body: { keys: [key], type: 'text', withMetadata: false },
        },
        'KV get',
      )
      if (!isRecord(payload) || !isRecord(payload.values) || !Object.hasOwn(payload.values, key))
        protocolError('KV get', payload)
      const value = payload.values[key]
      if (value !== null && typeof value !== 'string') protocolError('KV get', payload)
      return value
    },

    kvPut(key: string, value: string, putOptions: CloudflareKvPutOptions = {}): Promise<void> {
      if (typeof value !== 'string') throw new Error('Pass a text value to KV put.')
      if (
        putOptions.expirationTtl !== undefined &&
        (!Number.isSafeInteger(putOptions.expirationTtl) || putOptions.expirationTtl < 60)
      )
        throw new Error('KV expirationTtl must be a whole number of seconds, at least 60.')
      if (
        putOptions.expiration !== undefined &&
        (!Number.isSafeInteger(putOptions.expiration) || putOptions.expiration <= 0)
      )
        throw new Error('KV expiration must be a positive Unix timestamp in seconds.')
      return kvWrite(
        key,
        [
          {
            key,
            value,
            ...(putOptions.expirationTtl !== undefined ? { expiration_ttl: putOptions.expirationTtl } : {}),
            ...(putOptions.expiration !== undefined ? { expiration: putOptions.expiration } : {}),
            ...(putOptions.metadata !== undefined ? { metadata: putOptions.metadata } : {}),
          },
        ],
        'put',
      )
    },

    kvDelete(key: string): Promise<void> {
      return kvWrite(key, [key], 'delete')
    },

    /** Complete enumeration, not a single page. Never infer completeness from cf's unwrapped array. */
    async kvList(listOptions: CloudflareKvListOptions = {}): Promise<CloudflareKvList> {
      const namespaceId = resourceId('namespaceId')
      const pageSize = listOptions.pageSize ?? 1000
      const maxPages = listOptions.maxPages ?? 10_000
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000)
        throw new Error('KV pageSize must be between 1 and 1000.')
      if (!Number.isSafeInteger(maxPages) || maxPages < 1)
        throw new Error('KV maxPages must be a positive whole number.')
      const keys: CloudflareKvKey[] = []
      if (!local) {
        // cf beta.12 drops result_info.cursor. Wrangler's REMOTE key list follows every cursor.
        // Do not use Wrangler's local list: that command only returns its first page.
        const payload = await json(
          {
            tool: 'wrangler',
            args: [
              'kv',
              'key',
              'list',
              '--namespace-id',
              namespaceId,
              '--remote',
              ...(listOptions.prefix !== undefined ? [`--prefix=${listOptions.prefix}`] : []),
            ],
          },
          'KV list',
        )
        keys.push(...normalizeKvKeys(payload, 'KV list'))
      } else {
        // The local Miniflare SDK retains cursor/list_complete and shares cf's explicit v3 root.
        let cursor: string | undefined
        const cursors = new Set<string>()
        for (let page = 0; ; page++) {
          if (page >= maxPages)
            throw new CloudflareClientError('Cloudflare KV list exceeded its page limit before finishing.', 'KV list')
          const payload = await json(
            {
              tool: 'local-kv-list',
              args: [],
              body: { namespaceId, persistenceDirectory, prefix: listOptions.prefix, cursor, limit: pageSize },
            },
            'KV list',
          )
          if (!isRecord(payload) || typeof payload.list_complete !== 'boolean') protocolError('KV list', payload)
          keys.push(...normalizeKvKeys(payload.keys, 'KV list'))
          if (payload.list_complete) break
          if (typeof payload.cursor !== 'string' || !payload.cursor || cursors.has(payload.cursor)) {
            throw new CloudflareClientError(
              'Cloudflare KV list did not return a new cursor before finishing.',
              'KV list',
              undefined,
              payload,
            )
          }
          cursors.add(payload.cursor)
          cursor = payload.cursor
        }
      }
      const names = new Set<string>()
      for (const key of keys) {
        if (names.has(key.name) || (listOptions.prefix !== undefined && !key.name.startsWith(listOptions.prefix)))
          protocolError('KV list', keys)
        names.add(key.name)
      }
      return { keys, list_complete: true, cursor: '' }
    },
  }
}

export type CloudflareClient = ReturnType<typeof createCloudflareClient>

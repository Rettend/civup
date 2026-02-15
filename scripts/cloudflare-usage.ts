/* eslint-disable no-console */
/**
  # set once
  set CLOUDFLARE_API_TOKEN=...
  set CLOUDFLARE_ACCOUNT_ID=...
 
  # baseline
  bun run cf:usage:snapshot -- --from 2026-02-15T00:00:00.000Z --output .tmp/cf-before.json
 
  # play one full 1v1 flow in prod (create -> join -> start -> draft -> report)
 
  # after
  bun run cf:usage:snapshot -- --from 2026-02-15T00:00:00.000Z --output .tmp/cf-after.json
 
  # delta
  bun run cf:usage:diff -- --before .tmp/cf-before.json --after .tmp/cf-after.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

interface CliOptions {
  command: 'snapshot' | 'diff' | 'help'
  accountId?: string
  apiToken?: string
  from?: string
  to?: string
  output?: string
  before?: string
  after?: string
  scripts?: string[]
  json?: boolean
}

interface UsageSnapshot {
  version: 1
  capturedAt: string
  accountId: string
  range: {
    from: string
    to: string
  }
  workers: {
    byScript: Record<string, {
      requests: number
      errors: number
      subrequests: number
    }>
    totalRequests: number
  }
  kv: {
    byActionType: Record<string, number>
    totalOperations: number
  }
  d1: {
    byDatabaseId: Record<string, {
      rowsRead: number
      rowsWritten: number
    }>
    totalRowsRead: number
    totalRowsWritten: number
  }
  durableObjects: {
    dataset: string | null
    byScript: Record<string, {
      requests: number
      errors: number
      wallTime: number
    }>
    totalRequests: number | null
    totalWallTime: number | null
  }
  discovery: {
    accountFieldsContainingDurable: string[]
  }
}

interface SnapshotDiff {
  before: {
    capturedAt: string
    from: string
    to: string
  }
  after: {
    capturedAt: string
    from: string
    to: string
  }
  workers: {
    byScript: Record<string, {
      requests: number
      errors: number
      subrequests: number
    }>
    totalRequests: number
  }
  kv: {
    byActionType: Record<string, number>
    totalOperations: number
  }
  d1: {
    byDatabaseId: Record<string, {
      rowsRead: number
      rowsWritten: number
    }>
    totalRowsRead: number
    totalRowsWritten: number
  }
  durableObjects: {
    dataset: string | null
    byScript: Record<string, {
      requests: number
      errors: number
      wallTime: number
    }>
    totalRequests: number | null
    totalWallTime: number | null
  }
}

interface GraphQlError {
  message: string
}

interface GraphQlResponse<T> {
  data?: T
  errors?: GraphQlError[]
}

interface WorkersGroupsQueryData {
  viewer?: {
    accounts?: Array<{
      workersInvocationsAdaptiveGroups?: Array<{
        dimensions?: {
          scriptName?: string | null
        } | null
        sum?: {
          requests?: number | null
          errors?: number | null
          subrequests?: number | null
        } | null
      }>
    }>
  }
}

interface WorkersAdaptiveQueryData {
  viewer?: {
    accounts?: Array<{
      workersInvocationsAdaptive?: Array<{
        dimensions?: {
          scriptName?: string | null
        } | null
        sum?: {
          requests?: number | null
          errors?: number | null
          subrequests?: number | null
        } | null
      }>
    }>
  }
}

interface KvQueryData {
  viewer?: {
    accounts?: Array<{
      kvOperationsAdaptiveGroups?: Array<{
        count?: number | null
        dimensions?: {
          actionType?: string | null
        } | null
      }>
    }>
  }
}

interface D1QueryData {
  viewer?: {
    accounts?: Array<{
      d1AnalyticsAdaptiveGroups?: Array<{
        sum?: {
          rowsRead?: number | null
          rowsWritten?: number | null
        } | null
        dimensions?: {
          databaseId?: string | null
        } | null
      }>
    }>
  }
}

interface AccountFieldsQueryData {
  __type?: {
    fields?: Array<{
      name?: string | null
    } | null>
  } | null
}

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'
const DEFAULT_SCRIPTS = ['civup-bot', 'civup-activity', 'civup-party']

const usage = [
  'Usage:',
  '  bun scripts/cloudflare-usage.ts snapshot [--output file] [--from ISO] [--to ISO] [--scripts a,b,c] [--json]',
  '  bun scripts/cloudflare-usage.ts diff --before file --after file [--scripts a,b,c] [--json]',
  '',
  'Environment variables:',
  '  CLOUDFLARE_API_TOKEN   API token with GraphQL Analytics permissions',
  '  CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID (account tag)',
  '',
  'Notes:',
  '  - If --from is omitted, snapshot uses UTC start-of-day.',
  '  - If --to is omitted, snapshot uses current time.',
  '  - For before/after experiments, use the same --from in both snapshots, then run diff.',
].join('\n')

const options = parseCli(Bun.argv.slice(2))

switch (options.command) {
  case 'snapshot':
    await runSnapshot(options)
    break
  case 'diff':
    await runDiff(options)
    break
  case 'help':
  default:
    console.log(usage)
}

async function runSnapshot(options: CliOptions): Promise<void> {
  const apiToken = options.apiToken ?? Bun.env.CLOUDFLARE_API_TOKEN
  if (!apiToken) {
    console.error('Missing API token. Set CLOUDFLARE_API_TOKEN or pass --api-token.')
    process.exit(1)
  }

  const accountId = options.accountId ?? Bun.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) {
    console.error('Missing account ID. Set CLOUDFLARE_ACCOUNT_ID or pass --account-id.')
    process.exit(1)
  }

  const to = options.to ?? new Date().toISOString()
  const from = options.from ?? startOfUtcDayIso(to)

  if (Date.parse(from) > Date.parse(to)) {
    console.error('--from must be earlier than or equal to --to')
    process.exit(1)
  }

  const workersByScript = await queryWorkersByScript(apiToken, accountId, from, to)
  const kvByActionType = await queryKvByActionType(apiToken, accountId, from, to)
  const d1ByDatabaseId = await queryD1ByDatabaseId(apiToken, accountId, from, to)
  const durableFields = await queryAccountDurableFields(apiToken)
  const durableObjects = await queryDurableObjectsUsage(apiToken, accountId, from, to, durableFields)

  const snapshot: UsageSnapshot = {
    version: 1,
    capturedAt: new Date().toISOString(),
    accountId,
    range: { from, to },
    workers: {
      byScript: workersByScript,
      totalRequests: Object.values(workersByScript).reduce((sum, row) => sum + row.requests, 0),
    },
    kv: {
      byActionType: kvByActionType,
      totalOperations: Object.values(kvByActionType).reduce((sum, value) => sum + value, 0),
    },
    d1: {
      byDatabaseId: d1ByDatabaseId,
      totalRowsRead: Object.values(d1ByDatabaseId).reduce((sum, row) => sum + row.rowsRead, 0),
      totalRowsWritten: Object.values(d1ByDatabaseId).reduce((sum, row) => sum + row.rowsWritten, 0),
    },
    durableObjects,
    discovery: {
      accountFieldsContainingDurable: durableFields,
    },
  }

  if (options.output) {
    const outputPath = resolve(options.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify(snapshot, null, 2))
    if (!options.json) {
      console.log(`Saved snapshot: ${outputPath}`)
      printSnapshotSummary(snapshot, options.scripts ?? DEFAULT_SCRIPTS)
    }
    return
  }

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }

  printSnapshotSummary(snapshot, options.scripts ?? DEFAULT_SCRIPTS)
}

async function runDiff(options: CliOptions): Promise<void> {
  if (!options.before || !options.after) {
    console.error('diff requires --before and --after snapshot files')
    process.exit(1)
  }

  const before = await readSnapshotFile(options.before)
  const after = await readSnapshotFile(options.after)

  if (before.accountId !== after.accountId) {
    console.warn('Warning: snapshot account IDs differ.')
  }

  const diff = createDiff(before, after)

  if (options.json) {
    console.log(JSON.stringify(diff, null, 2))
    return
  }

  printDiffSummary(diff, options.scripts ?? DEFAULT_SCRIPTS)
}

function parseCli(args: string[]): CliOptions {
  if (args.length === 0) return { command: 'help' }

  const commandRaw = args[0]?.toLowerCase()
  const command = commandRaw === 'snapshot' || commandRaw === 'diff' || commandRaw === 'help'
    ? commandRaw
    : 'help'

  if (command === 'help') return { command: 'help' }

  const options: CliOptions = { command }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg.startsWith('--')) {
      const [flag, inlineValue] = arg.split('=', 2)
      const value = inlineValue ?? args[i + 1]

      if (!inlineValue && value && !value.startsWith('--')) i += 1

      if (flag === '--account-id') options.accountId = value
      else if (flag === '--api-token') options.apiToken = value
      else if (flag === '--from') options.from = value
      else if (flag === '--to') options.to = value
      else if (flag === '--output') options.output = value
      else if (flag === '--before') options.before = value
      else if (flag === '--after') options.after = value
      else if (flag === '--scripts') options.scripts = value?.split(',').map(part => part.trim()).filter(Boolean)
    }
  }

  return options
}

async function readSnapshotFile(path: string): Promise<UsageSnapshot> {
  const contents = await readFile(resolve(path), 'utf8')
  const parsed = JSON.parse(contents) as UsageSnapshot
  if (!parsed || parsed.version !== 1) {
    throw new Error(`Invalid snapshot file: ${path}`)
  }
  return parsed
}

function createDiff(before: UsageSnapshot, after: UsageSnapshot): SnapshotDiff {
  const workerScripts = new Set([...Object.keys(before.workers.byScript), ...Object.keys(after.workers.byScript)])
  const workersByScript: SnapshotDiff['workers']['byScript'] = {}

  for (const scriptName of workerScripts) {
    const left = before.workers.byScript[scriptName] ?? { requests: 0, errors: 0, subrequests: 0 }
    const right = after.workers.byScript[scriptName] ?? { requests: 0, errors: 0, subrequests: 0 }
    workersByScript[scriptName] = {
      requests: right.requests - left.requests,
      errors: right.errors - left.errors,
      subrequests: right.subrequests - left.subrequests,
    }
  }

  const kvActionTypes = new Set([...Object.keys(before.kv.byActionType), ...Object.keys(after.kv.byActionType)])
  const kvByActionType: Record<string, number> = {}
  for (const actionType of kvActionTypes) {
    kvByActionType[actionType] = (after.kv.byActionType[actionType] ?? 0) - (before.kv.byActionType[actionType] ?? 0)
  }

  const databaseIds = new Set([...Object.keys(before.d1.byDatabaseId), ...Object.keys(after.d1.byDatabaseId)])
  const d1ByDatabaseId: SnapshotDiff['d1']['byDatabaseId'] = {}
  for (const databaseId of databaseIds) {
    const left = before.d1.byDatabaseId[databaseId] ?? { rowsRead: 0, rowsWritten: 0 }
    const right = after.d1.byDatabaseId[databaseId] ?? { rowsRead: 0, rowsWritten: 0 }
    d1ByDatabaseId[databaseId] = {
      rowsRead: right.rowsRead - left.rowsRead,
      rowsWritten: right.rowsWritten - left.rowsWritten,
    }
  }

  let durableDataset: string | null = null
  if (after.durableObjects.dataset && before.durableObjects.dataset === after.durableObjects.dataset) {
    durableDataset = after.durableObjects.dataset
  }

  const durableScripts = new Set([
    ...Object.keys(before.durableObjects.byScript),
    ...Object.keys(after.durableObjects.byScript),
  ])
  const durableByScript: SnapshotDiff['durableObjects']['byScript'] = {}
  for (const scriptName of durableScripts) {
    const left = before.durableObjects.byScript[scriptName] ?? { requests: 0, errors: 0, wallTime: 0 }
    const right = after.durableObjects.byScript[scriptName] ?? { requests: 0, errors: 0, wallTime: 0 }
    durableByScript[scriptName] = {
      requests: right.requests - left.requests,
      errors: right.errors - left.errors,
      wallTime: right.wallTime - left.wallTime,
    }
  }

  let durableTotalRequests: number | null = null
  if (typeof before.durableObjects.totalRequests === 'number' && typeof after.durableObjects.totalRequests === 'number') {
    durableTotalRequests = after.durableObjects.totalRequests - before.durableObjects.totalRequests
  }

  let durableTotalWallTime: number | null = null
  if (typeof before.durableObjects.totalWallTime === 'number' && typeof after.durableObjects.totalWallTime === 'number') {
    durableTotalWallTime = after.durableObjects.totalWallTime - before.durableObjects.totalWallTime
  }

  return {
    before: {
      capturedAt: before.capturedAt,
      from: before.range.from,
      to: before.range.to,
    },
    after: {
      capturedAt: after.capturedAt,
      from: after.range.from,
      to: after.range.to,
    },
    workers: {
      byScript: workersByScript,
      totalRequests: after.workers.totalRequests - before.workers.totalRequests,
    },
    kv: {
      byActionType: kvByActionType,
      totalOperations: after.kv.totalOperations - before.kv.totalOperations,
    },
    d1: {
      byDatabaseId: d1ByDatabaseId,
      totalRowsRead: after.d1.totalRowsRead - before.d1.totalRowsRead,
      totalRowsWritten: after.d1.totalRowsWritten - before.d1.totalRowsWritten,
    },
    durableObjects: {
      dataset: durableDataset,
      byScript: durableByScript,
      totalRequests: durableTotalRequests,
      totalWallTime: durableTotalWallTime,
    },
  }
}

function printSnapshotSummary(snapshot: UsageSnapshot, scripts: string[]): void {
  console.log('[snapshot] Cloudflare usage')
  console.table([
    {
      accountId: snapshot.accountId,
      from: snapshot.range.from,
      to: snapshot.range.to,
      capturedAt: snapshot.capturedAt,
    },
  ])

  const scriptRows = summarizeScripts(snapshot.workers.byScript, scripts)
  console.log('\n[workers] requests by script')
  console.table(scriptRows)

  console.log('\n[kv] operations by actionType')
  console.table(toRows(snapshot.kv.byActionType, 'actionType', 'count'))

  console.log('\n[d1] rows by databaseId')
  console.table(Object.entries(snapshot.d1.byDatabaseId).map(([databaseId, rows]) => ({
    databaseId,
    rowsRead: rows.rowsRead,
    rowsWritten: rows.rowsWritten,
  })))

  console.log('\n[durable objects]')
  console.table([
    {
      dataset: snapshot.durableObjects.dataset ?? 'not found',
      requests: snapshot.durableObjects.totalRequests ?? 'n/a',
      wallTime: snapshot.durableObjects.totalWallTime ?? 'n/a',
    },
  ])

  if (snapshot.durableObjects.dataset) {
    console.table(Object.entries(snapshot.durableObjects.byScript).map(([scriptName, row]) => ({
      scriptName,
      requests: row.requests,
      errors: row.errors,
      wallTime: row.wallTime,
    })))
  }
}

function printDiffSummary(diff: SnapshotDiff, scripts: string[]): void {
  console.log('[diff] Cloudflare usage delta (after - before)')
  console.table([
    {
      beforeCapturedAt: diff.before.capturedAt,
      afterCapturedAt: diff.after.capturedAt,
      beforeTo: diff.before.to,
      afterTo: diff.after.to,
    },
  ])

  const scriptRows = summarizeScripts(diff.workers.byScript, scripts)
  console.log('\n[workers] requests by script delta')
  console.table(scriptRows)

  console.log('\n[kv] operations by actionType delta')
  console.table(toRows(diff.kv.byActionType, 'actionType', 'count'))

  console.log('\n[d1] rows by databaseId delta')
  console.table(Object.entries(diff.d1.byDatabaseId).map(([databaseId, rows]) => ({
    databaseId,
    rowsRead: rows.rowsRead,
    rowsWritten: rows.rowsWritten,
  })))

  console.log('\n[durable objects] delta')
  console.table([
    {
      dataset: diff.durableObjects.dataset ?? 'not found',
      requests: diff.durableObjects.totalRequests ?? 'n/a',
      wallTime: diff.durableObjects.totalWallTime ?? 'n/a',
    },
  ])

  if (diff.durableObjects.dataset) {
    console.table(Object.entries(diff.durableObjects.byScript).map(([scriptName, row]) => ({
      scriptName,
      requests: row.requests,
      errors: row.errors,
      wallTime: row.wallTime,
    })))
  }
}

function summarizeScripts(
  byScript: Record<string, { requests: number, errors: number, subrequests: number }>,
  scripts: string[],
): Array<{ scriptName: string, requests: number, errors: number, subrequests: number }> {
  const wanted = new Set(scripts)
  const exactRows = scripts.map((scriptName) => {
    const row = byScript[scriptName] ?? { requests: 0, errors: 0, subrequests: 0 }
    return { scriptName, ...row }
  })

  const other = Object.entries(byScript)
    .filter(([scriptName]) => !wanted.has(scriptName))
    .reduce((sum, [, row]) => ({
      requests: sum.requests + row.requests,
      errors: sum.errors + row.errors,
      subrequests: sum.subrequests + row.subrequests,
    }), { requests: 0, errors: 0, subrequests: 0 })

  return [...exactRows, { scriptName: '(other)', ...other }]
}

function toRows(record: Record<string, number>, keyName: string, valueName: string): Array<Record<string, string | number>> {
  return Object.entries(record).map(([key, value]) => ({
    [keyName]: key,
    [valueName]: value,
  }))
}

async function queryWorkersByScript(
  apiToken: string,
  accountId: string,
  from: string,
  to: string,
): Promise<Record<string, { requests: number, errors: number, subrequests: number }>> {
  const groupQuery = `
    query Usage {
      viewer {
        accounts(filter: { accountTag: ${graphqlString(accountId)} }) {
          workersInvocationsAdaptiveGroups(
            limit: 1000,
            filter: {
              datetime_geq: ${graphqlString(from)},
              datetime_leq: ${graphqlString(to)}
            }
          ) {
            dimensions {
              scriptName
            }
            sum {
              requests
              errors
              subrequests
            }
          }
        }
      }
    }
  `

  const groupResponse = await queryGraphQl<WorkersGroupsQueryData>(apiToken, groupQuery)
  let rows = groupResponse.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptiveGroups

  if (!rows || groupResponse.errors?.length) {
    const adaptiveQuery = `
      query Usage {
        viewer {
          accounts(filter: { accountTag: ${graphqlString(accountId)} }) {
            workersInvocationsAdaptive(
              limit: 10000,
              filter: {
                datetime_geq: ${graphqlString(from)},
                datetime_leq: ${graphqlString(to)}
              }
            ) {
              dimensions {
                scriptName
              }
              sum {
                requests
                errors
                subrequests
              }
            }
          }
        }
      }
    `

    const adaptiveResponse = await queryGraphQlStrict<WorkersAdaptiveQueryData>(apiToken, adaptiveQuery)
    rows = adaptiveResponse.viewer?.accounts?.[0]?.workersInvocationsAdaptive
  }

  const byScript: Record<string, { requests: number, errors: number, subrequests: number }> = {}

  for (const row of rows ?? []) {
    const scriptName = row?.dimensions?.scriptName?.trim() || '(unknown)'
    const requests = row?.sum?.requests ?? 0
    const errors = row?.sum?.errors ?? 0
    const subrequests = row?.sum?.subrequests ?? 0

    if (!byScript[scriptName]) {
      byScript[scriptName] = { requests: 0, errors: 0, subrequests: 0 }
    }

    byScript[scriptName].requests += requests
    byScript[scriptName].errors += errors
    byScript[scriptName].subrequests += subrequests
  }

  return byScript
}

async function queryKvByActionType(
  apiToken: string,
  accountId: string,
  from: string,
  to: string,
): Promise<Record<string, number>> {
  const query = `
    query Usage {
      viewer {
        accounts(filter: { accountTag: ${graphqlString(accountId)} }) {
          kvOperationsAdaptiveGroups(
            limit: 1000,
            filter: {
              datetime_geq: ${graphqlString(from)},
              datetime_leq: ${graphqlString(to)}
            }
          ) {
            count
            dimensions {
              actionType
            }
          }
        }
      }
    }
  `

  const data = await queryGraphQlStrict<KvQueryData>(apiToken, query)
  const rows = data.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? []

  const byActionType: Record<string, number> = {}
  for (const row of rows) {
    const actionType = row?.dimensions?.actionType?.trim() || '(unknown)'
    byActionType[actionType] = (byActionType[actionType] ?? 0) + (row?.count ?? 0)
  }

  return byActionType
}

async function queryD1ByDatabaseId(
  apiToken: string,
  accountId: string,
  from: string,
  to: string,
): Promise<Record<string, { rowsRead: number, rowsWritten: number }>> {
  const query = `
    query Usage {
      viewer {
        accounts(filter: { accountTag: ${graphqlString(accountId)} }) {
          d1AnalyticsAdaptiveGroups(
            limit: 1000,
            filter: {
              datetimeMinute_geq: ${graphqlString(from)},
              datetimeMinute_leq: ${graphqlString(to)}
            }
          ) {
            sum {
              rowsRead
              rowsWritten
            }
            dimensions {
              databaseId
            }
          }
        }
      }
    }
  `

  const data = await queryGraphQlStrict<D1QueryData>(apiToken, query)
  const rows = data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []

  const byDatabaseId: Record<string, { rowsRead: number, rowsWritten: number }> = {}
  for (const row of rows) {
    const databaseId = row?.dimensions?.databaseId?.trim() || '(unknown)'
    if (!byDatabaseId[databaseId]) {
      byDatabaseId[databaseId] = { rowsRead: 0, rowsWritten: 0 }
    }

    byDatabaseId[databaseId].rowsRead += row?.sum?.rowsRead ?? 0
    byDatabaseId[databaseId].rowsWritten += row?.sum?.rowsWritten ?? 0
  }

  return byDatabaseId
}

async function queryAccountDurableFields(apiToken: string): Promise<string[]> {
  const query = `
    query DiscoverAccountFields {
      __type(name: "account") {
        fields {
          name
        }
      }
    }
  `

  const response = await queryGraphQl<AccountFieldsQueryData>(apiToken, query)
  const fields = response.data?.__type?.fields ?? []
  return fields
    .map(field => field?.name?.trim() ?? '')
    .filter(Boolean)
    .filter(fieldName => /durable|object/i.test(fieldName))
    .sort((a, b) => a.localeCompare(b))
}

async function queryDurableObjectsUsage(
  apiToken: string,
  accountId: string,
  from: string,
  to: string,
  discoveredFields: string[],
): Promise<{
  dataset: string | null
  byScript: Record<string, { requests: number, errors: number, wallTime: number }>
  totalRequests: number | null
  totalWallTime: number | null
}> {
  const candidates = discoveredFields
    .filter(fieldName => fieldName.endsWith('AdaptiveGroups'))
    .filter(fieldName => /durable|object/i.test(fieldName))

  const preferred = [
    'durableObjectsInvocationsAdaptiveGroups',
    ...candidates.filter(name => name !== 'durableObjectsInvocationsAdaptiveGroups'),
  ]

  for (const fieldName of preferred) {
    const query = `
      query Usage {
        viewer {
          accounts(filter: { accountTag: ${graphqlString(accountId)} }) {
            ${fieldName}(
              limit: 1000,
              filter: {
                datetime_geq: ${graphqlString(from)},
                datetime_leq: ${graphqlString(to)}
              }
            ) {
              dimensions {
                scriptName
              }
              sum {
                requests
                errors
                wallTime
              }
            }
          }
        }
      }
    `

    const response = await queryGraphQl(apiToken, query)
    if (response.errors?.length) continue

    const account = response.data?.viewer?.accounts?.[0] as Record<string, unknown> | undefined
    const rows = account?.[fieldName]
    if (!Array.isArray(rows)) continue

    const byScript: Record<string, { requests: number, errors: number, wallTime: number }> = {}

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const dimensions = (row as { dimensions?: { scriptName?: unknown } }).dimensions
      const sum = (row as {
        sum?: {
          requests?: unknown
          errors?: unknown
          wallTime?: unknown
        }
      }).sum

      const scriptName = typeof dimensions?.scriptName === 'string' && dimensions.scriptName.trim().length > 0
        ? dimensions.scriptName.trim()
        : '(unknown)'

      if (!byScript[scriptName]) {
        byScript[scriptName] = {
          requests: 0,
          errors: 0,
          wallTime: 0,
        }
      }

      byScript[scriptName].requests += typeof sum?.requests === 'number' ? sum.requests : 0
      byScript[scriptName].errors += typeof sum?.errors === 'number' ? sum.errors : 0
      byScript[scriptName].wallTime += typeof sum?.wallTime === 'number' ? sum.wallTime : 0
    }

    return {
      dataset: fieldName,
      byScript,
      totalRequests: Object.values(byScript).reduce((sum, row) => sum + row.requests, 0),
      totalWallTime: Object.values(byScript).reduce((sum, row) => sum + row.wallTime, 0),
    }
  }

  return {
    dataset: null,
    byScript: {},
    totalRequests: null,
    totalWallTime: null,
  }
}

async function queryGraphQlStrict<T>(apiToken: string, query: string): Promise<T> {
  const response = await queryGraphQl<T>(apiToken, query)

  if (response.errors?.length) {
    const messages = response.errors.map(error => error.message).join('; ')
    throw new Error(`GraphQL error: ${messages}`)
  }

  if (!response.data) {
    throw new Error('GraphQL response did not include data')
  }

  return response.data
}

async function queryGraphQl<T>(apiToken: string, query: string): Promise<GraphQlResponse<T>> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query }),
  })

  const bodyText = await res.text()
  let bodyJson: GraphQlResponse<T>

  try {
    bodyJson = JSON.parse(bodyText) as GraphQlResponse<T>
  }
  catch {
    throw new Error(`Non-JSON GraphQL response: ${bodyText.slice(0, 300)}`)
  }

  if (!res.ok) {
    const messages = bodyJson.errors?.map(error => error.message).join('; ')
    throw new Error(`HTTP ${res.status} from GraphQL endpoint${messages ? `: ${messages}` : ''}`)
  }

  return bodyJson
}

function startOfUtcDayIso(iso: string): string {
  const date = new Date(iso)
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  )).toISOString()
}

function graphqlString(value: string): string {
  return JSON.stringify(value)
}

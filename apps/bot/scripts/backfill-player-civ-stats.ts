/* eslint-disable no-console */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { redDeathLeaderMap } from '@civup/game'
import { Database as SqliteDatabase } from 'bun:sqlite'

type Action = 'estimate' | 'apply'

interface Options {
  action: Action
  config: string
  database: string
  remote: boolean
  yes: boolean
  batchSize: number
  verify: boolean
}

interface Estimate {
  eligibleLeaderMatches: number
  eligibleLeaderParticipantRows: number
  missingContributionMatches: number
  missingLeaderParticipantRows: number
  missingAggregateDeltaRows: number
  existingContributionRows: number
  existingAggregateRows: number
  d1RowsRead?: number
}

interface WranglerResult {
  results?: Array<Record<string, unknown>>
  success?: boolean
  error?: string
  meta?: {
    rows_read?: number
  }
}

let localD1SqlitePath: string | null = null
let lastProgressLength = 0

const usage = [
  'Usage: bun scripts/backfill-player-civ-stats.ts <estimate|apply> [flags]',
  '',
  'Flags:',
  '  --local             Use local D1 storage (default)',
  '  --remote            Use remote D1 storage',
  '  --config <path>     Wrangler config (default: apps/bot/wrangler.jsonc)',
  '  --database <name>   D1 database name (default: civup)',
  '  --batch-size <n>    Matches per apply batch (default: 500)',
  '  --verify            Run a full estimate after apply',
  '  --yes               Required for remote apply',
  '',
  'Examples:',
  '  bun scripts/backfill-player-civ-stats.ts estimate --local',
  '  bun scripts/backfill-player-civ-stats.ts apply --local',
  '  bun scripts/backfill-player-civ-stats.ts estimate --remote',
  '  bun scripts/backfill-player-civ-stats.ts apply --remote --yes',
].join('\n')

const options = parseOptions(Bun.argv.slice(2))

if (options.action === 'estimate') {
  const estimate = await estimateBackfill(options)
  printEstimate(options, estimate)
}
else {
  if (options.remote && !options.yes) {
    console.error('Remote apply requires --yes.')
    process.exit(1)
  }

  const before = await estimateBackfill(options)
  printEstimate(options, before)
  if (before.missingContributionMatches === 0 && before.missingAggregateDeltaRows === 0) {
    console.log('No missing player leader stats to backfill.')
    process.exit(0)
  }

  await applyMissingContributions(options, Date.now(), before)
  console.log('Backfill applied.')

  if (options.verify) {
    const after = await estimateBackfill(options)
    printEstimate(options, after)
  }
  else {
    console.log('Skipped post-apply verification to save D1 reads. Run estimate when needed.')
  }
}

async function estimateBackfill(options: Options): Promise<Estimate> {
  const estimate = await readEstimate(options)

  return {
    eligibleLeaderMatches: normalizeCount(estimate.metrics.eligible_leader_matches),
    eligibleLeaderParticipantRows: normalizeCount(estimate.metrics.eligible_leader_participant_rows),
    missingContributionMatches: normalizeCount(estimate.metrics.missing_contribution_matches),
    missingLeaderParticipantRows: normalizeCount(estimate.metrics.missing_leader_participant_rows),
    missingAggregateDeltaRows: normalizeCount(estimate.metrics.missing_aggregate_delta_rows),
    existingContributionRows: normalizeCount(estimate.metrics.existing_contribution_rows),
    existingAggregateRows: normalizeCount(estimate.metrics.existing_aggregate_rows),
    d1RowsRead: estimate.d1RowsRead,
  }
}

function buildEstimateSql(): string {
  return `with
    ${buildEntriesCte('eligible_entries', { missingOnly: false })},
    ${buildEntriesCte('missing_entries', { missingOnly: true })}
    select
      (select count(distinct match_id) from eligible_entries) as eligible_leader_matches,
      (select coalesce(sum(picks), 0) from eligible_entries) as eligible_leader_participant_rows,
      (select count(distinct match_id) from missing_entries) as missing_contribution_matches,
      (select coalesce(sum(picks), 0) from missing_entries) as missing_leader_participant_rows,
      (select count(*) from (
        select 1 from missing_entries group by season_id, game_mode, player_id, civ_id
      )) as missing_aggregate_delta_rows,
      (select count(*) from match_player_civ_stat_contributions) as existing_contribution_rows,
      (select count(*) from player_civ_stats) as existing_aggregate_rows`
}

function buildApplyBatchSql(updatedAt: number, batchSize: number): string {
  const cte = buildBatchEntriesCte('missing_entries', batchSize)
  return [
    `with ${buildBatchAggregateCte(batchSize)}
      insert into player_civ_stats (season_id, game_mode, player_id, civ_id, picks, wins, updated_at)
      select season_id, game_mode, player_id, civ_id, picks, wins, ${updatedAt}
      from aggregate_totals
      where true
      on conflict(season_id, game_mode, player_id, civ_id) do update set
        picks = excluded.picks,
        wins = excluded.wins,
        updated_at = excluded.updated_at`,
    `with ${cte}
      insert into match_player_civ_stat_contributions (match_id, contributions_json, updated_at)
      select match_id,
        json_group_array(json_object(
          'seasonId', season_id,
          'gameMode', game_mode,
          'playerId', player_id,
          'civId', civ_id,
          'picks', picks,
          'wins', wins
        )),
        ${updatedAt}
      from (
        select * from missing_entries
        order by match_id, season_id, game_mode, player_id, civ_id
      )
      group by match_id`,
  ].join(';\n')
}

function buildBatchAggregateCte(batchSize: number): string {
  return `${buildBatchEntriesCte('missing_entries', batchSize)},
  affected_keys as (
    select distinct season_id, game_mode, player_id, civ_id
    from missing_entries
  ),
  aggregate_totals as (
    select
      coalesce(m.season_id, '') as season_id,
      m.game_mode as game_mode,
      mp.player_id as player_id,
      mp.civ_id as civ_id,
      count(*) as picks,
      sum(case when mp.placement = 1 then 1 else 0 end) as wins
    from affected_keys affected
    inner join matches m on m.game_mode = affected.game_mode
      and coalesce(m.season_id, '') = affected.season_id
    inner join match_participants mp on mp.match_id = m.id
      and mp.player_id = affected.player_id
      and mp.civ_id = affected.civ_id
    where ${buildEligibleParticipantWhereClause()}
    group by coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id
  )`
}

function buildBatchEntriesCte(name: string, batchSize: number): string {
  return `selected_matches as (
    select m.id as match_id
    from matches m
    inner join match_participants mp on mp.match_id = m.id
    left join match_player_civ_stat_contributions existing on existing.match_id = m.id
    where existing.match_id is null
      and ${buildEligibleParticipantWhereClause()}
    group by m.id
    order by min(m.created_at), m.id
    limit ${batchSize}
  ),
  ${name} as (
    select
      m.id as match_id,
      coalesce(m.season_id, '') as season_id,
      m.game_mode as game_mode,
      mp.player_id as player_id,
      mp.civ_id as civ_id,
      count(*) as picks,
      sum(case when mp.placement = 1 then 1 else 0 end) as wins
    from selected_matches selected
    inner join matches m on m.id = selected.match_id
    inner join match_participants mp on mp.match_id = m.id
    where ${buildEligibleParticipantWhereClause()}
    group by m.id, coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id
  )`
}

function buildEntriesCte(name: string, options: { missingOnly: boolean }): string {
  const contributionJoin = options.missingOnly
    ? 'left join match_player_civ_stat_contributions existing on existing.match_id = m.id'
    : ''
  const missingCondition = options.missingOnly ? 'and existing.match_id is null' : ''

  return `${name} as (
    select
      m.id as match_id,
      coalesce(m.season_id, '') as season_id,
      m.game_mode as game_mode,
      mp.player_id as player_id,
      mp.civ_id as civ_id,
      count(*) as picks,
      sum(case when mp.placement = 1 then 1 else 0 end) as wins
    from match_participants mp
    inner join matches m on mp.match_id = m.id
    ${contributionJoin}
    where ${buildEligibleWhereClause()}
      ${missingCondition}
    group by m.id, coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id
  )`
}

function buildEligibleWhereClause(): string {
  return buildEligibleParticipantWhereClause()
}

function buildEligibleParticipantWhereClause(): string {
  const redDeathLeaderIds = [...redDeathLeaderMap.keys()]
  const redDeathClause = redDeathLeaderIds.length > 0
    ? `and mp.civ_id not in (${redDeathLeaderIds.map(sqlString).join(', ')})`
    : ''

  return `${buildEligibleMatchWhereClause()}
      and mp.civ_id is not null
      ${redDeathClause}`
}

function buildEligibleMatchWhereClause(): string {
  return `m.status = 'completed'
      and not exists (
        select 1 from tournament_matches tm
        where tm.match_id = m.id or tm.session_id = m.id
      )
      and case
        when m.draft_data is null then 1
        when not json_valid(m.draft_data) then 1
        when coalesce(json_extract(m.draft_data, '$.redDeath'), 0) = 1 then 0
        when coalesce(json_extract(m.draft_data, '$.civBlitz'), 0) = 1 then 0
        else 1
      end = 1`
}

async function readEstimate(options: Options): Promise<{ metrics: Record<string, number>, d1RowsRead?: number }> {
  const sql = buildEstimateSql()
  if (options.remote) {
    return readRemoteEstimate(options)
  }

  const db = openLocalD1Database(true)
  try {
    return {
      metrics: rowsToMetrics(db.query(sql).all() as Array<Record<string, unknown>>),
    }
  }
  finally {
    db.close()
  }
}

async function readRemoteEstimate(options: Options): Promise<{ metrics: Record<string, number>, d1RowsRead?: number }> {
  const metrics: Record<string, number> = {}
  let d1RowsRead = 0

  for (const query of buildRemoteEstimateQueries()) {
    const [result] = await executeRemoteCommandSql(options, query.sql)
    metrics[query.metric] = normalizeCount(result?.results?.[0]?.count)
    d1RowsRead += normalizeCount(result?.meta?.rows_read)
  }

  return { metrics, d1RowsRead }
}

async function applyMissingContributions(options: Options, updatedAt: number, estimate: Estimate): Promise<void> {
  const total = estimate.missingContributionMatches
  const batchSize = options.batchSize
  const totalBatches = Math.ceil(total / batchSize)
  let processed = 0
  const startedAt = Date.now()

  console.log(`Applying ${total} missing matches in ${totalBatches} batches of up to ${batchSize}.`)
  renderProgress({ processed, total, batch: 0, totalBatches, startedAt })

  for (let batch = 1; batch <= totalBatches; batch += 1) {
    await executeApplySql(options, buildApplyBatchSql(updatedAt, batchSize))
    processed = Math.min(total, processed + batchSize)
    renderProgress({ processed, total, batch, totalBatches, startedAt })
  }
}

function renderProgress(input: { processed: number, total: number, batch: number, totalBatches: number, startedAt: number }): void {
  const width = 28
  const ratio = input.total > 0 ? input.processed / input.total : 1
  const filled = Math.max(0, Math.min(width, Math.round(width * ratio)))
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`
  const percent = `${Math.round(ratio * 100)}`.padStart(3, ' ')
  const elapsed = formatDuration(Date.now() - input.startedAt)
  const line = `[${bar}] ${percent}% ${input.processed}/${input.total} matches batch ${input.batch}/${input.totalBatches} elapsed ${elapsed}`
  const padded = line.padEnd(lastProgressLength, ' ')
  lastProgressLength = line.length
  process.stdout.write(`\r${padded}`)
  if (input.processed >= input.total) {
    process.stdout.write('\n')
    lastProgressLength = 0
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

function buildRemoteEstimateQueries(): Array<{ metric: string, sql: string }> {
  return [
    {
      metric: 'eligible_leader_matches',
      sql: `select count(*) as count from matches m where ${buildEligibleMatchWhereClause()}`,
    },
    {
      metric: 'eligible_leader_participant_rows',
      sql: `select count(*) as count from matches m inner join match_participants mp on mp.match_id = m.id where ${buildEligibleParticipantWhereClause()}`,
    },
    {
      metric: 'missing_contribution_matches',
      sql: `select count(distinct m.id) as count from matches m inner join match_participants mp on mp.match_id = m.id left join match_player_civ_stat_contributions existing on existing.match_id = m.id where existing.match_id is null and ${buildEligibleParticipantWhereClause()}`,
    },
    {
      metric: 'missing_leader_participant_rows',
      sql: `select count(*) as count from matches m inner join match_participants mp on mp.match_id = m.id left join match_player_civ_stat_contributions existing on existing.match_id = m.id where existing.match_id is null and ${buildEligibleParticipantWhereClause()}`,
    },
    {
      metric: 'missing_aggregate_delta_rows',
      sql: `select count(*) as count from (select coalesce(m.season_id, '') as season_id, m.game_mode, mp.player_id, mp.civ_id from matches m inner join match_participants mp on mp.match_id = m.id left join match_player_civ_stat_contributions existing on existing.match_id = m.id where existing.match_id is null and ${buildEligibleParticipantWhereClause()} group by coalesce(m.season_id, ''), m.game_mode, mp.player_id, mp.civ_id)`,
    },
    {
      metric: 'existing_contribution_rows',
      sql: 'select count(*) as count from match_player_civ_stat_contributions',
    },
    {
      metric: 'existing_aggregate_rows',
      sql: 'select count(*) as count from player_civ_stats',
    },
  ]
}

async function executeApplySql(options: Options, sql: string): Promise<void> {
  if (options.remote) {
    await executeRemoteSql(options, sql)
    return
  }

  const db = openLocalD1Database(false)
  try {
    db.exec(sql)
  }
  finally {
    db.close()
  }
}

async function executeRemoteSql(options: Options, sql: string): Promise<WranglerResult[]> {
  const command = normalizeWranglerSql(sql)
  const sqlFile = resolve(tmpdir(), `civup-player-civ-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)
  await Bun.write(sqlFile, command)
  const args = [
    'x',
    'wrangler',
    'd1',
    'execute',
    options.database,
    '--config',
    options.config,
    options.remote ? '--remote' : '--local',
    '--file',
    sqlFile,
    '--json',
  ]
  const proc = Bun.spawn(['bun', ...args], { stdout: 'pipe', stderr: 'pipe' })
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
  }
  finally {
    rmSync(sqlFile, { force: true })
  }

  if (exitCode !== 0) {
    if (stderr.trim()) console.error(stderr.trim())
    if (stdout.trim()) console.error(stdout.trim())
    throw new Error(`wrangler d1 execute failed with exit code ${exitCode}`)
  }

  const parsed = parseWranglerJson(stdout)
  const failed = parsed.find(entry => entry.success === false)
  if (failed) throw new Error(failed.error ?? 'wrangler d1 execute failed')
  return parsed
}

async function executeRemoteCommandSql(options: Options, sql: string): Promise<WranglerResult[]> {
  const command = normalizeWranglerSql(sql)
  const args = [
    'x',
    'wrangler',
    'd1',
    'execute',
    options.database,
    '--config',
    options.config,
    options.remote ? '--remote' : '--local',
    '--command',
    command,
    '--json',
  ]
  const proc = Bun.spawn(['bun', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    if (stderr.trim()) console.error(stderr.trim())
    if (stdout.trim()) console.error(stdout.trim())
    throw new Error(`wrangler d1 execute failed with exit code ${exitCode}`)
  }

  const parsed = parseWranglerJson(stdout)
  const failed = parsed.find(entry => entry.success === false)
  if (failed) throw new Error(failed.error ?? 'wrangler d1 execute failed')
  return parsed
}

function parseWranglerJson(stdout: string): WranglerResult[] {
  const trimmed = stdout.trim()
  const jsonStart = trimmed.indexOf('[')
  if (jsonStart < 0) throw new Error(`wrangler returned non-JSON output: ${trimmed}`)
  return JSON.parse(trimmed.slice(jsonStart)) as WranglerResult[]
}

function openLocalD1Database(readonly: boolean): SqliteDatabase {
  return readonly
    ? new SqliteDatabase(resolveLocalD1SqlitePath(), { readonly: true })
    : new SqliteDatabase(resolveLocalD1SqlitePath())
}

function resolveLocalD1SqlitePath(): string {
  if (localD1SqlitePath) return localD1SqlitePath

  const d1Dir = resolve(import.meta.dir, '../.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  if (!existsSync(d1Dir)) throw new Error(`Local D1 directory not found: ${d1Dir}`)

  for (const file of readdirSync(d1Dir)) {
    if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue
    const sqlitePath = resolve(d1Dir, file)
    const db = new SqliteDatabase(sqlitePath, { readonly: true })
    try {
      const tables = new Set((db
        .query("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>).map(row => row.name))
      if (tables.has('matches') && tables.has('match_participants') && tables.has('player_civ_stats')) {
        localD1SqlitePath = sqlitePath
        return sqlitePath
      }
    }
    finally {
      db.close()
    }
  }

  throw new Error(`Could not find a local D1 SQLite file in ${d1Dir}`)
}

function normalizeWranglerSql(sql: string): string {
  const normalized = sql
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join(' ')
  return normalized.endsWith(';') ? normalized : `${normalized};`
}

function printEstimate(options: Options, estimate: Estimate): void {
  console.log(`Target: ${options.database} (${options.remote ? 'remote' : 'local'})`)
  console.log(`Config: ${options.config}`)
  console.log(`Eligible leader matches: ${estimate.eligibleLeaderMatches}`)
  console.log(`Eligible leader participant rows: ${estimate.eligibleLeaderParticipantRows}`)
  console.log(`Missing contribution matches: ${estimate.missingContributionMatches}`)
  console.log(`Missing leader participant rows: ${estimate.missingLeaderParticipantRows}`)
  console.log(`Missing aggregate delta rows: ${estimate.missingAggregateDeltaRows}`)
  console.log(`Existing contribution rows: ${estimate.existingContributionRows}`)
  console.log(`Existing aggregate rows: ${estimate.existingAggregateRows}`)
  const minimumWrites = estimate.missingContributionMatches + estimate.missingAggregateDeltaRows
  const upperBoundWrites = estimate.missingContributionMatches + estimate.missingLeaderParticipantRows
  console.log(`Estimated apply row writes: ${minimumWrites}-${upperBoundWrites}`)
  if (estimate.d1RowsRead != null) console.log(`Estimate D1 rows read: ${estimate.d1RowsRead}`)
}

function parseOptions(args: string[]): Options {
  const action = args.find(arg => !arg.startsWith('--'))
  if (action !== 'estimate' && action !== 'apply') {
    console.log(usage)
    process.exit(action ? 1 : 0)
  }

  const options: Options = {
    action,
    config: resolve(import.meta.dir, '../wrangler.jsonc'),
    database: 'civup',
    remote: false,
    yes: false,
    batchSize: 500,
    verify: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue

    switch (arg) {
      case '--local': {
        options.remote = false
        break
      }
      case '--remote': {
        options.remote = true
        break
      }
      case '--config': {
        const value = args[index + 1]
        if (!value) throw new Error('Missing --config value.')
        options.config = resolve(process.cwd(), value)
        index += 1
        break
      }
      case '--database': {
        const value = args[index + 1]
        if (!value) throw new Error('Missing --database value.')
        options.database = value
        index += 1
        break
      }
      case '--batch-size': {
        const value = args[index + 1]
        if (!value) throw new Error('Missing --batch-size value.')
        const batchSize = Number(value)
        if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error('--batch-size must be a positive integer.')
        options.batchSize = batchSize
        index += 1
        break
      }
      case '--verify': {
        options.verify = true
        break
      }
      case '--yes': {
        options.yes = true
        break
      }
      case '--help': {
        console.log(usage)
        process.exit(0)
      }
      default:
        throw new Error(`Unknown flag: ${arg}`)
    }
  }

  return options
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed))
  }
  return 0
}

function rowsToMetrics(rows: Array<Record<string, unknown>>): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const row of rows) {
    if (typeof row.metric === 'string') {
      metrics[row.metric] = normalizeCount(row.value)
      continue
    }

    for (const [key, value] of Object.entries(row)) {
      metrics[key] = normalizeCount(value)
    }
  }
  return metrics
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/* eslint-disable no-console */
import type { CloudflareTargetName } from '../../../config/cloudflare-targets.ts'
import type { CivLeaderboardBackfillSource } from './civ-leaderboard-backfill-shared.ts'
import { createDb } from '@civup/db'
import { runCivLeaderboardBackfill } from './civ-leaderboard-backfill-shared.ts'
import { createMaintenanceBindings, createMaintenanceClient } from './maintenance-cloudflare.ts'

export function parseCivBackfillOptions(
  values: string[],
  defaults: { target: CloudflareTargetName; location: 'local' | 'remote' } = { target: 'standard', location: 'local' },
) {
  let command: 'estimate' | 'preview' | 'apply' | 'help' = 'preview'
  let source: CivLeaderboardBackfillSource = 'history'
  let location = defaults.location
  let target: string | undefined
  let config: string | undefined
  let database: string | undefined
  let execute = false
  let json = false
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value === 'estimate' || value === 'preview' || value === 'apply') command = value
    else if (value === 'help' || value === '--help' || value === '-h') command = 'help'
    else if (value === '--execute') execute = true
    else if (value === '--json') json = true
    else if (value === '--local') location = 'local'
    else if (value === '--remote' || value === '--prod' || value === '--ppl') location = 'remote'
    else if (value === '--repair' || value === '--from-contributions') source = 'contributions'
    else if (value === '--target' || value === '--config' || value === '--database') {
      const next = values[++index]
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${value}.`)
      if (value === '--target') target = next
      else if (value === '--config') config = next
      else database = next
    } else throw new Error(`Unknown option: ${value}`)
  }
  // The PPL entrypoint historically used standard dev data for --local.
  const defaultTarget = defaults.target === 'ppl' && location === 'local' ? 'standard' : defaults.target
  return { command, source, location, target, config, database, execute, json, defaultTarget }
}

export async function runCivBackfill(
  values: string[],
  defaults: { target: CloudflareTargetName; location: 'local' | 'remote' } = { target: 'standard', location: 'local' },
) {
  const options = parseCivBackfillOptions(values, defaults)
  if (options.command === 'help') {
    console.log(
      'Usage: backfill-civ-leaderboard.ts estimate|preview|apply [--target standard|ppl] [--local|--remote] [--repair] [--execute] [--json]',
    )
    console.log(`Default: ${defaults.target} ${defaults.location}. Apply requires --execute.`)
    return
  }
  const runtime = createMaintenanceClient(options, options.location)
  const { d1, kv } = createMaintenanceBindings(runtime.client)
  const identity = `${runtime.selection.target}:${runtime.selection.accountId}:${runtime.selection.kv.id}`
  if (options.command === 'estimate') {
    const result = await estimateCivBackfill(d1)
    const output = { target: options.location, config: identity, database: runtime.selection.d1.id, ...result }
    if (options.json) console.log(JSON.stringify(output, null, 2))
    else
      for (const [key, value] of Object.entries(output))
        console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`)
    return
  }
  await runCivLeaderboardBackfill({
    command: options.command,
    source: options.source,
    execute: options.execute,
    json: options.json,
    target: options.location,
    config: identity,
    database: runtime.selection.d1.id,
    db: createDb(d1),
    kv,
    includeHistoricalPreview: false,
    applyHint: `bun ${defaults.target === 'ppl' ? 'ppl' : 'apps/bot/scripts'}/backfill-civ-leaderboard.ts apply --target ${runtime.selection.target} --${options.location}${options.source === 'contributions' ? ' --repair' : ''} --execute`,
    onProgress: options.json ? undefined : label => console.log(`[civ-leaderboard] ${label}`),
  })
}

async function estimateCivBackfill(d1: D1Database) {
  const rows = async <T>(sql: string) => (await d1.prepare(sql).all<T>()).results
  const count = async (sql: string) => Number((await rows<{ count: number }>(sql))[0]?.count ?? 0)
  const table = async (name: string) =>
    (await count(`select count(*) as count from sqlite_master where type = 'table' and name = '${name}'`)) > 0
  const eligible = `c.completed_match_count > 0
    and exists (select 1 from matches m where m.id = c.match_id and m.status = 'completed'
      and not coalesce(json_valid(m.draft_data) and json_extract(m.draft_data, '$.redDeath') = true, false)
      and not coalesce(json_valid(m.draft_data) and json_extract(m.draft_data, '$.civBlitz') = true, false))
    and not exists (select 1 from tournament_matches t where t.match_id = c.match_id or t.session_id = c.match_id)`
  const contributionRows = await count('select count(*) as count from match_civ_stat_contributions')
  const eligibleContributionRows = await count(
    `select count(*) as count from match_civ_stat_contributions c where ${eligible}`,
  )
  const betaEligibleContributionRows =
    await count(`select count(*) as count from match_civ_stat_contributions c where ${eligible}
    and exists (select 1 from matches m where m.id = c.match_id and json_valid(m.draft_data) and json_extract(m.draft_data, '$.leaderDataVersion') = 'beta')`)
  const legacyArrayPayloadRows = await count(
    "select count(*) as count from match_civ_stat_contributions where json_valid(contributions_json) and json_type(contributions_json) = 'array'",
  )
  const scopes = await rows<{
    modeScope: string
    count: number
  }>(`select case when m.game_mode = '1v1' then 'duel' when m.game_mode = '2v2' then 'duo'
    when m.game_mode in ('3v3','4v4','5v5','6v6') then 'squad' else 'all' end as modeScope, count(*) as count
    from match_civ_stat_contributions c inner join matches m on m.id = c.match_id where ${eligible} group by modeScope order by modeScope`)
  const columns = await rows<{ name: string }>('pragma table_info(match_civ_stat_contributions)')
  const contributionMetadataColumnsPresent = ['source', 'mode_scope', 'completed_at', 'visible'].every(name =>
    columns.some(column => column.name === name),
  )
  const poolTotalsTablePresent = await table('civ_stat_pool_totals')
  const civStatsRows = (await table('civ_stats')) ? await count('select count(*) as count from civ_stats') : 0
  const civStatPoolTotalRows = poolTotalsTablePresent
    ? await count('select count(*) as count from civ_stat_pool_totals')
    : 0
  const repairRowsRead = Math.ceil(contributionRows * 10 + civStatsRows + civStatPoolTotalRows + 5000)
  const repairRowsWritten = Math.ceil(2 * (eligibleContributionRows + civStatsRows + civStatPoolTotalRows + 1500))
  const migrationRowsReadIfNotApplied = contributionMetadataColumnsPresent ? 0 : Math.ceil(contributionRows * 4 + 5000)
  const migrationRowsWrittenIfNotApplied = contributionMetadataColumnsPresent
    ? 0
    : Math.ceil(2 * (contributionRows + civStatsRows + 10))
  return {
    contributionRows,
    eligibleContributionRows,
    betaEligibleContributionRows,
    legacyArrayPayloadRows,
    contributionRowsByScope: Object.fromEntries(scopes.map(row => [row.modeScope, row.count])),
    schema: { contributionMetadataColumnsPresent, poolTotalsTablePresent, civStatsRows, civStatPoolTotalRows },
    estimatedTwoX: {
      estimateCommandRowsRead: Math.ceil(contributionRows * 8 + 5000),
      repairRowsRead,
      repairRowsWritten,
      migrationRowsReadIfNotApplied,
      migrationRowsWrittenIfNotApplied,
      migrationPlusRepairRowsReadIfNotApplied: migrationRowsReadIfNotApplied + repairRowsRead,
      migrationPlusRepairRowsWrittenIfNotApplied: migrationRowsWrittenIfNotApplied + repairRowsWritten,
    },
    notes: [
      'contributionRows is N: existing match_civ_stat_contributions rows.',
      'Estimates are intentionally doubled and rounded up.',
      'Repair reads existing contribution rows and rebuilds civ aggregate/KV state; it does not read match_participants or rewrite matches.',
      'Repair write estimate assumes every eligible contribution has a unique pool; repeated pools will write less.',
    ],
  }
}

if (import.meta.main) await runCivBackfill(Bun.argv.slice(2))

/* eslint-disable no-console */
import type { CloudflareD1Statement } from '../../../scripts/cloudflare-client.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveCloudflareTarget } from '../../../config/cloudflare-targets.ts'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '../../../packages/utils/src/activity-auth.ts'
import { prepareSeasonBulkCancellation } from '../src/services/season/replay.ts'
import { createMaintenanceClient } from './maintenance-cloudflare.ts'
import { cancellationCompletionBatch } from './season-cancellation-completion.ts'
import {
  cancellationMaintenanceGuard,
  createCancellationSource,
  writeCancellationAudit,
} from './season-cancellation-source.ts'
import { assertSeasonCancellationCompactionTriggers, compactSeasonCancellationSql } from './season-cancellation-sql.ts'
import { replayPostconditions } from './season-cancellation-verification.ts'

interface CancellationPlan {
  version: 2
  operationId: string
  target: 'standard' | 'ppl'
  accountId: string
  databaseId: string
  guildId: string
  seasonId: string
  matchIds: string[]
  affectedMatchIds: string[]
  cancelledAt: number
  generation: number
  maintenanceState: string
  sourceUsage: { requests: number; rowsRead: number; rowsWritten: number }
  statements: CloudflareD1Statement[]
  verification: CloudflareD1Statement[]
  digest: string
}

function digest(plan: Omit<CancellationPlan, 'digest'>) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

function options(args: string[]) {
  const values = new Map<string, string[]>()
  let execute = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!
    if (key === '--execute' && !execute) {
      execute = true
      continue
    }
    if (
      !['--target', '--season', '--match', '--out', '--plan', '--lease'].includes(key) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith('--')
    ) {
      throw new Error(
        'Use preview --target standard|ppl --season ID --match ID [--match ID ...] --out DIRECTORY; apply|finish|verify --plan FILE; recover-finish --plan FILE --match ID --lease ID; pause|resume --target standard|ppl --out DIRECTORY. Changes require --execute.',
      )
    }
    if (key !== '--match' && values.has(key)) throw new Error(`Repeated option: ${key}`)
    values.set(key, [...(values.get(key) ?? []), args[++index]!])
  }
  return { values, execute }
}

function selectedTarget(value: string | undefined): 'standard' | 'ppl' {
  if (value !== 'standard' && value !== 'ppl') throw new Error('Choose --target standard or ppl explicitly.')
  return value
}

async function readPlan(path: string): Promise<CancellationPlan> {
  const plan = (await Bun.file(path).json()) as CancellationPlan
  const { digest: expected, ...content } = plan
  if (
    plan.version !== 2 ||
    digest(content) !== expected ||
    !plan.matchIds.length ||
    !plan.statements.length ||
    plan.operationId !== `season-cancellation:${plan.cancelledAt}:${plan.seasonId}`
  ) {
    throw new Error('The cancellation plan is invalid or has changed.')
  }
  const target = resolveCloudflareTarget(selectedTarget(plan.target))
  if (
    target.accountId !== plan.accountId ||
    target.d1.id !== plan.databaseId ||
    target.discord.guildId !== plan.guildId
  ) {
    throw new Error('The plan belongs to different Cloudflare resources.')
  }
  return plan
}

function adminClient(targetName: 'standard' | 'ppl') {
  const target = resolveCloudflareTarget(targetName)
  const origin = new URL(target.activityOrigin)
  if (!origin.hostname.startsWith(`${target.workers.activity}.`) || !origin.hostname.endsWith('.workers.dev')) {
    throw new Error('This tool requires the configured workers.dev Activity origin to locate the bot.')
  }
  origin.hostname = `${target.workers.bot}.${origin.hostname.slice(target.workers.activity.length + 1)}`
  const secret = process.env.CIVUP_SECRET
  if (!secret) throw new Error('Load the selected bot’s secret file.')
  return async (path: string, body: unknown, auditPath: string) => {
    await writeCancellationAudit(`${auditPath}.request.json`, {
      target: targetName,
      actor: target.discord.applicationId,
      path,
      body,
      startedAt: new Date().toISOString(),
    })
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        [CIVUP_INTERNAL_SECRET_HEADER]: secret,
        [CIVUP_ACTIVITY_USER_ID_HEADER]: target.discord.applicationId,
        [CIVUP_ACTIVITY_GUILD_ID_HEADER]: target.discord.guildId,
        [CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER]: '8',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await response.json()) as Record<string, unknown>
    await writeCancellationAudit(`${auditPath}.response.json`, { status: response.status, payload })
    if (!response.ok) throw new Error(`Bot request was refused. Inspect ${auditPath}.response.json.`)
    return payload
  }
}

async function maintenance(target: 'standard' | 'ppl') {
  const runtime = createMaintenanceClient({ target }, 'remote')
  const result = await runtime.client.d1Query<{ state: string; generation: number; writers: number }>(
    'SELECT state,generation,(SELECT count(*) FROM rating_mutation_leases) AS writers FROM rating_maintenance WHERE id=1',
  )
  const state = result[0]?.results[0]
  if (!state || !Number.isSafeInteger(state.generation)) throw new Error('Could not read rating maintenance state.')
  return state
}

async function verify(plan: CancellationPlan, out: string, requireFinished: boolean) {
  const runtime = createMaintenanceClient({ target: plan.target }, 'remote')
  const ids = JSON.stringify(plan.matchIds)
  const results = await runtime.client.d1Batch([
    {
      sql: 'SELECT m.id,m.status,r.cancelled_at FROM matches m LEFT JOIN season_match_reports r ON r.match_id=m.id WHERE m.id IN (SELECT value FROM json_each(?))',
      params: [ids],
    },
    { sql: 'SELECT * FROM player_rating_events WHERE match_id IN (SELECT value FROM json_each(?))', params: [ids] },
    { sql: 'SELECT * FROM match_participants WHERE match_id IN (SELECT value FROM json_each(?))', params: [ids] },
    {
      sql: 'SELECT * FROM match_civ_stat_contributions WHERE match_id IN (SELECT value FROM json_each(?))',
      params: [ids],
    },
    {
      sql: 'SELECT * FROM match_player_civ_stat_contributions WHERE match_id IN (SELECT value FROM json_each(?))',
      params: [ids],
    },
    {
      sql: 'SELECT session_id,match_id,phase FROM session_directory WHERE match_id IN (SELECT value FROM json_each(?))',
      params: [ids],
    },
  ])
  await writeCancellationAudit(out, { at: new Date().toISOString(), digest: plan.digest, results })
  const rows = results[0]!.results
  const participants = results[2]!.results
  if (
    rows.length !== plan.matchIds.length ||
    rows.some(row => row.cancelled_at !== plan.cancelledAt) ||
    results[1]!.results.length ||
    plan.matchIds.some(id => !participants.some(row => row.match_id === id)) ||
    participants.some(row =>
      ['placement', 'rating_before_mu', 'rating_before_sigma', 'rating_after_mu', 'rating_after_sigma'].some(
        key => row[key] !== null,
      ),
    )
  ) {
    throw new Error(`The saved rating cancellations do not match the plan. Inspect ${out}.`)
  }
  if (
    requireFinished &&
    (rows.some(row => row.status !== 'cancelled') ||
      results[3]!.results.length ||
      results[4]!.results.length ||
      results[5]!.results.length !== plan.matchIds.length ||
      results[5]!.results.some(row => row.phase !== 'cancelled'))
  ) {
    throw new Error(`Match closure or statistics cleanup is incomplete. Inspect ${out}.`)
  }
  if (!requireFinished) {
    const checked = await runtime.client.d1Batch<{ mismatches: number }>(plan.verification)
    await writeCancellationAudit(`${out}.ratings.json`, checked)
    if (checked.some(result => result.results.length !== 1 || result.results[0]!.mismatches !== 0)) {
      throw new Error(`Saved replayed ratings do not match the prepared result. Inspect ${out}.ratings.json.`)
    }
  }
}

export async function main(args = Bun.argv.slice(2)) {
  const [command, ...rest] = args
  const { values, execute } = options(rest)
  const value = (key: string) => values.get(key)?.[0]
  if (!['preview', 'apply', 'finish', 'verify', 'pause', 'resume', 'recover-finish'].includes(command ?? ''))
    throw new Error('Choose preview, apply, finish, verify, recover-finish, pause, or resume.')
  if (['apply', 'finish', 'pause', 'resume', 'recover-finish'].includes(command!) && !execute)
    throw new Error('Changes require --execute.')

  if (command === 'pause' || command === 'resume') {
    const target = selectedTarget(value('--target'))
    const out = value('--out')
    if (!out) throw new Error('Provide a fresh --out directory.')
    const state = await maintenance(target)
    await writeCancellationAudit(join(out, 'before.json'), state)
    if (state.writers) throw new Error('Unfinished rating operations need review before changing maintenance state.')
    if (command === 'pause') {
      const capability = await adminClient(target)(
        '/api/activity/admin/season-cancellation/finish',
        undefined,
        join(out, 'capability'),
      )
      if (capability.version !== 2)
        throw new Error('Deploy a bot with cancellation cleanup support before pausing reports.')
    }
    const desired = command === 'pause' ? 'paused' : 'open'
    if (state.state !== desired)
      await adminClient(target)(
        '/api/activity/admin/rating-maintenance',
        { state: desired, expectedGeneration: state.generation },
        join(out, command),
      )
    const after = await maintenance(target)
    await writeCancellationAudit(join(out, 'after.json'), after)
    if (after.state !== desired || after.writers) throw new Error('Maintenance verification failed.')
    console.log(JSON.stringify(after))
    return
  }

  if (command === 'preview') {
    const targetName = selectedTarget(value('--target'))
    const seasonId = value('--season')
    const matchIds = values.get('--match') ?? []
    const out = value('--out')
    if (!seasonId || !matchIds.length || !out)
      throw new Error('Provide --season, --match, and a fresh --out directory.')
    await mkdir(out, { recursive: false })
    const target = resolveCloudflareTarget(targetName)
    const source = createCancellationSource(targetName, join(out, 'source'))
    const before = await maintenance(targetName)
    const cancelledAt = Date.now()
    await writeCancellationAudit(join(out, 'preview-started.json'), {
      target: targetName,
      seasonId,
      matchIds,
      cancelledAt,
      maintenance: before,
    })
    const replay = await prepareSeasonBulkCancellation(source.db, seasonId, matchIds, cancelledAt)
    const original = replay.queries.map(query => (query as unknown as { toSQL(): CloudflareD1Statement }).toSQL())
    await writeCancellationAudit(join(out, 'original-statements.json'), original)
    await writeCancellationAudit(join(out, 'capture-completed.json'), {
      affectedMatchIds: replay.matchIds,
      usage: source.usage(),
    })
    // Compaction preserves the original transaction and its exact source guards.
    const catalog = await source.client.d1Query<{ name: string; tbl_name: string; sql: string }>(
      "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'",
    )
    const triggers = catalog[0]!.results
    assertSeasonCancellationCompactionTriggers(triggers)
    const compacted = compactSeasonCancellationSql(
      original.map(query => ({ sql: query.sql, params: query.params ?? [] })),
    )
    await writeCancellationAudit(join(out, 'compaction.json'), { ...compacted, triggers })
    if (!compacted.fitsLimits)
      throw new Error(`The compacted plan exceeds the surgical limits: ${compacted.violations.join('; ')}`)
    const statements = compacted.queries as CloudflareD1Statement[]
    const triggerGuard: CloudflareD1Statement = {
      sql: `SELECT CASE WHEN (SELECT count(*) FROM sqlite_master WHERE type='trigger')=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM sqlite_master actual WHERE actual.type='trigger' AND actual.name=json_extract(expected.value,'$.name') AND actual.tbl_name=json_extract(expected.value,'$.tbl_name') AND actual.sql IS json_extract(expected.value,'$.sql'))) THEN 1 ELSE json_extract('Cancellation trigger definitions changed','$') END AS valid`,
      params: [triggers.length, JSON.stringify(triggers)],
    }
    const operationId = `season-cancellation:${cancelledAt}:${seasonId}`
    const content: Omit<CancellationPlan, 'digest'> = {
      version: 2,
      operationId,
      target: targetName,
      accountId: target.accountId,
      databaseId: target.d1.id,
      guildId: target.discord.guildId,
      seasonId,
      matchIds,
      affectedMatchIds: replay.matchIds,
      cancelledAt,
      generation: before.generation,
      maintenanceState: before.state,
      sourceUsage: source.usage(),
      statements: [
        cancellationMaintenanceGuard(before.generation),
        triggerGuard,
        ...statements,
        {
          sql: 'INSERT INTO rating_mutation_leases(id,match_id,generation,created_at) VALUES(?,?,?,?)',
          params: [operationId, operationId, before.generation, cancelledAt],
        },
      ],
      verification: replayPostconditions(original, replay.matchIds),
    }
    const plan: CancellationPlan = { ...content, digest: digest(content) }
    // Compile against D1's actual SQLite limits without executing any changes.
    const shapes = new Map(
      [...plan.statements, ...plan.verification, ...cancellationCompletionBatch(plan)].map(statement => [
        statement.sql,
        statement,
      ]),
    )
    const compiled = await source.client.d1Batch(
      [...shapes.values()].map(statement => ({ ...statement, sql: `EXPLAIN ${statement.sql}` })),
    )
    await writeCancellationAudit(join(out, 'd1-compiled.json'), compiled)
    if (compiled.some(result => result.meta?.rows_written !== 0))
      throw new Error('Unexpected database writes during SQL compilation.')
    await writeCancellationAudit(join(out, 'plan.json'), plan)
    console.log(
      JSON.stringify(
        {
          plan: join(out, 'plan.json'),
          digest: plan.digest,
          targets: matchIds,
          affectedMatches: replay.matchIds.length,
          statements: plan.statements.length,
          bytes: Buffer.byteLength(JSON.stringify(plan.statements)),
          maintenance: before,
          usage: source.usage(),
        },
        null,
        2,
      ),
    )
    return
  }

  const planPath = value('--plan')
  if (!planPath) throw new Error('Provide --plan FILE.')
  const plan = await readPlan(planPath)
  const directory = dirname(resolve(planPath))
  if (command === 'verify') {
    await verify(plan, join(directory, `verify-${Date.now()}.json`), true)
    console.log(`Verified all ${plan.matchIds.length} cancelled matches.`)
    return
  }
  const state = await maintenance(plan.target)
  if (plan.maintenanceState !== 'paused' || state.state !== 'paused' || state.generation !== plan.generation) {
    throw new Error('Apply and finish require a plan captured during the current reporting pause.')
  }
  const attempt = join(directory, `${command}-${Date.now()}-${randomUUID()}`)
  const runtime = createMaintenanceClient({ target: plan.target }, 'remote')
  const leases = (
    await runtime.client.d1Query<{ id: string; match_id: string; generation: number }>(
      'SELECT id,match_id,generation FROM rating_mutation_leases',
    )
  )[0]!.results
  const owned = leases.find(
    lease =>
      lease.id === plan.operationId && lease.match_id === plan.operationId && lease.generation === plan.generation,
  )
  if (command === 'recover-finish') {
    const matchId = value('--match')
    const leaseId = value('--lease')
    if (!owned || !matchId || !plan.matchIds.includes(matchId) || !leaseId || values.get('--match')?.length !== 1)
      throw new Error('Provide one match from this plan and its exact unfinished cleanup lease ID.')
    await adminClient(plan.target)(
      '/api/activity/admin/season-cancellation/recover-finish',
      {
        operationId: plan.operationId,
        matchId,
        leaseId,
        expectedCancelledAt: plan.cancelledAt,
        expectedGeneration: plan.generation,
      },
      join(attempt, 'recover'),
    )
    console.log('Released the reviewed cleanup attempt. Run finish with the same plan.')
    return
  }
  if (leases.some(lease => lease !== owned))
    throw new Error('Other unfinished operations need review before continuing.')
  if (command === 'apply') {
    if (owned) {
      await verify(plan, join(attempt, 'already-applied.json'), false)
      console.log('The rating cancellations are already saved. Run finish with the same plan.')
      return
    }
    const capability = await adminClient(plan.target)(
      '/api/activity/admin/season-cancellation/finish',
      undefined,
      join(attempt, 'capability'),
    )
    if (capability.version !== 2) throw new Error('The bot does not support finishing this cancellation plan.')
    // Never split these statements: their guards and changes are one transaction.
    if (plan.statements.length > 1000 || Buffer.byteLength(JSON.stringify(plan.statements)) > 10_000_000)
      throw new Error('The plan exceeds the surgical batch limit. Compact and validate it before applying.')
    for (const statement of plan.statements) {
      if (
        (statement.params?.length ?? 0) > 100 ||
        Buffer.byteLength(statement.sql) > 100_000 ||
        (statement.params ?? []).some(param => typeof param === 'string' && Buffer.byteLength(param) > 2_000_000)
      ) {
        throw new Error('The plan exceeds a database statement limit.')
      }
    }
    await writeCancellationAudit(join(attempt, 'started.json'), {
      digest: plan.digest,
      at: new Date().toISOString(),
      outcome: 'unknown until verified',
    })
    const results = await runtime.client.d1Batch(plan.statements)
    await writeCancellationAudit(join(attempt, 'response.json'), results)
    await verify(plan, join(attempt, 'verified.json'), false)
    console.log(
      'Saved and verified the rating cancellations. Run finish with this plan to close the matches and remove their statistics.',
    )
    return
  }
  if (!owned) {
    await verify(plan, join(attempt, 'already-finished.json'), true)
    console.log('All matches are already closed and their cancellation operation has been released.')
    return
  }
  await verify(plan, join(attempt, 'before-finish.json'), false)
  const request = adminClient(plan.target)
  for (const matchId of plan.matchIds) {
    await request(
      '/api/activity/admin/season-cancellation/finish',
      {
        operationId: plan.operationId,
        matchId,
        expectedCancelledAt: plan.cancelledAt,
        expectedGeneration: plan.generation,
      },
      join(attempt, `finish-${matchId}`),
    )
  }
  await verify(plan, join(attempt, 'finished.json'), true)
  const completion = cancellationCompletionBatch(plan)
  await writeCancellationAudit(join(attempt, 'release-request.json'), completion)
  await writeCancellationAudit(join(attempt, 'release-response.json'), await runtime.client.d1Batch(completion))
  console.log(`Finished and verified all ${plan.matchIds.length} cancellations. Reporting remains paused until resume.`)
}

if (import.meta.main)
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

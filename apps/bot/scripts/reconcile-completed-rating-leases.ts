/* eslint-disable no-console */
import type { CloudflareD1Statement } from '../../../scripts/cloudflare-client.ts'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createMaintenanceClient } from './maintenance-cloudflare.ts'
import { balancedSqlAnd } from './season-cancellation-predicates.ts'
import { writeCancellationAudit } from './season-cancellation-source.ts'

type Row = Record<string, string | number | null>
const quote = (identifier: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error('Invalid database identifier.')
  return `"${identifier}"`
}

/** Compare every captured field as well as row count before removing only reviewed leases. */
export function exactLeaseSourceGuard(table: string, key: string, ids: string[], rows: Row[]): CloudflareD1Statement {
  const columns = Object.keys(rows[0] ?? {})
  if (!columns.length) throw new Error('A completed report source cannot be empty.')
  if (rows.some(row => JSON.stringify(Object.keys(row)) !== JSON.stringify(columns)))
    throw new Error('Inconsistent source columns.')
  return {
    sql: `SELECT CASE WHEN (SELECT count(*) FROM ${quote(table)} WHERE ${quote(key)} IN (SELECT value FROM json_each(?)))=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM ${quote(table)} actual WHERE ${balancedSqlAnd(columns.map((column, i) => `actual.${quote(column)} IS json_extract(expected.value,'$[${i}]')`))})) THEN 1 ELSE json_extract('Reviewed rating operation changed','$') END AS valid`,
    params: [JSON.stringify(ids), rows.length, JSON.stringify(rows.map(row => columns.map(column => row[column])))],
  }
}

export function validateCompletedLeaseSource(data: Record<string, Row[]>, leaseIds: string[], now: number) {
  if (
    !leaseIds.length ||
    new Set(leaseIds).size !== leaseIds.length ||
    data.leases?.length !== leaseIds.length ||
    data.leases.some(row => !leaseIds.includes(String(row.id)))
  ) {
    throw new Error('Every selected unfinished operation must still exist exactly once.')
  }
  // Age alone is insufficient. The complete persisted report, both rating tracks,
  // terminal session and atomic statistics contributions are checked below.
  if (data.leases.some(row => typeof row.created_at !== 'number' || now - row.created_at < 15 * 60_000)) {
    throw new Error('A selected operation is too recent to establish that its Worker has stopped.')
  }
  const matchIds = [...new Set(data.leases.map(row => String(row.match_id)))]
  for (const id of matchIds) {
    const matches = data.matches?.filter(row => row.id === id) ?? []
    const reports = data.reports?.filter(row => row.match_id === id) ?? []
    const sessions = data.sessions?.filter(row => row.match_id === id) ?? []
    const participants = data.participants?.filter(row => row.match_id === id) ?? []
    const events = data.events?.filter(row => row.match_id === id) ?? []
    const match = matches[0]
    const report = reports[0]
    if (
      matches.length !== 1 ||
      match?.status !== 'completed' ||
      reports.length !== 1 ||
      report?.cancelled_at !== null ||
      report?.season_id !== match.season_id ||
      report?.accepted_at !== match.completed_at ||
      sessions.length !== 1 ||
      sessions[0]?.phase !== 'reported'
    ) {
      throw new Error(`Match ${id} does not have a fully saved, uncancelled result and closed session.`)
    }
    const mode =
      match.game_mode === '1v1'
        ? 'duel'
        : match.game_mode === '2v2'
          ? 'duo'
          : match.game_mode === 'ffa'
            ? 'ffa'
            : ['3v3', '4v4', '5v5', '6v6'].includes(String(match.game_mode))
              ? 'squad'
              : null
    if (
      !mode ||
      participants.length < 2 ||
      new Set(participants.map(row => row.player_id)).size !== participants.length ||
      events.length !== participants.length * 2
    ) {
      throw new Error(`Match ${id} has incomplete players or rating events.`)
    }
    for (const participant of participants) {
      const saved = events.filter(row => row.player_id === participant.player_id)
      const scoped = saved.find(row => row.mode === mode)
      if (
        participant.placement == null ||
        saved.length !== 2 ||
        !scoped ||
        !saved.some(row => row.mode === 'global') ||
        saved.some(
          row =>
            row.season_id !== match.season_id ||
            row.public_sequence !== report.sequence ||
            row.public_rating_before === null ||
            row.public_rating_after === null,
        ) ||
        ['rating_before_mu', 'rating_before_sigma', 'rating_after_mu', 'rating_after_sigma'].some(
          key => participant[key] === null || participant[key] !== scoped[key],
        )
      ) {
        throw new Error(`Match ${id} has incomplete or conflicting saved rating changes.`)
      }
    }
    if (
      data.civ?.filter(row => row.match_id === id).length !== 1 ||
      data.playerCiv?.filter(row => row.match_id === id).length !== 1
    ) {
      throw new Error(`Match ${id} still needs its statistics saved.`)
    }
  }
  return matchIds
}

export async function main(args = Bun.argv.slice(2)) {
  const [command, ...rest] = args
  const values = new Map<string, string[]>()
  let execute = false
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (key === '--execute' && !execute) {
      execute = true
      continue
    }
    if (
      !['--target', '--lease', '--out', '--plan'].includes(key) ||
      !rest[i + 1] ||
      rest[i + 1]!.startsWith('--') ||
      (key !== '--lease' && values.has(key))
    )
      throw new Error(
        'Use preview --target standard|ppl --lease ID [--lease ID ...] --out DIRECTORY, or apply --plan FILE --execute.',
      )
    values.set(key, [...(values.get(key) ?? []), rest[++i]!])
  }
  if (command === 'preview') {
    const target = values.get('--target')?.[0]
    if (target !== 'standard' && target !== 'ppl') throw new Error('Choose the target explicitly.')
    const leaseIds = values.get('--lease') ?? []
    const out = values.get('--out')?.[0]
    if (!out || !leaseIds.length) throw new Error('Provide the exact lease IDs and a fresh output directory.')
    const runtime = createMaintenanceClient({ target }, 'remote')
    const leaseSource = await runtime.client.d1Query<Row>(
      'SELECT * FROM rating_mutation_leases WHERE id IN (SELECT value FROM json_each(?))',
      [JSON.stringify(leaseIds)],
    )
    const leases = leaseSource[0]!.results
    const matchIds = [...new Set(leases.map(row => String(row.match_id)))]
    const tables = {
      matches: ['matches', 'id'],
      reports: ['season_match_reports', 'match_id'],
      sessions: ['session_directory', 'match_id'],
      participants: ['match_participants', 'match_id'],
      events: ['player_rating_events', 'match_id'],
      civ: ['match_civ_stat_contributions', 'match_id'],
      playerCiv: ['match_player_civ_stat_contributions', 'match_id'],
    } as const
    const results = await runtime.client.d1Batch<Row>(
      Object.values(tables).map(([table, key]) => ({
        sql: `SELECT * FROM ${quote(table)} WHERE ${quote(key)} IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(matchIds)],
      })),
    )
    const data = { leases, ...Object.fromEntries(Object.keys(tables).map((key, i) => [key, results[i]!.results])) }
    validateCompletedLeaseSource(data, leaseIds, Date.now())
    const statements = [
      exactLeaseSourceGuard('rating_mutation_leases', 'id', leaseIds, leases),
      ...Object.entries(tables).map(([name, [table, key]]) =>
        exactLeaseSourceGuard(table, key, matchIds, data[name as keyof typeof data]!),
      ),
      {
        sql: 'DELETE FROM rating_mutation_leases WHERE id IN (SELECT value FROM json_each(?))',
        params: [JSON.stringify(leaseIds)],
      },
    ]
    const content = {
      version: 1,
      target,
      accountId: runtime.selection.accountId,
      databaseId: runtime.selection.d1.id,
      leaseIds,
      matchIds,
      capturedAt: Date.now(),
      data,
      statements,
    }
    const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex')
    await writeCancellationAudit(join(out, 'plan.json'), { ...content, digest })
    console.log(JSON.stringify({ out, leaseIds, matchIds, digest }, null, 2))
    return
  }
  if (command !== 'apply' || !execute || !values.get('--plan')?.[0]) throw new Error('Use apply --plan FILE --execute.')
  const path = values.get('--plan')![0]!
  const { digest, ...plan } = await Bun.file(path).json()
  if (createHash('sha256').update(JSON.stringify(plan)).digest('hex') !== digest || plan.version !== 1)
    throw new Error('The reviewed lease plan changed.')
  const runtime = createMaintenanceClient({ target: plan.target }, 'remote')
  if (runtime.selection.accountId !== plan.accountId || runtime.selection.d1.id !== plan.databaseId)
    throw new Error('The selected resources changed.')
  validateCompletedLeaseSource(plan.data, plan.leaseIds, Date.now())
  const attempt = `${path}.${Date.now()}-${randomUUID()}`
  const before = await runtime.client.d1Query(
    'SELECT id FROM rating_mutation_leases WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(plan.leaseIds)],
  )
  await writeCancellationAudit(`${attempt}.before.json`, before)
  if (before[0]!.results.length === 0) {
    console.log('The reviewed operations are already cleared.')
    return
  }
  await writeCancellationAudit(`${attempt}.apply-started.json`, { digest, at: new Date().toISOString() })
  const result = await runtime.client.d1Batch(plan.statements)
  await writeCancellationAudit(`${attempt}.apply-result.json`, result)
  const remaining = await runtime.client.d1Query(
    'SELECT * FROM rating_mutation_leases WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(plan.leaseIds)],
  )
  await writeCancellationAudit(`${attempt}.verified.json`, remaining)
  if (remaining[0]?.results.length) throw new Error('Reviewed operations were not all cleared.')
  console.log(`Cleared ${plan.leaseIds.length} reviewed operations; match results and ratings were not edited.`)
}

if (import.meta.main)
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })

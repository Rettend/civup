import type { Database } from '@civup/db'
import { civReleaseDirty, civReleaseMembers, civReleaseProjections, leaderboardDirtyStates, matchCivStatContributions, matches } from '@civup/db'
import { and, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm'
import { runAtomicSeasonBatch, seasonSourceGuard } from '../season/report.ts'
import { CIV_LEADERBOARD_MODE_SCOPES, contributionVisibleCondition, eligibleCivContributionCondition, snapshotFromAggregates, snapshotFromContributionRows, type CivAggregate, type CivLeaderboardDisplayConfig, type CivLeaderboardModeScope, type ContributionRow } from './civ-snapshot.ts'

type Member = typeof civReleaseMembers.$inferSelect
type Aggregates = Record<string, { count: number, rows: Record<string, CivAggregate> }>
const identity = (config: CivLeaderboardDisplayConfig) => `${config.label}:${config.liveFrom}`

/** Consume one bounded page. Initialization and subsequent corrections use the same deltas. */
export async function advanceCivReleaseProjection(db: Database, config: CivLeaderboardDisplayConfig) {
  if (config.betaReplacement !== 'one-for-one') return true
  if (!config.betaSeedMatchIds || config.betaSeedMatchIds.length > 1000) throw new Error('Freeze at most 1,000 beta sample matches before preparing the release.')
  const id = identity(config), serialized = JSON.stringify(config)
  const readState = () => db.select({ ...getTableColumns(civReleaseProjections), dirty: sql<string>`(
    select json_group_array(json_object('matchId',match_id,'revision',revision)) from
      (select match_id,revision from civ_release_dirty where release_id=${id} order by match_id limit 50))`,
  }).from(civReleaseProjections).where(eq(civReleaseProjections.id, id)).limit(1)
  let [state] = await readState()
  if (!state) {
    await db.insert(civReleaseProjections).values({ id, config: serialized }).onConflictDoNothing()
    ;[state] = await readState()
  }
  if (!state) throw new Error('The release projection could not be initialized.')
  if (state!.config !== serialized) throw new Error('The frozen release configuration changed. Prepare a new release projection.')
  const initial = state!.initialized ? [] : await db.select({ matchId: matchCivStatContributions.matchId }).from(matchCivStatContributions)
    .where(sql`${matchCivStatContributions.matchId} > ${state!.cursor}`).orderBy(matchCivStatContributions.matchId).limit(50)
  const queued = JSON.parse(state.dirty) as Array<{ matchId: string, revision: number }>
  const ids = (state!.initialized ? queued : initial).map(row => row.matchId)
  if (!ids.length && state!.initialized) return true
  // Capture revisions before reading contributions, so a racing mutation cannot be acknowledged with older data.
  const dirty = state.initialized ? queued : ids.length ? await db.select().from(civReleaseDirty).where(and(eq(civReleaseDirty.releaseId, id), inArray(civReleaseDirty.matchId, ids))) : []
  const [previous, current] = await Promise.all([
    ids.length ? db.select().from(civReleaseMembers).where(and(eq(civReleaseMembers.releaseId, id), inArray(civReleaseMembers.matchId, ids))) : [],
    ids.length ? db.select({ matchId: matchCivStatContributions.matchId, completedMatchCount: matchCivStatContributions.completedMatchCount,
      contributionsJson: matchCivStatContributions.contributionsJson, source: matchCivStatContributions.source, modeScope: matchCivStatContributions.modeScope,
      completedAt: matchCivStatContributions.completedAt, visible: matchCivStatContributions.visible,
    }).from(matchCivStatContributions).innerJoin(matches, eq(matches.id, matchCivStatContributions.matchId))
      .where(and(inArray(matchCivStatContributions.matchId, ids), contributionVisibleCondition(config), eligibleCivContributionCondition(), eq(matches.status, 'completed'),
        or(eq(matchCivStatContributions.source, 'beta'), sql`${matches.createdAt} >= ${config.liveFrom}`))) : [],
  ])
  const liveCount = state.liveCount - previous.filter(row => row.source === 'live').length + current.filter(row => row.source === 'live').length
  if (liveCount < 0) throw new Error('Release live count disagrees with saved membership.')
  // Once live games replace the entire frozen sample, beta rows cannot affect a delta
  // unless this change crosses back below the sample's maximum size.
  const betaRows = Math.min(state.liveCount, liveCount) >= config.betaSeedMatchIds.length ? []
    : await db.select().from(civReleaseMembers).where(and(eq(civReleaseMembers.releaseId, id), eq(civReleaseMembers.source, 'beta'))).limit(1001)
  if (betaRows.length > 1000) throw new Error('The saved beta sample exceeds its frozen size.')
  const old = new Map([...betaRows, ...previous].map(row => [row.matchId, row]))
  const next = new Map(old)
  for (const matchId of ids) next.delete(matchId)
  for (const row of current) next.set(row.matchId, { releaseId: id, matchId: row.matchId, source: row.source,
    completedAt: row.completedAt, contribution: JSON.stringify(row), selected: row.source === 'live' })
  const beta = [...next.values()].filter(row => row.source === 'beta').sort((a, b) => b.completedAt - a.completedAt || a.matchId.localeCompare(b.matchId))
  for (const [index, row] of beta.entries()) next.set(row.matchId, { ...row, selected: index < Math.max(0, beta.length - liveCount) })
  const aggregates = JSON.parse(state!.aggregates) as Aggregates
  const changed: Member[] = [], deleted: string[] = []
  for (const matchId of new Set([...old.keys(), ...next.keys()])) {
    const before = old.get(matchId), after = next.get(matchId)
    if (before?.contribution === after?.contribution && before?.selected === after?.selected) continue
    if (before?.selected) applyContribution(aggregates, JSON.parse(before.contribution), -1)
    if (after?.selected) applyContribution(aggregates, JSON.parse(after.contribution), 1)
    if (after) changed.push(after)
    else deleted.push(matchId)
  }
  const expectedDirty = JSON.stringify(ids.map(matchId => [matchId, dirty.find(row => row.matchId === matchId)?.revision ?? null]))
  const queries = [seasonSourceGuard(db, sql`exists(select 1 from civ_release_projections where id=${id} and revision=${state!.revision} and config=${serialized})
    and not exists(select 1 from json_each(${expectedDirty}) e left join civ_release_dirty d on d.release_id=${id} and d.match_id=json_extract(e.value,'$[0]') where d.revision is not json_extract(e.value,'$[1]'))`)]
  for (let offset = 0; offset < deleted.length; offset += 90) queries.push(db.delete(civReleaseMembers).where(and(eq(civReleaseMembers.releaseId, id), inArray(civReleaseMembers.matchId, deleted.slice(offset, offset + 90)))))
  for (let offset = 0; offset < changed.length; offset += 10) queries.push(db.insert(civReleaseMembers).values(changed.slice(offset, offset + 10)).onConflictDoUpdate({
    target: [civReleaseMembers.releaseId, civReleaseMembers.matchId], set: { source: sql`excluded.source`, completedAt: sql`excluded.completed_at`, contribution: sql`excluded.contribution`, selected: sql`excluded.selected` },
  }))
  queries.push(db.update(civReleaseProjections).set({ revision: state!.revision + 1, liveCount, aggregates: JSON.stringify(aggregates),
    cursor: initial.at(-1)?.matchId ?? state!.cursor, initialized: state!.initialized || initial.length < 50,
  }).where(eq(civReleaseProjections.id, id)))
  for (let offset = 0; offset < ids.length; offset += 90) queries.push(db.delete(civReleaseDirty).where(and(eq(civReleaseDirty.releaseId, id), inArray(civReleaseDirty.matchId, ids.slice(offset, offset + 90)))))
  if (!state!.initialized && (changed.length || deleted.length)) queries.push(db.insert(leaderboardDirtyStates).values(CIV_LEADERBOARD_MODE_SCOPES.map(scope => ({ scope: `civ:${scope}`, dirtyAt: Date.now(), reason: 'release-contribution' })))
    .onConflictDoUpdate({ target: leaderboardDirtyStates.scope, set: { dirtyAt: sql`max(dirty_at, excluded.dirty_at)`, reason: 'release-contribution' } }))
  await runAtomicSeasonBatch(db, queries)
  const [ready] = await db.select({ id: civReleaseProjections.id }).from(civReleaseProjections).where(and(eq(civReleaseProjections.id, id), eq(civReleaseProjections.initialized, true),
    sql`not exists(select 1 from civ_release_dirty where release_id=${id})`)).limit(1)
  return ready != null
}

function applyContribution(data: Aggregates, row: ContributionRow, sign: 1 | -1) {
  for (const scope of CIV_LEADERBOARD_MODE_SCOPES.filter(scope => scope === 'all' || scope === row.modeScope)) {
    const source = snapshotFromContributionRows([row], scope, '', 0, true, true)
    const aggregate = data[scope] ??= { count: 0, rows: {} }
    aggregate.count += sign * source.completedMatchCount
    for (const entry of source.rows) {
      const target = aggregate.rows[entry.civId] ??= { civId: entry.civId, leaderName: entry.leaderName, picks: 0, wins: 0, bans: 0, poolGames: 0 }
      for (const field of ['picks', 'wins', 'bans', 'poolGames'] as const) {
        target[field] += sign * entry[field]
        if (target[field] < 0) throw new Error('Release aggregate does not match its saved contributions.')
      }
    }
  }
}

export async function readCivReleaseSnapshots(db: Database, config: CivLeaderboardDisplayConfig, scopes: readonly CivLeaderboardModeScope[], updatedAt: number, historyInitialized: boolean) {
  const id = identity(config)
  const [state] = await db.select().from(civReleaseProjections).where(and(eq(civReleaseProjections.id, id), sql`not exists(select 1 from civ_release_dirty where release_id=${id})`)).limit(1)
  if (!state?.initialized || state.config !== JSON.stringify(config)) throw new Error('Release leaderboard updates are still being prepared.')
  const data = JSON.parse(state.aggregates) as Aggregates
  return new Map(scopes.map(scope => [scope, { ...snapshotFromAggregates(new Map(Object.entries(data[scope]?.rows ?? {})), scope, config.label, data[scope]?.count ?? 0, updatedAt, historyInitialized), periodId: id }]))
}

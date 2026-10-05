import type { DivisionRolePreparation } from './division-role-preparation.ts'
import type { CurrentRankAssignment, RankedRolePreview } from './role-sync.ts'
import type { RankedRoleConfig } from './roles.ts'
import type { Database } from '@civup/db'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import {
  divisionRankPolicies,
  divisionRankSources,
  divisionRankStates,
  players,
  seasonPeakDivisionRanks,
  seasonPeakRanks,
  seasons,
} from '@civup/db'
import {
  isOverallRankPolicyVersion,
  nextOverallRankChangeAt,
  OVERALL_RANK_POLICY_VERSION,
  PUBLIC_RATING_BANDS,
} from '@civup/rating'
import {
  addGuildMemberRole,
  DiscordApiError,
  fetchGuildChannelRoleOverwriteIds,
  fetchGuildMember,
  fetchGuildMemberPage,
  fetchGuildRoles,
  removeGuildMemberRole,
} from '../discord/index.ts'
import { runAtomicSeasonBatch, seasonSourceGuard } from '../season/report.ts'
import { publishPendingDivisionPlayers } from './division-projection.ts'
import { divisionSourceGuard, isDivisionSourceConflict } from './division-source-guard.ts'
import { previewOverallDivisionRanks } from './overall-preview.ts'
import {
  initializeQualityCheckpointPage,
  prepareQualityCheckpoint,
  QualityHistoryDateError,
} from './quality-checkpoint.ts'
import { currentRankAssignmentsKey, normalizeRankedRoleAssignments, setCurrentRankAssignments } from './role-sync.ts'
import { getConfiguredDivisionLabel, getRankedRoleConfig, RANKED_ROLE_CONFIG_KEY_PREFIX } from './roles.ts'

type Policy = typeof divisionRankPolicies.$inferSelect
type Result = Awaited<ReturnType<typeof previewOverallDivisionRanks>>[number]
interface StoredConfig {
  config: RankedRoleConfig
  preparation: DivisionRolePreparation
  membershipScopePrepared?: boolean
}

export async function getDivisionRankPolicy(db: Database, guildId: string) {
  const [policy] = await db
    .select()
    .from(divisionRankPolicies)
    .where(eq(divisionRankPolicies.guildId, guildId))
    .limit(1)
  if (policy && !isOverallRankPolicyVersion(policy.version)) throw new Error('Unsupported division policy version.')
  return policy ?? null
}

export async function stageDivisionRanks(
  db: Database,
  kv: KVNamespace,
  preparation: DivisionRolePreparation,
  now = Date.now(),
) {
  if (preparation.status !== 'prepared') throw new Error('Finish role preparation first.')
  const existing = await getDivisionRankPolicy(db, preparation.guildId)
  if (existing) return divisionRankStatus(db, preparation.guildId)
  const config = await getRankedRoleConfig(kv, preparation.guildId)
  if (
    JSON.stringify(config.tiers.map(row => row.roleId)) !== JSON.stringify(preparation.sourceRoleIds) ||
    config.unrankedRoleId !== preparation.unrankedRoleId
  )
    throw new Error('The prepared source configuration changed.')
  const [season] = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.active, true), eq(seasons.ratingSystem, 'rp')))
    .limit(1)
  if (!season?.publicReadsEnabled || !season.isolatedRatingsEnabled)
    throw new Error('An active isolated RP season is required.')
  const saved = normalizeRankedRoleAssignments(await kv.get(currentRankAssignmentsKey(preparation.guildId), 'json'))
  await runAtomicSeasonBatch(db, [
    db.insert(divisionRankPolicies).values({
      guildId: preparation.guildId,
      seasonId: season.id,
      version: OVERALL_RANK_POLICY_VERSION,
      phase: 'prepared',
      configJson: JSON.stringify({ config, preparation }),
      updatedAt: now,
    }),
    db.insert(divisionRankStates).select(
      db
        .select({
          guildId: sql<string>`${preparation.guildId}`.as('guild_id'),
          playerId: players.id,
          sourceRevision: sql<number>`-1`.as('source_revision'),
          resultJson: sql<string | null>`null`.as('result_json'),
          nextCheckAt: sql<number>`0`.as('next_check_at'),
          desiredRoleId: sql<string | null>`null`.as('desired_role_id'),
          appliedRoleId: sql<string | null>`null`.as('applied_role_id'),
          pending: sql<boolean>`0`.as('pending'),
          projectionPending: sql<boolean>`0`.as('projection_pending'),
          retryAt: sql<number>`0`.as('retry_at'),
          lastError: sql<string | null>`null`.as('last_error'),
        })
        .from(players).where(sql`${players.id} in (select player_id from player_ratings where mode = 'global')
      or ${players.id} in (select value from json_each(${JSON.stringify(Object.keys(saved.byPlayerId))}))`),
    ),
  ])
  return divisionRankStatus(db, preparation.guildId)
}

export async function divisionRankStatus(db: Database, guildId: string) {
  const policy = await getDivisionRankPolicy(db, guildId)
  if (!policy) return { phase: 'not-staged', total: 0, needsCalculation: 0, pendingRoles: 0, errors: 0 }
  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      needsCalculation: sql<number>`coalesce(sum(case when result_json is null or next_check_at <= ${Date.now()} then 1 else 0 end), 0)`,
      pendingRoles: sql<number>`coalesce(sum(pending), 0)`,
      errors: sql<number>`coalesce(sum(case when last_error is not null then 1 else 0 end), 0)`,
    })
    .from(divisionRankStates)
    .where(eq(divisionRankStates.guildId, guildId))
  const errors = await db
    .select({ playerId: divisionRankStates.playerId, error: divisionRankStates.lastError })
    .from(divisionRankStates)
    .where(and(eq(divisionRankStates.guildId, guildId), sql`${divisionRankStates.lastError} is not null`))
    .limit(10)
  return {
    phase: policy.phase,
    version: OVERALL_RANK_POLICY_VERSION,
    ...counts!,
    membershipScopePrepared: (JSON.parse(policy.configJson) as StoredConfig).membershipScopePrepared === true,
    memberScanComplete: policy.memberScanComplete,
    memberCursor: policy.memberCursor,
    errorDetails: errors,
  }
}

/** No Discord lookups: reuse the saved legacy assignments for transition cleanup. */
export async function scopeDivisionMemberships(db: Database, kv: KVNamespace, policy: Policy) {
  if (policy.phase !== 'prepared') throw new Error('Membership scoping is only available before activation.')
  const stored = JSON.parse(policy.configJson) as StoredConfig
  const previous = normalizeRankedRoleAssignments(await kv.get(currentRankAssignmentsKey(policy.guildId), 'json'))
  const states = await db.select().from(divisionRankStates).where(eq(divisionRankStates.guildId, policy.guildId))
  if (states.some(row => !row.resultJson || row.lastError))
    throw new Error('Finish candidate calculation and resolve errors before scoping memberships.')
  const queries: Parameters<typeof runAtomicSeasonBatch>[1] = []
  for (const row of states) {
    const result = JSON.parse(row.resultJson!) as Result
    const assignment = previous.byPlayerId[row.playerId]
    const applied = assignment?.appliedRoleId
    const oldRoleId =
      applied && [...stored.preparation.sourceRoleIds, stored.preparation.unrankedRoleId].includes(applied)
        ? applied
        : assignment && !assignment.unranked
          ? (stored.config.tiers[Number(assignment.tier.slice(4)) - 1]?.roleId ?? null)
          : null
    const pending = !!result.band || (!!oldRoleId && oldRoleId !== stored.preparation.unrankedRoleId)
    if (row.pending === pending && row.appliedRoleId === oldRoleId) continue
    queries.push(
      db
        .update(divisionRankStates)
        .set({ pending, appliedRoleId: oldRoleId })
        .where(
          and(
            eq(divisionRankStates.guildId, policy.guildId),
            eq(divisionRankStates.playerId, row.playerId),
            eq(divisionRankStates.resultJson, row.resultJson!),
          ),
        ),
    )
  }
  for (let offset = 0; offset < queries.length; offset += 200)
    await runAtomicSeasonBatch(db, [
      divisionSourceGuard(
        db,
        sql`exists(select 1 from division_rank_policies where guild_id = ${policy.guildId} and phase = 'prepared' and config_json = ${policy.configJson})`,
      ),
      ...queries.slice(offset, offset + 200),
    ])
  await db
    .update(divisionRankPolicies)
    .set({ configJson: JSON.stringify({ ...stored, membershipScopePrepared: true }) })
    .where(
      and(
        eq(divisionRankPolicies.guildId, policy.guildId),
        eq(divisionRankPolicies.phase, 'prepared'),
        eq(divisionRankPolicies.configJson, policy.configJson),
      ),
    )
  return divisionRankStatus(db, policy.guildId)
}

export async function scanDivisionMembers(db: Database, token: string, policy: Policy, now = Date.now()) {
  if (policy.memberScanComplete) return { scanned: 0, complete: true }
  if (policy.phase !== 'prepared') throw new Error('Member discovery is only available during one-time preparation.')
  const page = await fetchGuildMemberPage(token, policy.guildId, policy.memberCursor ?? undefined)
  const ids = JSON.stringify(page.map(member => member.user.id))
  const states = await db
    .select({ playerId: divisionRankStates.playerId })
    .from(divisionRankStates)
    .where(
      and(
        eq(divisionRankStates.guildId, policy.guildId),
        sql`${divisionRankStates.playerId} in (select value from json_each(${ids}))`,
      ),
    )
  const byPlayer = new Map(states.map(row => [row.playerId, row]))
  const updates: Parameters<typeof runAtomicSeasonBatch>[1] = []
  for (const member of page) {
    if (member.user.bot) continue
    const state = byPlayer.get(member.user.id)
    if (!state) {
      updates.push(
        db
          .insert(players)
          .values({ id: member.user.id, displayName: member.user.id, createdAt: now })
          .onConflictDoNothing(),
        db
          .insert(divisionRankStates)
          .values({ guildId: policy.guildId, playerId: member.user.id, nextCheckAt: 0 })
          .onConflictDoNothing(),
      )
    }
  }
  for (let offset = 0; offset < updates.length; offset += 200)
    await runAtomicSeasonBatch(db, updates.slice(offset, offset + 200))
  const complete = page.length < 1000
  await db
    .update(divisionRankPolicies)
    .set({ memberCursor: complete ? null : page.at(-1)!.user.id, memberScanComplete: complete, nextMemberScanAt: 0 })
    .where(
      and(
        eq(divisionRankPolicies.guildId, policy.guildId),
        sql`${divisionRankPolicies.memberCursor} is ${policy.memberCursor}`,
      ),
    )
  return { scanned: page.length, complete }
}

export async function calculateDueDivisionRanks(
  db: Database,
  policy: Policy,
  now: number,
  limit = 40,
  playerIds?: string[],
) {
  const [source] = await db
    .select({
      seasonActive: sql<number>`exists(select 1 from seasons where id = ${policy.seasonId} and active = 1 and public_reads_enabled = 1)`,
      writers: sql<number>`exists(select 1 from rating_mutation_leases)`,
    })
    .from(sql`(select 1) as division_source`)
  if (!source?.seasonActive)
    throw new Error('The active season changed. Review the staged division policy before continuing.')
  if (source.writers) return { calculated: 0, blocked: 'rating-writers' as const }
  const due = await db
    .select()
    .from(divisionRankStates)
    .where(
      and(
        eq(divisionRankStates.guildId, policy.guildId),
        playerIds ? inArray(divisionRankStates.playerId, playerIds) : undefined,
        lte(divisionRankStates.nextCheckAt, now),
        lte(divisionRankStates.retryAt, now),
      ),
    )
    .orderBy(asc(divisionRankStates.nextCheckAt), asc(divisionRankStates.playerId))
    .limit(limit)
  if (!due.length) return { calculated: 0, blocked: null }
  const rows: typeof due = []
  for (const row of due) {
    try {
      if (
        (!row.resultJson || !(JSON.parse(row.resultJson) as Result).recent) &&
        !(await initializeQualityCheckpointPage(db, policy.guildId, row.playerId, now))
      )
        continue
      rows.push(row)
    } catch (error) {
      if (isDivisionSourceConflict(error)) return { calculated: 0, blocked: 'source-changed' as const }
      if (!(error instanceof QualityHistoryDateError)) throw error
      await db
        .update(divisionRankStates)
        .set({ lastError: error instanceof Error ? error.message : String(error), retryAt: now + 300_000 })
        .where(
          and(
            eq(divisionRankStates.guildId, policy.guildId),
            eq(divisionRankStates.playerId, row.playerId),
            sql`${divisionRankStates.resultJson} is ${row.resultJson}`,
          ),
        )
    }
  }
  if (!rows.length) return { calculated: 0, blocked: 'quality-initialization' as const }
  const ids = rows.map(row => row.playerId)
  const sources = await db.select().from(divisionRankSources).where(inArray(divisionRankSources.playerId, ids))
  const revisions = new Map(sources.map(row => [row.playerId, row.revision]))
  const checkpoints = new Map(
    await Promise.all(
      rows.map(async row => {
        const previous = row.resultJson ? (JSON.parse(row.resultJson) as Result) : null
        const checkpoint =
          row.sourceRevision === (revisions.get(row.playerId) ?? 0) && previous?.recent
            ? { recent: previous.recent, undatedMatchIds: [], queries: [] }
            : await prepareQualityCheckpoint(db, policy.guildId, row.playerId, now, previous?.recent)
        return [row.playerId, checkpoint] as const
      }),
    ),
  )
  const saved = new Map(
    rows.map(row => {
      const result = row.resultJson ? (JSON.parse(row.resultJson) as Result) : null
      return [
        row.playerId,
        {
          recent: checkpoints.get(row.playerId)!.recent,
          qualityMinimum: result?.qualityMinimum,
          minimum: policy.phase === 'prepared' || !result?.qualityUplift ? null : (result.band?.minimum ?? null),
          unchanged: true,
        },
      ] as const
    }),
  )
  if (!isOverallRankPolicyVersion(policy.version)) throw new Error('Unsupported division policy version.')
  const results = await previewOverallDivisionRanks(db, ids, now, saved, policy.version)
  const { preparation } = JSON.parse(policy.configJson) as StoredConfig
  let calculated = 0
  for (const result of results) {
    const checkpoint = checkpoints.get(result.playerId)!
    result.undatedMatchIds = checkpoint.undatedMatchIds
    result.nextCheckAt = nextOverallRankChangeAt(result, policy.phase !== 'prepared')
    const source = rows.find(row => row.playerId === result.playerId)!
    const revision = revisions.get(result.playerId) ?? 0
    if (result.undatedMatchIds.length) {
      await db
        .update(divisionRankStates)
        .set({
          lastError: `Undated quality evidence: ${result.undatedMatchIds.slice(0, 5).join(', ')}`,
          retryAt: now + 300_000,
        })
        .where(and(eq(divisionRankStates.guildId, policy.guildId), eq(divisionRankStates.playerId, result.playerId)))
      continue
    }
    const desiredRoleId = result.band ? preparation.roleIdsByMinimum[result.band.minimum] : preparation.unrankedRoleId
    if (!desiredRoleId) throw new Error('A required division role mapping is missing.')
    try {
      await runAtomicSeasonBatch(db, [
        divisionSourceGuard(
          db,
          sql`coalesce((select revision from division_rank_sources where player_id = ${result.playerId}), 0) = ${revision}
        and not exists(select 1 from rating_mutation_leases)
        and exists(select 1 from seasons where id = ${policy.seasonId} and active = 1 and public_reads_enabled = 1)
        and exists(select 1 from division_rank_states where guild_id = ${policy.guildId} and player_id = ${result.playerId} and result_json is ${source.resultJson})`,
        ),
        ...checkpoint.queries,
        ...divisionPeakQueries(db, policy, result, now),
        db
          .update(divisionRankStates)
          .set({
            resultJson: JSON.stringify(result),
            sourceRevision: revision,
            nextCheckAt: result.nextCheckAt,
            desiredRoleId,
            projectionPending: true,
            pending: source.appliedRoleId !== desiredRoleId && (!!result.band || !!source.appliedRoleId),
            retryAt: 0,
            lastError: null,
          })
          .where(and(eq(divisionRankStates.guildId, policy.guildId), eq(divisionRankStates.playerId, result.playerId))),
        db
          .update(divisionRankPolicies)
          .set({ projectionRevision: sql`${divisionRankPolicies.projectionRevision} + 1` })
          .where(eq(divisionRankPolicies.guildId, policy.guildId)),
      ])
    } catch (error) {
      if (isDivisionSourceConflict(error)) return { calculated, blocked: 'source-changed' as const }
      throw error
    }
    calculated++
  }
  return { calculated, blocked: null }
}

export async function captureDivisionRanks(db: Database, guildId: string) {
  const policy = await getDivisionRankPolicy(db, guildId)
  if (!policy) throw new Error('Stage the division policy first.')
  const rows = await db
    .select({
      playerId: divisionRankStates.playerId,
      resultJson: divisionRankStates.resultJson,
      sourceRevision: divisionRankStates.sourceRevision,
      desiredRoleId: divisionRankStates.desiredRoleId,
      lastError: divisionRankStates.lastError,
      pending: divisionRankStates.pending,
      appliedRoleId: divisionRankStates.appliedRoleId,
    })
    .from(divisionRankStates)
    .where(eq(divisionRankStates.guildId, guildId))
    .orderBy(asc(divisionRankStates.playerId))
  const source = JSON.stringify({ seasonId: policy.seasonId, version: policy.version, config: policy.configJson, rows })
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
  const config = (JSON.parse(policy.configJson) as StoredConfig).config
  const captured = rows.map(row => {
    const result = row.resultJson ? (JSON.parse(row.resultJson) as Result) : null
    return {
      ...row,
      result: result
        ? {
            ...result,
            band: result.band
              ? { ...result.band, label: getConfiguredDivisionLabel(config, result.band.minimum) }
              : null,
            base: result.base
              ? { ...result.base, label: getConfiguredDivisionLabel(config, result.base.minimum) }
              : null,
          }
        : null,
      resultJson: undefined,
    }
  })
  const distribution: Record<string, number> = {}
  for (const row of captured) {
    const label = row.result ? (row.result.band?.label ?? 'Unranked') : 'Not calculated'
    distribution[label] = (distribution[label] ?? 0) + 1
  }
  return { digest, ...(await divisionRankStatus(db, guildId)), distribution, players: captured }
}

export async function activateDivisionRanks(
  db: Database,
  kv: KVNamespace,
  token: string,
  guildId: string,
  botUserId: string,
  reviewedDigest: string,
  now = Date.now(),
) {
  if (!/^[a-f0-9]{64}$/.test(reviewedDigest))
    throw new Error('Capture and review the candidate assignments, then supply their digest.')
  const policy = await getDivisionRankPolicy(db, guildId)
  if (!policy) throw new Error('Stage and calculate the assignments first.')
  if (policy.phase === 'active') return divisionRankStatus(db, guildId)
  if (!(JSON.parse(policy.configJson) as StoredConfig).membershipScopePrepared)
    throw new Error('Scope memberships to ranked players and legacy-rank cleanup before capturing the activation plan.')
  if ((await captureDivisionRanks(db, guildId)).digest !== reviewedDigest)
    throw new Error('The candidate assignments changed. Capture and review them again.')
  const { config, preparation } = JSON.parse(policy.configJson) as StoredConfig
  const currentConfig = await getRankedRoleConfig(kv, guildId)
  if (
    JSON.stringify(currentConfig.tiers.map(row => row.roleId)) !== JSON.stringify(preparation.sourceRoleIds) ||
    currentConfig.unrankedRoleId !== preparation.unrankedRoleId
  )
    throw new Error('The source role configuration changed after staging.')
  const [roles, overwriteIds, bot] = await Promise.all([
    fetchGuildRoles(token, guildId),
    fetchGuildChannelRoleOverwriteIds(token, guildId),
    fetchGuildMember(token, guildId, botUserId),
  ])
  const displayConfig = {
    ...config,
    tiers: config.tiers.map(tier => ({
      ...tier,
      label: roles.find(role => role.id === tier.roleId)?.name ?? tier.label,
    })),
  }
  const botRoles = roles.filter(role => (bot.roles ?? []).includes(role.id))
  const permissions = [...botRoles, ...roles.filter(role => role.id === guildId)].reduce(
    (mask, role) => mask | BigInt(role.permissions ?? '0'),
    0n,
  )
  const top = Math.max(0, ...botRoles.map(role => role.position ?? 0))
  if (!(permissions & (8n | (1n << 28n)))) throw new Error('The bot needs Manage Roles.')
  for (const id of [...preparation.sourceRoleIds, preparation.unrankedRoleId]) {
    const role = roles.find(row => row.id === id)
    if (!role || role.managed || role.position == null || role.position <= 0 || role.position >= top)
      throw new Error('A source rank or Unranked role is missing or cannot be managed by the bot.')
  }
  const replaced = preparation.sourceRoleIds.slice(1, -1)
  if (replaced.some(id => overwriteIds.has(id) || roles.find(role => role.id === id)?.permissions !== '0'))
    throw new Error(
      'Broad rank roles grant permissions or channel overrides. Review permission migration before replacing their memberships.',
    )
  let position = roles.find(role => role.id === preparation.unrankedRoleId)!.position!
  for (const band of PUBLIC_RATING_BANDS) {
    const role = roles.find(role => role.id === preparation.roleIdsByMinimum[band.minimum])
    if (
      !role ||
      role.managed ||
      role.position == null ||
      role.position >= top ||
      (band.division !== 0 &&
        (role.name !== getConfiguredDivisionLabel(displayConfig, band.minimum) || role.permissions !== '0'))
    )
      throw new Error('A prepared division role changed, disappeared, or moved above the bot.')
    if (role.position <= position) throw new Error('Prepared divisions must remain ordered above Unranked.')
    position = role.position
  }
  await runAtomicSeasonBatch(db, [
    seasonSourceGuard(
      db,
      sql`exists(select 1 from rating_maintenance where state = 'paused') and not exists(select 1 from rating_mutation_leases)
      and exists(select 1 from seasons where id = ${policy.seasonId} and active = 1 and public_reads_enabled = 1)
      and exists(select 1 from division_rank_policies where guild_id = ${guildId} and member_scan_complete = 1)
      and not exists(select 1 from division_rank_states where guild_id = ${guildId} and (result_json is null or last_error is not null or next_check_at <= ${now}))`,
    ),
    db
      .update(divisionRankPolicies)
      .set({ phase: 'activating', updatedAt: now })
      .where(eq(divisionRankPolicies.guildId, guildId)),
  ])
  await kv.put(
    `${RANKED_ROLE_CONFIG_KEY_PREFIX}${guildId}`,
    JSON.stringify({
      ...config,
      divisionPolicy: { version: OVERALL_RANK_POLICY_VERSION, roleIdsByMinimum: preparation.roleIdsByMinimum },
    }),
  )
  await publishDivisionAssignments(db, kv, { ...policy, phase: 'activating' })
  await runAtomicSeasonBatch(db, [
    db
      .update(divisionRankPolicies)
      .set({ phase: 'active', updatedAt: now })
      .where(eq(divisionRankPolicies.guildId, guildId)),
    db
      .update(divisionRankStates)
      .set({ nextCheckAt: 0 })
      .where(and(eq(divisionRankStates.guildId, guildId), eq(divisionRankStates.pending, true))),
  ])
  return divisionRankStatus(db, guildId)
}

export async function publishDivisionAssignments(db: Database, kv: KVNamespace, policy: Policy) {
  const fresh = await getDivisionRankPolicy(db, policy.guildId)
  if (!fresh || fresh.phase === 'prepared') return
  const states = await db.select().from(divisionRankStates).where(eq(divisionRankStates.guildId, policy.guildId))
  const byPlayerId: Record<string, CurrentRankAssignment> = {}
  for (const row of states) {
    if (!row.resultJson) continue
    const result = JSON.parse(row.resultJson) as Result
    byPlayerId[row.playerId] = {
      tier: result.band?.tier ?? 'tier5',
      sourceMode: result.sourceMode,
      unranked: !result.band,
      divisionMinimum: result.band?.minimum ?? null,
      policyVersion: result.policyVersion,
      appliedRoleId: row.appliedRoleId,
      overallRating: result.overallRating,
    }
  }
  await setCurrentRankAssignments(kv, policy.guildId, { byPlayerId })
  if (fresh.phase === 'activating') return
  await db
    .update(divisionRankPolicies)
    .set({ publishedRevision: fresh.projectionRevision })
    .where(
      and(
        eq(divisionRankPolicies.guildId, policy.guildId),
        eq(divisionRankPolicies.projectionRevision, fresh.projectionRevision),
      ),
    )
}

function divisionPeakQueries(
  db: Database,
  policy: Policy,
  result: Result,
  now: number,
): Parameters<typeof runAtomicSeasonBatch>[1] {
  if (policy.phase !== 'active' || !result.band) return []
  const active = and(
    eq(players.id, result.playerId),
    sql`exists(select 1 from season_rating_states where season_id = ${policy.seasonId} and player_id = ${result.playerId} and mode = 'global' and season_games > 0)`,
  )
  return [
    db
      .insert(seasonPeakDivisionRanks)
      .select(
        db
          .select({
            seasonId: sql<string>`${policy.seasonId}`.as('season_id'),
            playerId: players.id,
            minimum: sql<number>`${result.band.minimum}`.as('minimum'),
            achievedAt: sql<number>`${now}`.as('achieved_at'),
          })
          .from(players)
          .where(active),
      )
      .onConflictDoUpdate({
        target: [seasonPeakDivisionRanks.seasonId, seasonPeakDivisionRanks.playerId],
        set: { minimum: result.band.minimum, achievedAt: now },
        setWhere: sql`${seasonPeakDivisionRanks.minimum} < ${result.band.minimum}`,
      }),
    db
      .insert(seasonPeakRanks)
      .select(
        db
          .select({
            seasonId: sql<string>`${policy.seasonId}`.as('season_id'),
            playerId: players.id,
            tier: sql<string>`${result.band.tier}`.as('tier'),
            sourceMode: sql<string | null>`${result.sourceMode}`.as('source_mode'),
            achievedAt: sql<number>`${now}`.as('achieved_at'),
          })
          .from(players)
          .where(active),
      )
      .onConflictDoUpdate({
        target: [seasonPeakRanks.seasonId, seasonPeakRanks.playerId],
        set: { tier: result.band.tier, sourceMode: result.sourceMode, achievedAt: now },
        setWhere: sql`cast(substr(${seasonPeakRanks.tier}, 5) as integer) > ${Number(result.band.tier.slice(4))}`,
      }),
  ]
}

export async function maintainDivisionRanks(
  db: Database,
  kv: KVNamespace,
  token: string,
  policy: Policy,
  now = Date.now(),
  limit = 16,
) {
  if (policy.phase !== 'active') return { calculated: 0, attempted: 0, applied: 0 }
  const [live] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(
      and(
        eq(seasons.id, policy.seasonId),
        eq(seasons.active, true),
        sql`exists(select 1 from rating_maintenance where state = 'open')`,
      ),
    )
    .limit(1)
  if (!live) return { calculated: 0, attempted: 0, applied: 0, blocked: 'maintenance-or-season' as const }
  const calculation = await calculateDueDivisionRanks(db, policy, now, 40)
  if (calculation.blocked)
    return { calculated: calculation.calculated, attempted: 0, applied: 0, blocked: calculation.blocked }
  const calculated = calculation.calculated
  await publishPendingDivisionPlayers(db, kv, policy.guildId)
  const { preparation } = JSON.parse(policy.configJson) as StoredConfig
  const managed = [
    ...new Set([
      ...preparation.sourceRoleIds,
      preparation.unrankedRoleId,
      ...Object.values(preparation.roleIdsByMinimum),
    ]),
  ]
  const pending = await db
    .select()
    .from(divisionRankStates)
    .where(
      and(
        eq(divisionRankStates.guildId, policy.guildId),
        eq(divisionRankStates.pending, true),
        lte(divisionRankStates.retryAt, now),
      ),
    )
    .orderBy(asc(divisionRankStates.retryAt), asc(divisionRankStates.playerId))
    .limit(limit)
  let applied = 0
  for (const row of pending) {
    if (!row.desiredRoleId || !row.resultJson || row.nextCheckAt === 0) continue
    try {
      const member = await fetchGuildMember(token, policy.guildId, row.playerId)
      if (!(member.roles ?? []).includes(row.desiredRoleId))
        await addGuildMemberRole(token, policy.guildId, row.playerId, row.desiredRoleId)
      for (const roleId of member.roles ?? [])
        if (managed.includes(roleId) && roleId !== row.desiredRoleId)
          await removeGuildMemberRole(token, policy.guildId, row.playerId, roleId)
      await runAtomicSeasonBatch(db, [
        db
          .update(divisionRankStates)
          .set({
            appliedRoleId: row.desiredRoleId,
            pending: false,
            projectionPending: true,
            lastError: null,
            retryAt: 0,
          })
          .where(
            and(
              eq(divisionRankStates.guildId, policy.guildId),
              eq(divisionRankStates.playerId, row.playerId),
              eq(divisionRankStates.resultJson, row.resultJson),
            ),
          ),
        db
          .update(divisionRankStates)
          .set({ pending: true, retryAt: 0 })
          .where(
            and(
              eq(divisionRankStates.guildId, policy.guildId),
              eq(divisionRankStates.playerId, row.playerId),
              sql`${divisionRankStates.resultJson} is not ${row.resultJson}`,
            ),
          ),
        db
          .update(divisionRankPolicies)
          .set({ projectionRevision: sql`${divisionRankPolicies.projectionRevision} + 1` })
          .where(eq(divisionRankPolicies.guildId, policy.guildId)),
      ])
      applied++
    } catch (error) {
      const absent = error instanceof DiscordApiError && error.status === 404 && error.detail.includes('10007')
      await db
        .update(divisionRankStates)
        .set(
          absent
            ? { pending: false, appliedRoleId: row.desiredRoleId, lastError: null }
            : { lastError: error instanceof Error ? error.message : 'Role update failed', retryAt: now + 300_000 },
        )
        .where(
          and(
            eq(divisionRankStates.guildId, policy.guildId),
            eq(divisionRankStates.playerId, row.playerId),
            eq(divisionRankStates.resultJson, row.resultJson),
          ),
        )
      if (!absent)
        await db
          .update(divisionRankStates)
          .set({ pending: true, retryAt: now + 300_000 })
          .where(
            and(
              eq(divisionRankStates.guildId, policy.guildId),
              eq(divisionRankStates.playerId, row.playerId),
              sql`${divisionRankStates.resultJson} is not ${row.resultJson}`,
            ),
          )
    }
  }
  return { calculated, attempted: pending.length, applied }
}

export async function previewSavedDivisionRanks(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerIds?: string[],
): Promise<RankedRolePreview> {
  const config = await getRankedRoleConfig(kv, guildId)
  const selected = await db
    .select({ state: divisionRankStates, displayName: players.displayName })
    .from(divisionRankStates)
    .innerJoin(players, eq(players.id, divisionRankStates.playerId))
    .where(
      and(
        eq(divisionRankStates.guildId, guildId),
        playerIds
          ? sql`${divisionRankStates.playerId} in (select value from json_each(${JSON.stringify(playerIds)}))`
          : undefined,
      ),
    )
  const rows = selected.map(row => row.state)
  const identity = new Map(selected.map(row => [row.state.playerId, row.displayName]))
  const empty = { 'duel': null, 'duo': null, 'squad': null, 'ffa': null, 'red-death': null }
  const playerPreviews = rows
    .filter(row => row.resultJson)
    .map(row => {
      const result = JSON.parse(row.resultJson!) as Result
      const assignment: CurrentRankAssignment = {
        tier: result.band?.tier ?? 'tier5',
        sourceMode: result.sourceMode,
        unranked: !result.band,
        divisionMinimum: result.band?.minimum ?? null,
        policyVersion: result.policyVersion,
        appliedRoleId: row.appliedRoleId,
        overallRating: result.overallRating,
      }
      return {
        playerId: row.playerId,
        displayName: identity.get(row.playerId) ?? row.playerId,
        qualified: !!result.band,
        managed: !!result.band,
        globalScore: null,
        liveAssignment: assignment,
        assignment,
        previousAssignment: assignment,
        previousSourceMode: result.sourceMode,
        ladderTiers: { ...empty },
        ladderRanks: { ...empty },
        ladderScores: { ...empty },
        pendingDemotion: null,
        status: 'kept' as const,
      }
    })
  const distribution: Record<string, number> = {}
  for (const player of playerPreviews)
    if (player.qualified) distribution[player.assignment.tier] = (distribution[player.assignment.tier] ?? 0) + 1
  return {
    guildId,
    evaluatedAt: Date.now(),
    config,
    playerPreviews,
    distribution,
    unrankedCount: playerPreviews.filter(row => !row.qualified).length,
    missingConfigTiers: [],
  }
}

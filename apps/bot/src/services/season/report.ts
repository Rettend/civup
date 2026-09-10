import type { Database } from '@civup/db'
import type { SQL } from 'drizzle-orm'
import type { DbBatchItem } from '../db/batch.ts'
import type { ParticipantRow } from '../match/types.ts'
import type { StoredRatingSummaryRow } from '../match/report.ts'
import { divisionRankPolicies, divisionRankStates, matches, matchParticipants, playerRatingEvents, playerRatings, publicRatingCalibrations, publicRatingSeeds, seasonMatchReports, seasonRatingConfigurations, seasonRatingStates, seasons } from '@civup/db'
import { advancePublicRatingBadge, calculatePublicRatingTransition, createRating, PUBLIC_RATING_START, publicRatingTarget, recordPublicRatingDecayGame, settlePublicRatingDecay } from '@civup/rating'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getStoredGameModeContext } from '../match/draft-data.ts'
import { buildMatchEvidenceByPlayerId, buildRatingScopeUpdateQueries } from '../match/report.ts'
import { seasonMutationError } from './policy.ts'
import { markRatingMutationUncertain } from './maintenance.ts'
import { loadPublicRatingDecayPolicy, samePublicRatingDecay } from './decay.ts'
import { prepareAtomicDivisionUpdates, type DivisionRatingInput, type DivisionEventInput } from '../ranked/atomic-divisions.ts'
import { notifyDivisionDelivery } from '../ranked/division-delivery.ts'

export interface PreparedSeasonReport {
  queries: DbBatchItem[]
  acceptedAt: number
  late: boolean
  idempotent: boolean
}

const evidenceKeys = ['gamesPlayed', 'wins', 'importedGames', 'effectiveGames', 'winsVsTier1', 'winsVsTier2Plus', 'effectiveWinsVsTier1', 'effectiveWinsVsTier2Plus'] as const

/** A failing SELECT aborts the same D1 transaction without a separate guard write. */
export function seasonSourceGuard(db: Database, condition: SQL): DbBatchItem {
  return db.select({ valid: sql<number>`case when ${condition} then 1 else json_extract('Stale season rating source', '$') end` }).from(sql`(select 1) as rating_guard`)
}

export async function runAtomicSeasonBatch(db: Database, queries: DbBatchItem[]): Promise<void> {
  if (queries.length === 0) return
  if (queries.length > 400) throw new Error('Season update exceeds the online statement limit. Use reviewed local maintenance.')
  if (typeof db.batch !== 'function') throw new Error('Season ratings require an atomic database batch; sequential writes are not supported.')
  const encoder = new TextEncoder()
  for (const query of queries) {
    const compiled = (query as unknown as { toSQL(): { sql: string, params: unknown[] } }).toSQL()
    const bytes = encoder.encode(compiled.sql).length + encoder.encode(JSON.stringify(compiled.params)).length
    if (compiled.params.length > 100 || bytes > 100_000) throw new Error('Season update exceeds the per-statement database limit.')
  }
  try { await db.batch(queries as [DbBatchItem, ...DbBatchItem[]]) }
  catch (error) { markRatingMutationUncertain(); throw error }
  notifyDivisionDelivery(queries)
}

export async function prepareSeasonReport(db: Database, input: {
  match: typeof matches.$inferSelect
  participants: ParticipantRow[]
  acceptedAt: number
  now: number
  opponentTierByPlayerId: ReadonlyMap<string, string>
}): Promise<PreparedSeasonReport> {
  const { match, participants, now } = input
  if (!match.seasonId) throw new Error('Season reporting requires an assigned season.')
  const [season] = await db.select().from(seasons).where(eq(seasons.id, match.seasonId)).limit(1)
  if (!season?.isolatedRatingsEnabled) throw new Error('Season-isolated reporting is not enabled.')
  const context = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!context?.leaderboardMode) throw new Error('Season rating updates require a rated game mode.')
  if (participants.length < 2 || new Set(participants.map(row => row.playerId)).size !== participants.length
    || participants.some(row => row.matchId !== match.id || !Number.isSafeInteger(row.placement) || row.placement! < 1)) throw new Error('Invalid season report participants or placements.')

  const [reported] = await db.select().from(seasonMatchReports).where(eq(seasonMatchReports.matchId, match.id)).limit(1)
  const acceptedAt = reported?.acceptedAt ?? input.acceptedAt
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < match.createdAt || acceptedAt > now) throw new Error('Invalid report acceptance time.')
  const error = seasonMutationError(season, { ...match, status: reported ? 'active' : match.status }, 'first-report', now, acceptedAt)
  // An already committed report may finish its projections after finalization; it changes no ratings.
  if (error && !reported) throw new Error(error)
  const scopes = [context.leaderboardMode, 'global'] as const
  const decayPolicy = season.ratingSystem === 'rp' ? await loadPublicRatingDecayPolicy(db) : null
  if (reported) {
    if (reported.cancelledAt != null) throw new Error('This season report was cancelled.')
    if (reported.seasonId !== season.id) throw new Error('Report season identity changed.')
    const events = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.matchId, match.id))
    if (events.length !== participants.length * scopes.length || participants.some(player => scopes.some(scope => !events.some(event =>
      event.playerId === player.playerId && event.mode === scope && event.seasonId === season.id
      && (season.ratingSystem !== 'rp' || (event.publicSequence === reported.sequence && event.publicRatingAfter != null)))))) throw new Error('Committed season report is incomplete; owner review is required.')
    return { queries: [], acceptedAt, late: !season.active, idempotent: true }
  }

  const ids = participants.map(row => row.playerId)
  const [states, liveRows, seeds, configurations] = await Promise.all([
    db.select().from(seasonRatingStates).where(and(eq(seasonRatingStates.seasonId, season.id), inArray(seasonRatingStates.playerId, ids), inArray(seasonRatingStates.mode, scopes))),
    season.active ? db.select().from(playerRatings).where(and(inArray(playerRatings.playerId, ids), inArray(playerRatings.mode, scopes))) : Promise.resolve([]),
    db.select().from(publicRatingSeeds).where(and(eq(publicRatingSeeds.seasonId, season.id), inArray(publicRatingSeeds.playerId, ids), inArray(publicRatingSeeds.mode, scopes))),
    season.ratingSystem === 'rp' ? db.select({ mode: seasonRatingConfigurations.mode, formulaVersion: seasonRatingConfigurations.formulaVersion, calibrationVersion: seasonRatingConfigurations.calibrationVersion, calibration: publicRatingCalibrations.calibration })
      .from(seasonRatingConfigurations).innerJoin(publicRatingCalibrations, eq(publicRatingCalibrations.version, seasonRatingConfigurations.calibrationVersion))
      .where(and(eq(seasonRatingConfigurations.seasonId, season.id), inArray(seasonRatingConfigurations.mode, scopes))) : Promise.resolve([]),
  ])

  const queries: DbBatchItem[] = [
    seasonSourceGuard(db, sql`exists(select 1 from ${seasons} where ${seasons.id} = ${season.id}
      and ${seasons.active} = ${season.active} and ${seasons.endsAt} is ${season.endsAt}
      and ${seasons.finalizedAt} is ${season.finalizedAt} and ${seasons.reportingDeadline} is ${season.reportingDeadline}
      and ${seasons.startsAt} = ${season.startsAt}
      and ${seasons.isolatedRatingsEnabled} = 1 and ${seasons.ratingSystem} = ${season.ratingSystem})`),
    seasonSourceGuard(db, sql`exists(select 1 from ${matches} where ${matches.id} = ${match.id}
      and ${matches.status} = 'active' and ${matches.seasonId} = ${season.id}
      and ${matches.createdAt} = ${match.createdAt} and ${matches.draftData} is ${match.draftData}
      and ${matches.gameMode} = ${match.gameMode} and ${matches.isOld} = ${match.isOld})
      and not exists(select 1 from ${seasonMatchReports} where ${seasonMatchReports.matchId} = ${match.id})
      and not exists(select 1 from ${playerRatingEvents} where ${playerRatingEvents.matchId} = ${match.id})
      and (select count(*) from ${matchParticipants} where ${matchParticipants.matchId} = ${match.id}) = ${participants.length}`),
  ]
  if (decayPolicy) queries.push(seasonSourceGuard(db, sql`exists(select 1 from public_rating_decay_policies where version=${decayPolicy.version} and enabled_at=${decayPolicy.enabledAt})`))
  for (const participant of participants) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${matchParticipants}
    where ${matchParticipants.matchId} = ${match.id} and ${matchParticipants.playerId} = ${participant.playerId}
    and ${matchParticipants.team} is ${participant.team} and ${matchParticipants.placement} = ${participant.placement}
    and ${matchParticipants.civId} is ${participant.civId})`))

  let opponentTiers = season.active ? input.opponentTierByPlayerId : new Map(states.filter(state => state.mode === 'global' && state.managedTier != null).map(state => [state.playerId, state.managedTier!]))
  if (season.active && season.ratingSystem === 'rp') {
    const assigned = await db.select({ guildId: divisionRankPolicies.guildId, playerId: divisionRankStates.playerId, result: divisionRankStates.resultJson }).from(divisionRankPolicies)
      .leftJoin(divisionRankStates, and(eq(divisionRankStates.guildId, divisionRankPolicies.guildId), inArray(divisionRankStates.playerId, ids)))
      .where(and(eq(divisionRankPolicies.seasonId, season.id), eq(divisionRankPolicies.phase,'active')))
    if (new Set(assigned.map(row=>row.guildId)).size > 1) throw new Error('A report needs an unambiguous guild rank policy.')
    if (assigned.length) opponentTiers = new Map(assigned.flatMap(row => {
      const result = row.result ? JSON.parse(row.result) : null
      return row.playerId && result?.band?.tier ? [[row.playerId,result.band.tier] as const] : []
    }))
    if (assigned.length) {
      const guildId = assigned[0]!.guildId
      const expected = JSON.stringify(ids.map(playerId => ({ playerId, result: assigned.find(row => row.playerId === playerId)?.result ?? null })))
      queries.push(seasonSourceGuard(db, sql`not exists(select 1 from json_each(${expected}) e
        left join division_rank_states s on s.guild_id=${guildId} and s.player_id=json_extract(e.value,'$.playerId')
        where s.result_json is not json_extract(e.value,'$.result'))`))
    }
  }
  queries.push(db.insert(seasonMatchReports).values({ matchId: match.id, seasonId: season.id, acceptedAt, opponentTiers: Object.fromEntries([...opponentTiers].filter(([id]) => ids.includes(id))) }))
  const evidence = buildMatchEvidenceByPlayerId(participants, match.isOld, opponentTiers, context.permanentAlly)
  const divisionRatings: DivisionRatingInput[] = []
  const divisionEvents: DivisionEventInput[] = []

  for (const scope of scopes) {
    const configuration = configurations.find(row => row.mode === scope)
    if (season.ratingSystem === 'rp' && (!configuration || configuration.calibration.scope !== scope || configuration.calibration.version !== configuration.calibrationVersion)) throw new Error(`Missing or invalid season calibration for ${scope}.`)
    const summaries = new Map<string, StoredRatingSummaryRow>()
    for (const playerId of ids) {
      const state = states.find(row => row.playerId === playerId && row.mode === scope)
      const live = liveRows.find(row => row.playerId === playerId && row.mode === scope)
      const seed = seeds.find(row => row.playerId === playerId && row.mode === scope)
      if (!state && (live || seed)) throw new Error('Season state is missing for an existing rating chain.')
      if (state && season.ratingSystem === 'rp' && (!seed || state.publicRating == null)) throw new Error('Public season state or opening seed is incomplete.')
      if (state && season.active && (!live || live.mu !== state.mu || live.sigma !== state.sigma || live.publicRating !== state.publicRating || live.publicBadge !== state.publicBadge || !samePublicRatingDecay(live.publicDecay, state.publicDecay)
        || evidenceKeys.some(key => live[key] !== (state.evidence[key] ?? 0)))) throw new Error('Live rating and season summary disagree.')
      const identity = sql`${seasonRatingStates.seasonId} = ${season.id} and ${seasonRatingStates.playerId} = ${playerId} and ${seasonRatingStates.mode} = ${scope}`
      queries.push(seasonSourceGuard(db, state
        ? sql`exists(select 1 from ${seasonRatingStates} where ${identity} and ${seasonRatingStates.revision} = ${state.revision}
          and ${seasonRatingStates.mu} = ${state.mu} and ${seasonRatingStates.sigma} = ${state.sigma}
            and ${seasonRatingStates.publicRating} is ${state.publicRating} and ${seasonRatingStates.publicBadge} is ${state.publicBadge} and ${seasonRatingStates.publicDecay} is ${state.publicDecay ? JSON.stringify(state.publicDecay) : null} and ${seasonRatingStates.evidence} = ${JSON.stringify(state.evidence)}
          and ${seasonRatingStates.seasonGames} = ${state.seasonGames} and ${seasonRatingStates.seasonWins} = ${state.seasonWins}
          and ${seasonRatingStates.lastPlayedAt} is ${state.lastPlayedAt}
          and ${seasonRatingStates.managedTier} is ${state.managedTier} and ${seasonRatingStates.updatedAt} = ${state.updatedAt})`
        : sql`not exists(select 1 from ${seasonRatingStates} where ${identity})`))
      if (season.active) queries.push(seasonSourceGuard(db, live
        ? sql`exists(select 1 from ${playerRatings} where ${playerRatings.playerId} = ${playerId} and ${playerRatings.mode} = ${scope}
          and ${playerRatings.mu} = ${live.mu} and ${playerRatings.sigma} = ${live.sigma} and ${playerRatings.updatedAt} is ${live.updatedAt}
            and ${playerRatings.publicRating} is ${live.publicRating} and ${playerRatings.publicBadge} is ${live.publicBadge} and ${playerRatings.publicDecay} is ${live.publicDecay ? JSON.stringify(live.publicDecay) : null} and ${playerRatings.lastPlayedAt} is ${live.lastPlayedAt}
          and ${and(...evidenceKeys.map(field => sql`${playerRatings[field]} = ${live[field]}`))})`
        : sql`not exists(select 1 from ${playerRatings} where ${playerRatings.playerId} = ${playerId} and ${playerRatings.mode} = ${scope})`))
      const fresh = createRating(playerId)
      const carried = Object.fromEntries(evidenceKeys.map(key => [key, state?.evidence[key] ?? 0])) as Pick<StoredRatingSummaryRow, typeof evidenceKeys[number]>
      summaries.set(playerId, { playerId, mode: scope, mu: state?.mu ?? fresh.mu, sigma: state?.sigma ?? fresh.sigma, ...carried, lastPlayedAt: state?.lastPlayedAt ?? null, updatedAt: state?.updatedAt ?? null })
      if (!state && configuration) queries.push(db.insert(publicRatingSeeds).values({
        seasonId: season.id, playerId, mode: scope, rating: PUBLIC_RATING_START,
        hiddenMu: fresh.mu, hiddenSigma: fresh.sigma, sourceMu: fresh.mu, sourceSigma: fresh.sigma,
        sourceHiddenScore: fresh.mu - 0.75 * fresh.sigma, effectiveAt: acceptedAt,
        formulaVersion: configuration.formulaVersion, calibrationVersion: configuration.calibrationVersion,
        seedVersion: 'new-player-v1', evidence: carried,
      }))
    }

    const computed = buildRatingScopeUpdateQueries(db, {
      ratingPolicy: season.ratingSystem === 'rp' ? 'rp-v3' : undefined,
      scope, match, gameMode: context.mode, permanentAlly: context.permanentAlly,
      participantRows: participants, existingRatingsByPlayerId: summaries, evidenceByPlayerId: evidence,
      now: acceptedAt, writeParticipantSnapshots: false,
      collect({ summary, event, rawAfterMu }) {
        const state = states.find(row => row.playerId === summary.playerId && row.mode === scope)
        const storedBefore = state?.publicRating ?? PUBLIC_RATING_START
        const decayAt = Math.min(acceptedAt, season.endsAt ?? acceptedAt)
        const decay = decayPolicy ? settlePublicRatingDecay(storedBefore, state?.publicDecay, decayAt, decayPolicy, season.startsAt) : { rating: storedBefore, state: null, delta: 0 }
        const before = decay.rating
        const transition = configuration ? calculatePublicRatingTransition({
          formulaVersion: configuration.formulaVersion, priorRating: before,
          hiddenMuBefore: event.ratingBeforeMu, hiddenMuAfterRaw: rawAfterMu,
          hiddenSigmaBefore: event.ratingBeforeSigma,
          targetRating: publicRatingTarget(summary.mu - 0.75 * summary.sigma, configuration.calibration), sourceWeight: match.isOld ? 0.5 : 1,
        }) : null
        const row = {
          seasonId: season.id, playerId: summary.playerId, mode: scope,
           mu: summary.mu, sigma: summary.sigma, publicRating: transition?.after ?? null,
           publicBadge: transition ? advancePublicRatingBadge(before, transition.after, state?.publicBadge ?? null) : null,
           publicDecay: transition && decayPolicy ? recordPublicRatingDecayGame(transition.after, decay.state, decayAt, decayPolicy, !match.isOld && season.active) : null,
          managedTier: state?.managedTier ?? null,
          seasonGames: (state?.seasonGames ?? 0) + 1, seasonWins: (state?.seasonWins ?? 0) + (event.winsDelta ?? 0),
          evidence: Object.fromEntries(evidenceKeys.map(key => [key, summary[key]])),
          lastPlayedAt: summary.lastPlayedAt, revision: (state?.revision ?? 0) + 1, updatedAt: now,
        }
        if (season.active && transition) {
          divisionRatings.push({ ...summary, publicRating: row.publicRating, publicBadge: row.publicBadge, publicDecay: row.publicDecay })
          divisionEvents.push({ ...event, at: acceptedAt, effectiveGamesDelta: event.effectiveGamesDelta ?? 0, effectiveWinsVsTier1Delta: event.effectiveWinsVsTier1Delta ?? 0, effectiveWinsVsTier2PlusDelta: event.effectiveWinsVsTier2PlusDelta ?? 0 })
        }
        queries.push(db.insert(seasonRatingStates).values(row).onConflictDoUpdate({ target: [seasonRatingStates.seasonId, seasonRatingStates.playerId, seasonRatingStates.mode], set: row }))
        if (season.active) queries.push(db.insert(playerRatings).values({ ...summary, publicRating: row.publicRating, publicBadge: row.publicBadge, publicDecay: row.publicDecay }).onConflictDoUpdate({ target: [playerRatings.playerId, playerRatings.mode], set: { ...summary, publicRating: row.publicRating, publicBadge: row.publicBadge, publicDecay: row.publicDecay } }))
        queries.push(db.insert(playerRatingEvents).values({ ...event, seasonId: season.id,
          publicSequence: transition ? sql`(select ${seasonMatchReports.sequence} from ${seasonMatchReports} where ${seasonMatchReports.matchId} = ${match.id})` : null,
          publicRatingBefore: transition?.before ?? null, publicRatingAfter: transition?.after ?? null,
          publicDecayBefore: decay.state, publicDecayAfter: row.publicDecay, publicDecayDelta: decay.delta,
          publicFormulaVersion: configuration?.formulaVersion ?? null, publicCalibrationVersion: configuration?.calibrationVersion ?? null,
        }))
        if (scope !== 'global') queries.push(db.update(matchParticipants).set({
          ratingBeforeMu: event.ratingBeforeMu, ratingBeforeSigma: event.ratingBeforeSigma,
          ratingAfterMu: event.ratingAfterMu, ratingAfterSigma: event.ratingAfterSigma,
        }).where(and(eq(matchParticipants.matchId, match.id), eq(matchParticipants.playerId, summary.playerId))))
      },
    })
    if (typeof computed === 'string') throw new Error(computed)
  }
  if (season.active && season.ratingSystem === 'rp') {
    const division = await prepareAtomicDivisionUpdates(db, { seasonId: season.id, now, ratings: divisionRatings, events: divisionEvents, replacedMatchIds: [match.id] })
    queries.unshift(...division.guards)
    queries.push(...division.updates)
  }
  if (queries.length > 400) throw new Error('Season report exceeds the online statement limit.')
  return { queries, acceptedAt, late: !season.active, idempotent: false }
}

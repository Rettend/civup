import type { Database } from '@civup/db'
import type { ParticipantRow } from '../match/types.ts'
import type { StoredRatingSummaryRow } from '../match/report.ts'
import type { DbBatchItem } from '../db/batch.ts'
import type { SQL } from 'drizzle-orm'
import { matches, matchParticipants, playerRatingEvents, playerRatings, publicRatingCalibrations, publicRatingSeeds, seasonMatchReports, seasonRatingStates, seasonRatingCheckpoints, seasons } from '@civup/db'
import { parseLeaderboardMode } from '@civup/game'
import { advancePublicRatingBadge, calculatePublicRatingTransition, createRating, PUBLIC_RATING_START, publicRatingTarget, recordPublicRatingDecayGame, settlePublicRatingDecay, type PublicRatingDecayState } from '@civup/rating'
import { and, eq, getTableColumns, gte, sql } from 'drizzle-orm'
import { inJson as inArray } from '../db/in-json.ts'
import { matchCorrectionAgeError } from './policy.ts'
import { getStoredGameModeContext } from '../match/draft-data.ts'
import { buildMatchEvidenceByPlayerId, buildRatingScopeUpdateQueries } from '../match/report.ts'
import { seasonSourceGuard } from './report.ts'
import { loadPublicRatingDecayPolicy, samePublicRatingDecay } from './decay.ts'
import { prepareAtomicDivisionUpdates } from '../ranked/atomic-divisions.ts'
import { writeRatingCheckpoints, type RatingCheckpoint } from './checkpoints.ts'
import { sameReplayNumber } from './replay-number.ts'

const evidenceKeys = ['gamesPlayed', 'wins', 'importedGames', 'effectiveGames', 'winsVsTier1', 'winsVsTier2Plus', 'effectiveWinsVsTier1', 'effectiveWinsVsTier2Plus'] as const
const eventFields = ['ratingBeforeMu', 'ratingBeforeSigma', 'ratingAfterMu', 'ratingAfterSigma', 'gamesDelta', 'winsDelta', 'importedGamesDelta', 'effectiveGamesDelta', 'winsVsTier1Delta', 'winsVsTier2PlusDelta', 'effectiveWinsVsTier1Delta', 'effectiveWinsVsTier2PlusDelta', 'publicRatingBefore', 'publicRatingAfter', 'publicSequence', 'publicFormulaVersion', 'publicCalibrationVersion', 'publicDecayBefore', 'publicDecayAfter', 'publicDecayDelta'] as const
const storedEventValue = (value: unknown) => value != null && typeof value === 'object' ? JSON.stringify(value) : value ?? null
const floatingReplayFields = new Set<string>(['ratingBeforeMu', 'ratingBeforeSigma', 'ratingAfterMu', 'ratingAfterSigma', 'publicRatingBefore', 'publicRatingAfter', 'publicDecayDelta'])

export interface SeasonReplayChange {
  matchId: string
  cancel?: boolean
  restore?: boolean
  participants?: ParticipantRow[]
}

export async function prepareSeasonReplay(db: Database, seasonId: string, change?: SeasonReplayChange, now = Date.now()): Promise<{ queries: DbBatchItem[], matchIds: string[] }> {
  const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId)).limit(1)
  if (!season?.active || season.endsAt != null || season.finalizedAt != null || season.ratingSystem !== 'rp' || !season.isolatedRatingsEnabled) throw new Error('Only an active public season can be corrected online.')
  if (change) {
    const [match] = await db.select().from(matches).where(eq(matches.id, change.matchId)).limit(1)
    if (!match || match.seasonId !== seasonId) throw new Error('The correction does not belong to this season.')
    const ageError = matchCorrectionAgeError(match, now)
    if (ageError) throw new Error(ageError)
  }
  const decayPolicy = await loadPublicRatingDecayPolicy(db)
  const [boundary] = change ? await db.select().from(seasonMatchReports).where(eq(seasonMatchReports.matchId, change.matchId)).limit(1) : []
  if (change && boundary?.seasonId !== seasonId) throw new Error('The correction has no recorded report order in this season.')
  if (change?.restore && (change.cancel || !change.participants || boundary?.cancelledAt == null)) throw new Error('Restoring a result requires a cancelled report and complete placements.')
  const firstSequence = boundary?.sequence ?? 0
  const reportScope = and(eq(seasonMatchReports.seasonId, seasonId), change ? sql`${seasonMatchReports.matchId} in (
    with recursive affected(match_id, sequence) as (
      select ${change.matchId}, ${firstSequence}
      union
      select r.match_id, r.sequence from season_match_reports r join match_participants p on p.match_id=r.match_id
        where r.season_id=${seasonId} and r.sequence>${firstSequence} and r.cancelled_at is null
          and p.player_id in (select value from json_each(${JSON.stringify(change.participants?.map(row => row.playerId) ?? [])}))
      union
      select r.match_id, r.sequence from affected a
        join match_participants p on p.match_id=a.match_id
        join match_participants q on q.player_id=p.player_id
        join season_match_reports r on r.match_id=q.match_id
        where r.season_id=${seasonId} and r.sequence>a.sequence and r.cancelled_at is null
    ) select match_id from affected
  )` : gte(seasonMatchReports.sequence, firstSequence))!
  const reports = await db.select().from(seasonMatchReports).where(reportScope).orderBy(seasonMatchReports.sequence)
  if (change && !reports.some(row => row.matchId === change.matchId)) throw new Error('The correction has no recorded report order.')
  if (reports.length === 0) return { queries: [], matchIds: [] }
  const ids = reports.map(row => row.matchId)
  const [storedMatches, participants, events] = await Promise.all([
    db.select().from(matches).where(inArray(matches.id, ids)),
    db.select().from(matchParticipants).where(inArray(matchParticipants.matchId, ids)),
    db.select().from(playerRatingEvents).where(inArray(playerRatingEvents.matchId, ids)),
  ])
  if (events.some(event => event.seasonId !== seasonId)) throw new Error('A report contains an event assigned to another season.')
  const key = (row: { playerId: string, mode: string }) => `${row.playerId}:${row.mode}`
  const requiredChains = new Set<string>()
  const chainStarts = new Map<string, number>()
  for (const match of storedMatches) {
    const mode = getStoredGameModeContext(match.gameMode, match.draftData)?.leaderboardMode
    if (!mode) throw new Error('The report has no ranked rating scope.')
    const rows = [...participants.filter(row => row.matchId === match.id), ...(change?.matchId === match.id ? change.participants ?? [] : [])]
    for (const row of rows) for (const scope of [mode, 'global']) {
      const chain = key({ playerId: row.playerId, mode: scope })
      requiredChains.add(chain)
      chainStarts.set(chain, Math.min(chainStarts.get(chain) ?? Infinity, reports.find(report => report.matchId === match.id)!.sequence))
    }
  }
  const playerIds = [...new Set([...participants.map(row => row.playerId), ...(change?.participants?.map(row => row.playerId) ?? [])])]
  const [seedRows, stateRows, liveRows] = playerIds.length ? await Promise.all([
    db.select().from(publicRatingSeeds).where(and(eq(publicRatingSeeds.seasonId, seasonId), inArray(publicRatingSeeds.playerId, playerIds))),
    db.select().from(seasonRatingStates).where(and(eq(seasonRatingStates.seasonId, seasonId), inArray(seasonRatingStates.playerId, playerIds))),
    db.select().from(playerRatings).where(inArray(playerRatings.playerId, playerIds)),
  ]) : [[], [], []]
  const seeds = seedRows.filter(row => requiredChains.has(key(row)))
  const states = stateRows.filter(row => requiredChains.has(key(row)))
  const versions = [...new Set([...seeds.map(seed => seed.calibrationVersion), ...events.flatMap(event => event.publicCalibrationVersion ? [event.publicCalibrationVersion] : [])])]
  const calibrations = versions.length ? await db.select().from(publicRatingCalibrations).where(inArray(publicRatingCalibrations.version, versions)) : []
  if (storedMatches.length !== reports.length || storedMatches.some(match => match.seasonId !== seasonId || !['completed', 'cancelled'].includes(match.status))) throw new Error('Finish pending report projections before correcting this season.')
  if (change?.participants && (new Set(change.participants.map(row => row.playerId)).size !== change.participants.length || change.participants.length < 2 || change.participants.some(row => row.matchId !== change.matchId || row.placement == null))) throw new Error('Invalid corrected participants.')
  const eventKey = (row: { matchId: string, playerId: string, mode: string }) => `${row.matchId}:${key(row)}`
  const originalEvents = new Map(events.map(event => [eventKey(event), event]))
  const calibrationByVersion = new Map(calibrations.map(row => [row.version, row.calibration]))
  const chainKeys = JSON.stringify(seeds.map(seed => [seed.playerId, seed.mode, chainStarts.get(key(seed))]))
  const prefixColumns = Object.fromEntries(Object.entries(getTableColumns(playerRatingEvents)).map(([field, column]) => [field, sql`${column}`.mapWith(column)])) as {
    [K in keyof typeof playerRatingEvents.$inferSelect]: SQL<typeof playerRatingEvents.$inferSelect[K]>
  }
  const checkpointReady = sql<number>`(${seasonRatingCheckpoints.version}=1 and ${seasonRatingCheckpoints.matchId}=${playerRatingEvents.matchId} and (${seasonRatingCheckpoints.fromHistory}=0 or exists(select 1 from season_checkpoint_initializations i
    where i.season_id=${seasonRatingCheckpoints.seasonId} and i.player_id=${seasonRatingCheckpoints.playerId} and i.mode=${seasonRatingCheckpoints.mode}
      and i.complete=1 and i.sequence>=${seasonRatingCheckpoints.sequence})))`
  const prefix = firstSequence > 0 && seeds.length ? await db.select({ ...prefixColumns, acceptedAt: seasonMatchReports.acceptedAt, checkpoint: seasonRatingCheckpoints.summary, checkpointReady,
    reportSequence: seasonMatchReports.sequence, reportSeasonId: seasonMatchReports.seasonId, cancelledAt: seasonMatchReports.cancelledAt })
    .from(sql`json_each(${chainKeys}) AS expected CROSS JOIN ${playerRatingEvents}`)
    .innerJoin(seasonMatchReports, eq(seasonMatchReports.matchId, playerRatingEvents.matchId))
    .leftJoin(seasonRatingCheckpoints, and(eq(seasonRatingCheckpoints.seasonId, playerRatingEvents.seasonId), eq(seasonRatingCheckpoints.playerId, playerRatingEvents.playerId), eq(seasonRatingCheckpoints.mode, playerRatingEvents.mode), eq(seasonRatingCheckpoints.sequence, playerRatingEvents.publicSequence)))
    .where(sql`${playerRatingEvents.seasonId} = ${seasonId} AND ${playerRatingEvents.playerId} = json_extract(expected.value, '$[0]')
      AND ${playerRatingEvents.mode} = json_extract(expected.value, '$[1]') AND ${playerRatingEvents.publicSequence} = (
        SELECT max(e.public_sequence) FROM player_rating_events e WHERE e.season_id=${seasonId}
          AND e.player_id=json_extract(expected.value, '$[0]') AND e.mode=json_extract(expected.value, '$[1]')
          AND e.public_sequence < json_extract(expected.value, '$[2]'))`)
    .orderBy(playerRatingEvents.publicSequence) : []

  function calculate(edit?: SeasonReplayChange) {
    const ratings = new Map<string, StoredRatingSummaryRow & { publicRating: number, publicBadge: number | null, publicDecay: PublicRatingDecayState | null, seasonGames: number, seasonWins: number }>()
    for (const seed of seeds) {
      const scope = seed.mode === 'global' ? 'global' : parseLeaderboardMode(seed.mode)
      if (!scope) throw new Error('Unrecognized seeded rating scope.')
      ratings.set(key(seed), { playerId: seed.playerId, mode: scope, mu: seed.hiddenMu, sigma: seed.hiddenSigma,
        ...Object.fromEntries(evidenceKeys.map(field => [field, seed.evidence[field] ?? 0])) as Pick<StoredRatingSummaryRow, typeof evidenceKeys[number]>,
        publicRating: seed.rating, publicBadge: null, publicDecay: null, lastPlayedAt: seed.lastPlayedAt, updatedAt: seed.effectiveAt, seasonGames: 0, seasonWins: 0,
      })
    }
    for (const event of prefix) {
      if (event.cancelledAt != null || event.reportSeasonId !== seasonId || event.reportSequence !== event.publicSequence) throw new Error('The saved prefix has an invalid report identity or cancellation state.')
      if (!event.checkpoint || !event.checkpointReady) throw new Error('Rating history checkpoints are not ready for this correction.')
      const saved = JSON.parse(event.checkpoint) as RatingCheckpoint
      if (saved.playerId !== event.playerId || saved.mode !== event.mode || saved.mu !== event.ratingAfterMu || saved.sigma !== event.ratingAfterSigma
        || saved.publicRating !== event.publicRatingAfter || !samePublicRatingDecay(saved.publicDecay, event.publicDecayAfter)
        || evidenceKeys.some(field => !Number.isFinite(saved[field]) || saved[field] < 0)) throw new Error('The saved rating checkpoint does not match its event.')
      ratings.set(key(event), saved)
    }
    const rebuilt: Array<typeof playerRatingEvents.$inferInsert> = []
    const checkpoints: Array<{ matchId: string, summary: RatingCheckpoint }> = []
    for (const report of reports) {
      const match = storedMatches.find(row => row.id === report.matchId)!
      const restoring = edit?.matchId === match.id && edit.restore
      if ((!restoring && (report.cancelledAt != null || match.status === 'cancelled')) || (edit?.matchId === match.id && edit.cancel)) continue
      const context = getStoredGameModeContext(match.gameMode, match.draftData)
      if (!context?.leaderboardMode) throw new Error('Recorded season report is not a ranked match.')
      const rows = edit?.matchId === match.id && edit.participants ? edit.participants : participants.filter(row => row.matchId === match.id)
      if (rows.length < 2 || rows.some(row => row.placement == null)) throw new Error('Reported season match has incomplete placements.')
      const evidence = buildMatchEvidenceByPlayerId(rows, match.isOld, new Map(Object.entries(report.opponentTiers)), context.permanentAlly)
      for (const scope of [context.leaderboardMode, 'global'] as const) {
        const existing = new Map(rows.map(row => {
          const rating = ratings.get(key({ ...row, mode: scope }))
          if (!rating) throw new Error('A corrected participant needs an audited opening seed before replay.')
          return [row.playerId, rating]
        }))
        const result = buildRatingScopeUpdateQueries(db, { scope, match, gameMode: context.mode, permanentAlly: context.permanentAlly,
          ratingPolicy: 'rp-v3',
          participantRows: rows, existingRatingsByPlayerId: existing, evidenceByPlayerId: evidence,
          now: report.acceptedAt, writeParticipantSnapshots: false,
          collect({ summary, event, rawAfterMu }) {
            const original = originalEvents.get(eventKey(event))
            const seed = seeds.find(seed => key(seed) === key(summary))!
            const version = original?.publicCalibrationVersion ?? seed.calibrationVersion
            const formula = original?.publicFormulaVersion ?? seed.formulaVersion
            const calibration = calibrationByVersion.get(version)
            if (!calibration || calibration.scope !== scope) throw new Error('A recorded calibration is missing or belongs to another scope.')
            const previous = ratings.get(key(summary))!
            const decay = decayPolicy ? settlePublicRatingDecay(previous.publicRating, previous.publicDecay, report.acceptedAt, decayPolicy, season!.startsAt) : { rating: previous.publicRating, state: null, delta: 0 }
            const transition = calculatePublicRatingTransition({ formulaVersion: formula, priorRating: decay.rating,
              hiddenMuBefore: event.ratingBeforeMu, hiddenMuAfterRaw: rawAfterMu, hiddenSigmaBefore: event.ratingBeforeSigma,
              targetRating: publicRatingTarget(summary.mu - 0.75 * summary.sigma, calibration), sourceWeight: match.isOld ? 0.5 : 1,
            })
            const publicDecay = decayPolicy ? recordPublicRatingDecayGame(transition.after, decay.state, report.acceptedAt, decayPolicy, !match.isOld) : null
            ratings.set(key(summary), { ...summary, publicRating: transition.after, publicBadge: advancePublicRatingBadge(decay.rating, transition.after, previous.publicBadge), publicDecay, seasonGames: previous.seasonGames + 1, seasonWins: previous.seasonWins + (event.winsDelta ?? 0) })
            checkpoints.push({ matchId: match.id, summary: ratings.get(key(summary))! })
            rebuilt.push({ ...event, seasonId, publicSequence: report.sequence, publicRatingBefore: transition.before, publicRatingAfter: transition.after,
              publicFormulaVersion: formula, publicCalibrationVersion: version,
              publicDecayBefore: decay.state, publicDecayAfter: publicDecay, publicDecayDelta: decay.delta,
            })
          },
        })
        if (typeof result === 'string') throw new Error(result)
      }
    }
    return { ratings, rebuilt, checkpoints }
  }

  const control = calculate()
  if (control.rebuilt.length !== events.length || control.rebuilt.some(event => {
    const old = originalEvents.get(eventKey(event))
    const changed = old ? eventFields.filter(field => floatingReplayFields.has(field)
      ? !sameReplayNumber(event[field] as number | null, old[field] as number | null)
      : storedEventValue(event[field]) !== storedEventValue(old[field])) : []
    if (changed.length) console.error('[season-replay] recorded event mismatch', { matchId: event.matchId, playerId: event.playerId, mode: event.mode,
      fields: changed.map(field => ({ field, saved: storedEventValue(old![field]), replayed: storedEventValue(event[field]) })) })
    return !old || changed.length > 0
  })) throw new Error('No-op season replay did not reproduce the recorded events. No writes were prepared.')
  if (states.length !== control.ratings.size || states.some(state => {
    const rating = control.ratings.get(key(state))
    return !rating || !sameReplayNumber(state.mu, rating.mu) || !sameReplayNumber(state.sigma, rating.sigma) || !sameReplayNumber(state.publicRating, rating.publicRating)
      || state.publicBadge !== rating.publicBadge || !samePublicRatingDecay(state.publicDecay, rating.publicDecay) || state.seasonGames !== rating.seasonGames || state.seasonWins !== rating.seasonWins
      || state.lastPlayedAt !== rating.lastPlayedAt
      || evidenceKeys.some(field => (state.evidence[field] ?? 0) !== rating[field])
  })) throw new Error('No-op season replay did not reproduce current summaries. No writes were prepared.')
  if (states.some(state => {
    const live = liveRows.find(row => key(row) === key(state))
    return !live || live.mu !== state.mu || live.sigma !== state.sigma || live.publicRating !== state.publicRating || live.publicBadge !== state.publicBadge || !samePublicRatingDecay(live.publicDecay, state.publicDecay) || live.lastPlayedAt !== state.lastPlayedAt || evidenceKeys.some(field => live[field] !== (state.evidence[field] ?? 0))
  })) throw new Error('Live and season summaries disagree. No writes were prepared.')
  const addedSeeds: Array<typeof publicRatingSeeds.$inferSelect> = []
  if (change?.participants) {
    const match = storedMatches.find(row => row.id === change.matchId)!
    const context = getStoredGameModeContext(match.gameMode, match.draftData)
    if (!context?.leaderboardMode) throw new Error('The corrected match has no ranked scope.')
    const report = reports.find(row => row.matchId === change.matchId)!
    for (const participant of change.participants) {
      for (const scope of [context.leaderboardMode, 'global']) {
        if (seeds.some(seed => seed.playerId === participant.playerId && seed.mode === scope)) continue
        if (liveRows.some(row => row.playerId === participant.playerId && row.mode === scope)) throw new Error('An existing substitute rating has no opening seed; owner review is required.')
        const original = events.find(event => event.matchId === match.id && event.mode === scope)
        if (!original?.publicCalibrationVersion || !original.publicFormulaVersion) throw new Error('The original report version is missing.')
        const fresh = createRating(participant.playerId)
        const seed = { seasonId, playerId: participant.playerId, mode: scope, rating: PUBLIC_RATING_START,
          hiddenMu: fresh.mu, hiddenSigma: fresh.sigma, sourceMu: fresh.mu, sourceSigma: fresh.sigma,
          sourceHiddenScore: fresh.mu - 0.75 * fresh.sigma, effectiveAt: report.acceptedAt, lastPlayedAt: null, sourceSeasonId: null,
          formulaVersion: original.publicFormulaVersion, calibrationVersion: original.publicCalibrationVersion,
          seedVersion: 'new-player-v1', closingTier: null, guardReason: null, evidence: {},
        }
        addedSeeds.push(seed)
        seeds.push(seed)
      }
    }
  }
  const output = change ? calculate(change) : control
  const queries: DbBatchItem[] = [
    seasonSourceGuard(db, sql`exists(select 1 from ${seasons} where ${seasons.id} = ${seasonId} and ${seasons.active} = 1 and ${seasons.endsAt} is null and ${seasons.finalizedAt} is null and ${seasons.isolatedRatingsEnabled} = 1)`),
    seasonSourceGuard(db, sql`(select count(*) from ${seasonMatchReports} where ${reportScope}) = ${reports.length}
      and (select max(${seasonMatchReports.sequence}) from ${seasonMatchReports} where ${reportScope}) = ${reports.at(-1)!.sequence}`),
  ]
  if (decayPolicy) queries.push(seasonSourceGuard(db, sql`exists(select 1 from public_rating_decay_policies where version=${decayPolicy.version} and enabled_at=${decayPolicy.enabledAt})`))
  for (const match of storedMatches) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${matches} where ${matches.id} = ${match.id}
    and ${matches.status} = ${match.status} and ${matches.seasonId} = ${seasonId} and ${matches.draftData} is ${match.draftData}
    and ${matches.createdAt} = ${match.createdAt} and ${matches.gameMode} = ${match.gameMode} and ${matches.isOld} = ${match.isOld})
    and (select count(*) from ${matchParticipants} where ${matchParticipants.matchId} = ${match.id}) = ${participants.filter(row => row.matchId === match.id).length}`))
  for (const row of participants) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${matchParticipants} where ${matchParticipants.matchId} = ${row.matchId}
    and ${matchParticipants.playerId} = ${row.playerId} and ${matchParticipants.team} is ${row.team}
    and ${matchParticipants.placement} is ${row.placement} and ${matchParticipants.civId} is ${row.civId})`))
  for (const report of reports) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${seasonMatchReports} where ${seasonMatchReports.matchId} = ${report.matchId}
    and ${seasonMatchReports.sequence} = ${report.sequence} and ${seasonMatchReports.acceptedAt} = ${report.acceptedAt}
    and ${seasonMatchReports.cancelledAt} is ${report.cancelledAt} and ${seasonMatchReports.opponentTiers} = ${JSON.stringify(report.opponentTiers)})`))
  for (const state of states) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${seasonRatingStates} where ${seasonRatingStates.seasonId} = ${seasonId}
    and ${seasonRatingStates.playerId} = ${state.playerId} and ${seasonRatingStates.mode} = ${state.mode}
    and ${seasonRatingStates.revision} = ${state.revision} and ${seasonRatingStates.mu} = ${state.mu} and ${seasonRatingStates.sigma} = ${state.sigma}
    and ${seasonRatingStates.publicRating} is ${state.publicRating} and ${seasonRatingStates.publicBadge} is ${state.publicBadge} and ${seasonRatingStates.publicDecay} is ${storedEventValue(state.publicDecay)} and ${seasonRatingStates.evidence} = ${JSON.stringify(state.evidence)}
    and ${seasonRatingStates.seasonGames} = ${state.seasonGames} and ${seasonRatingStates.seasonWins} = ${state.seasonWins}
    and ${seasonRatingStates.lastPlayedAt} is ${state.lastPlayedAt})`))
  for (const live of liveRows.filter(row => states.some(state => key(state) === key(row)))) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${playerRatings}
    where ${playerRatings.playerId} = ${live.playerId} and ${playerRatings.mode} = ${live.mode}
    and ${playerRatings.mu} = ${live.mu} and ${playerRatings.sigma} = ${live.sigma} and ${playerRatings.publicRating} is ${live.publicRating}
    and ${playerRatings.publicBadge} is ${live.publicBadge} and ${playerRatings.publicDecay} is ${storedEventValue(live.publicDecay)}
    and ${playerRatings.updatedAt} is ${live.updatedAt} and ${playerRatings.lastPlayedAt} is ${live.lastPlayedAt}
    and ${and(...evidenceKeys.map(field => sql`${playerRatings[field]} = ${live[field]}`))})`))
  for (let offset = 0; offset < prefix.length; offset += 50) {
    const expected = JSON.stringify(prefix.slice(offset, offset + 50).map(event => ({
      matchId: event.matchId, playerId: event.playerId, mode: event.mode, acceptedAt: event.acceptedAt, checkpoint: event.checkpoint,
      ...Object.fromEntries(eventFields.map(field => [field, storedEventValue(event[field])])),
    })))
    const changed = eventFields.map(field => sql`${playerRatingEvents[field]} IS NOT json_extract(expected.value, ${`$.${field}`})`)
    queries.push(seasonSourceGuard(db, sql`NOT EXISTS(SELECT 1 FROM json_each(${expected}) expected
      LEFT JOIN ${playerRatingEvents} ON ${playerRatingEvents.matchId} = json_extract(expected.value, '$.matchId')
        AND ${playerRatingEvents.playerId} = json_extract(expected.value, '$.playerId') AND ${playerRatingEvents.mode} = json_extract(expected.value, '$.mode')
      LEFT JOIN ${seasonMatchReports} ON ${seasonMatchReports.matchId} = ${playerRatingEvents.matchId}
      LEFT JOIN ${seasonRatingCheckpoints} ON ${seasonRatingCheckpoints.seasonId} = ${playerRatingEvents.seasonId}
        AND ${seasonRatingCheckpoints.playerId} = ${playerRatingEvents.playerId} AND ${seasonRatingCheckpoints.mode} = ${playerRatingEvents.mode}
        AND ${seasonRatingCheckpoints.sequence} = ${playerRatingEvents.publicSequence}
      WHERE ${playerRatingEvents.matchId} IS NULL OR ${playerRatingEvents.seasonId} IS NOT ${seasonId}
        OR ${seasonMatchReports.seasonId} IS NOT ${seasonId} OR ${seasonMatchReports.cancelledAt} IS NOT NULL
        OR ${seasonMatchReports.sequence} IS NOT ${playerRatingEvents.publicSequence}
         OR ${seasonMatchReports.acceptedAt} IS NOT json_extract(expected.value, '$.acceptedAt')
          OR NOT ${checkpointReady} OR ${seasonRatingCheckpoints.summary} IS NOT json_extract(expected.value, '$.checkpoint') OR ${sql.join(changed, sql` OR `)})`))
  }
  queries.push(seasonSourceGuard(db, sql`(select count(*) from ${playerRatingEvents} where ${inArray(playerRatingEvents.matchId, ids)}) = ${events.length}`))
  for (const event of events) queries.push(seasonSourceGuard(db, sql`exists(select 1 from ${playerRatingEvents} where ${playerRatingEvents.matchId} = ${event.matchId}
    and ${playerRatingEvents.playerId} = ${event.playerId} and ${playerRatingEvents.mode} = ${event.mode}
    and ${and(...eventFields.map(field => sql`${playerRatingEvents[field]} is ${storedEventValue(event[field])}`))})`))
  for (const seed of addedSeeds) {
    queries.push(seasonSourceGuard(db, sql`not exists(select 1 from ${playerRatings} where ${playerRatings.playerId} = ${seed.playerId} and ${playerRatings.mode} = ${seed.mode})`))
    queries.push(db.insert(publicRatingSeeds).values(seed))
  }
  if (change?.participants) {
    queries.push(db.delete(matchParticipants).where(eq(matchParticipants.matchId, change.matchId)))
    for (const participant of change.participants) queries.push(db.insert(matchParticipants).values(participant))
  }
  queries.push(db.delete(playerRatingEvents).where(inArray(playerRatingEvents.matchId, ids)))
  queries.push(db.delete(seasonRatingCheckpoints).where(and(eq(seasonRatingCheckpoints.seasonId, seasonId), inArray(seasonRatingCheckpoints.sequence, reports.map(report => report.sequence)))))
  for (let offset = 0; offset < output.checkpoints.length; offset += 50) {
    queries.push(writeRatingCheckpoints(db, seasonId, output.checkpoints.slice(offset, offset + 50)))
  }
  for (const event of output.rebuilt) {
    queries.push(db.insert(playerRatingEvents).values({ ...event, updatedAt: now }))
    if (event.mode !== 'global') queries.push(db.update(matchParticipants).set({ ratingBeforeMu: event.ratingBeforeMu, ratingBeforeSigma: event.ratingBeforeSigma,
      ratingAfterMu: event.ratingAfterMu, ratingAfterSigma: event.ratingAfterSigma,
    }).where(and(eq(matchParticipants.matchId, event.matchId), eq(matchParticipants.playerId, event.playerId))))
  }
  for (const rating of output.ratings.values()) {
    const previous = states.find(state => key(state) === key(rating))
    const { seasonGames, seasonWins, ...summary } = rating
    const state = { seasonId, playerId: rating.playerId, mode: rating.mode, mu: rating.mu, sigma: rating.sigma, publicRating: rating.publicRating, publicBadge: rating.publicBadge, publicDecay: rating.publicDecay, seasonGames, seasonWins,
      evidence: Object.fromEntries(evidenceKeys.map(field => [field, rating[field]])), lastPlayedAt: rating.lastPlayedAt, revision: (previous?.revision ?? 0) + 1, updatedAt: now,
    }
    queries.push(db.insert(seasonRatingStates).values(state).onConflictDoUpdate({ target: [seasonRatingStates.seasonId, seasonRatingStates.playerId, seasonRatingStates.mode], set: state }))
    queries.push(db.insert(playerRatings).values(summary).onConflictDoUpdate({ target: [playerRatings.playerId, playerRatings.mode], set: summary }))
  }
  if (change?.cancel) {
    queries.push(db.update(seasonMatchReports).set({ cancelledAt: now }).where(eq(seasonMatchReports.matchId, change.matchId)))
    queries.push(db.update(matchParticipants).set({ placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null }).where(eq(matchParticipants.matchId, change.matchId)))
  }
  if (change?.restore) queries.push(db.update(seasonMatchReports).set({ cancelledAt: null }).where(eq(seasonMatchReports.matchId, change.matchId)))
  const division = await prepareAtomicDivisionUpdates(db, { seasonId, now, ratings: [...output.ratings.values()], replacedMatchIds: ids,
    events: output.rebuilt.map(event => ({ playerId: event.playerId, matchId: event.matchId, mode: event.mode,
      at: reports.find(report => report.matchId === event.matchId)!.acceptedAt, effectiveGamesDelta: event.effectiveGamesDelta ?? 0,
      effectiveWinsVsTier1Delta: event.effectiveWinsVsTier1Delta ?? 0, effectiveWinsVsTier2PlusDelta: event.effectiveWinsVsTier2PlusDelta ?? 0 })) })
  queries.unshift(...division.guards)
  queries.push(...division.updates)
  return { queries, matchIds: ids }
}

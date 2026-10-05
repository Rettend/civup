import type { StoredRatingSummaryRow } from '../match/report.ts'
import type { Database } from '@civup/db'
import type { PublicRatingDecayState } from '@civup/rating'
import { and, eq, gt, sql } from 'drizzle-orm'
import {
  playerRatingEvents,
  publicRatingSeeds,
  seasonCheckpointInitializations,
  seasonMatchReports,
  seasonRatingCheckpoints,
  seasonRatingStates,
  seasons,
} from '@civup/db'
import { advancePublicRatingBadge, recordPublicRatingDecayGame, settlePublicRatingDecay } from '@civup/rating'
import { loadPublicRatingDecayPolicy, samePublicRatingDecay } from './decay.ts'
import { sameReplayNumber } from './replay-number.ts'
import { runAtomicSeasonBatch, seasonSourceGuard } from './report.ts'

export type RatingCheckpoint = StoredRatingSummaryRow & {
  publicRating: number
  publicBadge: number | null
  publicDecay: PublicRatingDecayState | null
  seasonGames: number
  seasonWins: number
}

const deltas = {
  gamesPlayed: 'gamesDelta',
  wins: 'winsDelta',
  importedGames: 'importedGamesDelta',
  effectiveGames: 'effectiveGamesDelta',
  winsVsTier1: 'winsVsTier1Delta',
  winsVsTier2Plus: 'winsVsTier2PlusDelta',
  effectiveWinsVsTier1: 'effectiveWinsVsTier1Delta',
  effectiveWinsVsTier2Plus: 'effectiveWinsVsTier2PlusDelta',
} as const

/** Resumable migration of recorded events, with reporting paused; does not recalculate ratings. */
export async function initializeSeasonCheckpointPage(
  db: Database,
  seasonId: string,
  playerId: string,
  mode: RatingCheckpoint['mode'],
  generation: number,
) {
  const scope = and(
    eq(seasonCheckpointInitializations.seasonId, seasonId),
    eq(seasonCheckpointInitializations.playerId, playerId),
    eq(seasonCheckpointInitializations.mode, mode),
  )
  const [latest] = await db.select().from(seasonCheckpointInitializations).where(scope).limit(1)
  const [seed] = await db
    .select()
    .from(publicRatingSeeds)
    .where(
      and(
        eq(publicRatingSeeds.seasonId, seasonId),
        eq(publicRatingSeeds.playerId, playerId),
        eq(publicRatingSeeds.mode, mode),
      ),
    )
    .limit(1)
  const [state] = await db
    .select()
    .from(seasonRatingStates)
    .where(
      and(
        eq(seasonRatingStates.seasonId, seasonId),
        eq(seasonRatingStates.playerId, playerId),
        eq(seasonRatingStates.mode, mode),
      ),
    )
    .limit(1)
  const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId)).limit(1)
  if (!seed || !state || !season || season.ratingSystem !== 'rp')
    throw new Error('The checkpoint chain has no complete frozen source.')
  if (latest && latest.sourceRevision !== state.revision) {
    await runAtomicSeasonBatch(db, [
      seasonSourceGuard(
        db,
        sql`exists(select 1 from rating_maintenance where state='paused' and generation=${generation}) and not exists(select 1 from rating_mutation_leases)
      and exists(select 1 from season_rating_states where season_id=${seasonId} and player_id=${playerId} and mode=${mode} and revision=${state.revision})
      and exists(select 1 from season_checkpoint_initializations where season_id=${seasonId} and player_id=${playerId} and mode=${mode} and source_revision=${latest.sourceRevision} and sequence=${latest.sequence})`,
      ),
      db.delete(seasonCheckpointInitializations).where(scope),
    ])
    return false
  }
  if (latest?.complete) return true
  let summary: RatingCheckpoint = latest
    ? JSON.parse(latest.summary)
    : {
        playerId,
        mode,
        mu: seed.hiddenMu,
        sigma: seed.hiddenSigma,
        ...(Object.fromEntries(Object.keys(deltas).map(key => [key, seed.evidence[key] ?? 0])) as Pick<
          RatingCheckpoint,
          keyof typeof deltas
        >),
        publicRating: seed.rating,
        publicBadge: null,
        publicDecay: null,
        seasonGames: 0,
        seasonWins: 0,
        lastPlayedAt: seed.lastPlayedAt,
        updatedAt: seed.effectiveAt,
      }
  const events = await db
    .select({
      event: playerRatingEvents,
      acceptedAt: seasonMatchReports.acceptedAt,
      cancelledAt: seasonMatchReports.cancelledAt,
    })
    .from(playerRatingEvents)
    .innerJoin(
      seasonMatchReports,
      and(
        eq(seasonMatchReports.matchId, playerRatingEvents.matchId),
        eq(seasonMatchReports.sequence, playerRatingEvents.publicSequence),
        eq(seasonMatchReports.seasonId, seasonId),
      ),
    )
    .where(
      and(
        eq(playerRatingEvents.seasonId, seasonId),
        eq(playerRatingEvents.playerId, playerId),
        eq(playerRatingEvents.mode, mode),
        gt(playerRatingEvents.publicSequence, latest?.sequence ?? 0),
      ),
    )
    .orderBy(playerRatingEvents.publicSequence)
    .limit(40)
  const policy = await loadPublicRatingDecayPolicy(db)
  const snapshots: Array<{ matchId: string; summary: RatingCheckpoint }> = []
  for (const { event, acceptedAt, cancelledAt } of events) {
    const decay = policy
      ? settlePublicRatingDecay(summary.publicRating, summary.publicDecay, acceptedAt, policy, season.startsAt)
      : { rating: summary.publicRating, state: null, delta: 0 }
    if (
      cancelledAt != null ||
      event.publicRatingAfter == null ||
      !Number.isFinite(event.publicRatingAfter) ||
      !event.publicFormulaVersion ||
      !event.publicCalibrationVersion ||
      !Number.isSafeInteger(acceptedAt) ||
      acceptedAt < 0 ||
      !sameReplayNumber(event.ratingBeforeMu, summary.mu) ||
      !sameReplayNumber(event.ratingBeforeSigma, summary.sigma) ||
      !sameReplayNumber(event.publicRatingBefore, decay.rating) ||
      !sameReplayNumber(event.publicDecayDelta, decay.delta) ||
      !samePublicRatingDecay(event.publicDecayBefore, decay.state)
    )
      throw new Error('Recorded checkpoint events do not connect to their source.')
    summary = {
      ...summary,
      mu: event.ratingAfterMu,
      sigma: event.ratingAfterSigma,
      publicRating: event.publicRatingAfter,
      publicBadge: advancePublicRatingBadge(decay.rating, event.publicRatingAfter, summary.publicBadge),
      publicDecay: policy
        ? recordPublicRatingDecayGame(
            event.publicRatingAfter,
            decay.state,
            acceptedAt,
            policy,
            event.importedGamesDelta === 0,
          )
        : null,
      ...Object.fromEntries(
        Object.entries(deltas).map(([key, delta]) => [key, summary[key as keyof typeof deltas] + event[delta]]),
      ),
      seasonGames: summary.seasonGames + event.gamesDelta,
      seasonWins: summary.seasonWins + event.winsDelta,
      lastPlayedAt: event.importedGamesDelta ? summary.lastPlayedAt : Math.max(summary.lastPlayedAt ?? 0, acceptedAt),
      updatedAt: acceptedAt,
    }
    if (!samePublicRatingDecay(summary.publicDecay, event.publicDecayAfter))
      throw new Error('Recorded checkpoint activity reserve changed.')
    snapshots.push({ matchId: event.matchId, summary })
  }
  const complete = events.length < 40
  if (
    complete &&
    (!sameReplayNumber(summary.mu, state.mu) ||
      !sameReplayNumber(summary.sigma, state.sigma) ||
      !sameReplayNumber(summary.publicRating, state.publicRating) ||
      summary.publicBadge !== state.publicBadge ||
      summary.seasonGames !== state.seasonGames ||
      summary.seasonWins !== state.seasonWins ||
      summary.lastPlayedAt !== state.lastPlayedAt ||
      !samePublicRatingDecay(summary.publicDecay, state.publicDecay) ||
      Object.keys(deltas).some(key => summary[key as keyof typeof deltas] !== (state.evidence[key] ?? 0)))
  )
    throw new Error('Checkpoint initialization does not reproduce the saved season summary.')
  await runAtomicSeasonBatch(db, [
    seasonSourceGuard(
      db,
      sql`exists(select 1 from rating_maintenance where state='paused' and generation=${generation}) and not exists(select 1 from rating_mutation_leases)
    and exists(select 1 from season_rating_states where season_id=${seasonId} and player_id=${playerId} and mode=${mode} and revision=${state.revision})
    and (select sequence from season_checkpoint_initializations where season_id=${seasonId} and player_id=${playerId} and mode=${mode}) is ${latest?.sequence ?? null}`,
    ),
    ...(snapshots.length ? [writeRatingCheckpoints(db, seasonId, snapshots, true)] : []),
    db
      .insert(seasonCheckpointInitializations)
      .values({
        seasonId,
        playerId,
        mode,
        sequence: events.at(-1)?.event.publicSequence ?? latest?.sequence ?? 0,
        summary: JSON.stringify(summary),
        sourceRevision: state.revision,
        complete,
      })
      .onConflictDoUpdate({
        target: [
          seasonCheckpointInitializations.seasonId,
          seasonCheckpointInitializations.playerId,
          seasonCheckpointInitializations.mode,
        ],
        set: {
          sequence: events.at(-1)?.event.publicSequence ?? latest?.sequence ?? 0,
          summary: JSON.stringify(summary),
          complete,
        },
      }),
  ])
  return complete
}

export function writeRatingCheckpoints(
  db: Database,
  seasonId: string,
  rows: Array<{ matchId: string; summary: RatingCheckpoint }>,
  fromHistory = false,
) {
  return db
    .insert(seasonRatingCheckpoints)
    .select(
      db
        .select({
          seasonId: sql<string>`${seasonId}`.as('season_id'),
          playerId: sql<string>`json_extract(value, '$.summary.playerId')`.as('player_id'),
          mode: sql<string>`json_extract(value, '$.summary.mode')`.as('mode'),
          sequence:
            sql<number>`(select sequence from season_match_reports where match_id=json_extract(value, '$.matchId') and season_id=${seasonId})`.as(
              'sequence',
            ),
          matchId: sql<string>`json_extract(value, '$.matchId')`.as('match_id'),
          summary: sql<string>`json_extract(value, '$.summary')`.as('summary'),
          version: sql<number>`1`.as('version'),
          fromHistory: sql<boolean>`${fromHistory ? 1 : 0}`.as('from_history'),
        })
        .from(sql`json_each(${JSON.stringify(rows)})`)
        .where(sql`true`),
    )
    .onConflictDoUpdate({
      target: [
        seasonRatingCheckpoints.seasonId,
        seasonRatingCheckpoints.sequence,
        seasonRatingCheckpoints.playerId,
        seasonRatingCheckpoints.mode,
      ],
      set: {
        matchId: sql`excluded.match_id`,
        summary: sql`excluded.summary`,
        version: 1,
        fromHistory: sql`excluded.from_history`,
      },
    })
}

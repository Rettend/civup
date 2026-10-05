import type { DbBatchItem } from '../db/batch.ts'
import type { Database } from '@civup/db'
import type { PublicRatingDecayState, RecentQualityEvidence, OverallModeStanding } from '@civup/rating'
import { and, eq, sql } from 'drizzle-orm'
import {
  divisionRankPolicies,
  divisionRankSources,
  divisionRankStates,
  divisionQualityCredits,
  divisionQualityDirty,
  matches,
  playerRatingEvents,
  playerRatings,
  seasonMatchReports,
  seasonPeakDivisionRanks,
  seasonPeakRanks,
} from '@civup/db'
import {
  addQualityResult,
  ageQualityEvidence,
  nextOverallRankChangeAt,
  nextPublicRatingDisplayChangeAt,
  ONE_DIVISION_RANK_POLICY_VERSION,
  resolveOverallRank,
} from '@civup/rating'
import { inJson as inArray } from '../db/in-json.ts'
import { projectPublicRatingDecay } from '../season/decay.ts'
import { seasonSourceGuard } from '../season/report.ts'
import { markDivisionDelivery } from './division-delivery.ts'
import { prepareQualityCheckpoint } from './quality-checkpoint.ts'

export interface DivisionRatingInput {
  playerId: string
  mode: string
  publicRating: number | null
  publicBadge?: number | null
  publicDecay?: PublicRatingDecayState | null
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
}
export interface DivisionEventInput {
  playerId: string
  matchId: string
  mode: string
  at: number
  effectiveGamesDelta: number
  effectiveWinsVsTier2PlusDelta: number
  effectiveWinsVsTier1Delta: number
}

const normalize = (event: DivisionEventInput) => ({
  playerId: event.playerId,
  matchId: event.matchId,
  ...addQualityResult(
    { at: 0, effectiveGames: 0, highRankWins: 0, eliteWins: 0 },
    {
      at: event.at,
      effectiveGames: event.effectiveGamesDelta,
      highRankWins: event.effectiveWinsVsTier2PlusDelta,
      eliteWins: event.effectiveWinsVsTier1Delta,
    },
  ),
})

/** Guards precede rating writes; updates follow them in the SAME D1 batch. No external writes. */
export async function prepareAtomicDivisionUpdates(
  db: Database,
  input: {
    seasonId: string
    now: number
    ratings: DivisionRatingInput[]
    events: DivisionEventInput[]
    replacedMatchIds: string[]
  },
): Promise<{ guards: DbBatchItem[]; updates: DbBatchItem[] }> {
  const policies = await db
    .select()
    .from(divisionRankPolicies)
    .where(and(eq(divisionRankPolicies.seasonId, input.seasonId), eq(divisionRankPolicies.phase, 'active')))
  if (!policies.length || !input.ratings.length) return { guards: [], updates: [] }
  const ids = [...new Set(input.ratings.map(row => row.playerId))]
  const [live, sources, oldEvents] = await Promise.all([
    db.select().from(playerRatings).where(inArray(playerRatings.playerId, ids)),
    db.select().from(divisionRankSources).where(inArray(divisionRankSources.playerId, ids)),
    db
      .select({
        playerId: playerRatingEvents.playerId,
        matchId: playerRatingEvents.matchId,
        mode: playerRatingEvents.mode,
        at: sql<number>`coalesce(${seasonMatchReports.acceptedAt}, ${playerRatingEvents.matchCompletedAt})`,
        effectiveGamesDelta: playerRatingEvents.effectiveGamesDelta,
        effectiveWinsVsTier2PlusDelta: playerRatingEvents.effectiveWinsVsTier2PlusDelta,
        effectiveWinsVsTier1Delta: playerRatingEvents.effectiveWinsVsTier1Delta,
      })
      .from(playerRatingEvents)
      .innerJoin(matches, eq(matches.id, playerRatingEvents.matchId))
      .leftJoin(seasonMatchReports, eq(seasonMatchReports.matchId, playerRatingEvents.matchId))
      .where(
        and(
          inArray(playerRatingEvents.matchId, input.replacedMatchIds),
          eq(playerRatingEvents.mode, 'global'),
          eq(matches.status, 'completed'),
        ),
      ),
  ])
  const overlays = new Map(input.ratings.map(row => [`${row.playerId}:${row.mode}`, row]))
  const combined: DivisionRatingInput[] = live.map(row => overlays.get(`${row.playerId}:${row.mode}`) ?? row)
  for (const row of input.ratings)
    if (!live.some(old => old.playerId === row.playerId && old.mode === row.mode)) combined.push(row)
  const projected = await projectPublicRatingDecay(db, combined, input.now)
  const guards: DbBatchItem[] = [],
    updates: DbBatchItem[] = []
  // Guard all other-mode inputs too, including missing rows, against concurrent reports.
  const expected = JSON.stringify(
    live.map(row => ({
      playerId: row.playerId,
      mode: row.mode,
      rating: row.publicRating,
      badge: row.publicBadge,
      decay: row.publicDecay ? JSON.stringify(row.publicDecay) : null,
      games: row.effectiveGames,
      top: row.winsVsTier1,
      high: row.winsVsTier2Plus,
    })),
  )
  guards.push(
    seasonSourceGuard(
      db,
      sql`(select count(*) from player_ratings where player_id in (select value from json_each(${JSON.stringify(ids)}))) = ${live.length}
    and not exists(select 1 from json_each(${expected}) e left join player_ratings r on r.player_id=json_extract(e.value,'$.playerId') and r.mode=json_extract(e.value,'$.mode')
    where r.player_id is null or r.public_rating is not json_extract(e.value,'$.rating') or r.public_badge is not json_extract(e.value,'$.badge')
      or r.public_decay is not json_extract(e.value,'$.decay') or r.effective_games is not json_extract(e.value,'$.games')
      or r.wins_vs_tier_1 is not json_extract(e.value,'$.top') or r.wins_vs_tier_2_plus is not json_extract(e.value,'$.high'))`,
    ),
  )
  for (const policy of policies) {
    const stored = JSON.parse(policy.configJson) as {
      preparation: { roleIdsByMinimum: Record<string, string>; unrankedRoleId: string }
    }
    const states = await db
      .select()
      .from(divisionRankStates)
      .where(and(eq(divisionRankStates.guildId, policy.guildId), inArray(divisionRankStates.playerId, ids)))
    guards.push(
      seasonSourceGuard(
        db,
        sql`exists(select 1 from division_rank_policies where guild_id=${policy.guildId} and version=${policy.version} and phase='active' and config_json=${policy.configJson})`,
      ),
    )
    for (const id of ids) {
      const state = states.find(row => row.playerId === id)
      const previous = state?.resultJson
        ? (JSON.parse(state.resultJson) as ReturnType<typeof resolveOverallRank>)
        : null
      const revision = sources.find(row => row.playerId === id)?.revision ?? 0
      guards.push(
        seasonSourceGuard(
          db,
          sql`coalesce((select revision from division_rank_sources where player_id=${id}),0)=${revision}
        and (select result_json from division_rank_states where guild_id=${policy.guildId} and player_id=${id}) is ${state?.resultJson ?? null}`,
        ),
      )
      const checkpoint =
        previous?.recent && state?.sourceRevision === revision
          ? { recent: ageQualityEvidence(previous.recent, input.now), queries: [], undatedMatchIds: [] }
          : await prepareQualityCheckpoint(db, policy.guildId, id, input.now, previous?.recent)
      if (checkpoint.undatedMatchIds.length) throw new Error('Overall quality evidence has an unverified report date.')
      const recent: RecentQualityEvidence = { ...checkpoint.recent }
      const incoming = input.events.filter(row => row.playerId === id && row.mode === 'global').map(normalize)
      for (const [sign, credits] of [
        [-1, oldEvents.filter(row => row.playerId === id).map(normalize)],
        [1, incoming],
      ] as const) {
        for (const credit of credits) {
          const aged = ageQualityEvidence(credit, input.now)
          for (const field of ['effectiveGames', 'highRankWins', 'eliteWins'] as const)
            recent[field] += sign * aged[field]
        }
      }
      for (const field of ['effectiveGames', 'highRankWins', 'eliteWins'] as const) {
        if (recent[field] < -1e-7) throw new Error('Overall quality ledger does not match its checkpoint.')
        recent[field] = Math.max(0, recent[field])
      }
      recent.highRankWins = Math.min(recent.highRankWins, recent.effectiveGames)
      recent.eliteWins = Math.min(recent.eliteWins, recent.highRankWins)
      const own = projected.filter(row => row.playerId === id),
        global = own.find(row => row.mode === 'global')
      const modes: OverallModeStanding[] = own.flatMap<OverallModeStanding>(row =>
        row.publicRating != null &&
        (row.mode === 'duel' || row.mode === 'duo' || row.mode === 'squad' || row.mode === 'ffa')
          ? [
              {
                mode: row.mode,
                rating: row.publicRating,
                effectiveGames: row.effectiveGames,
                heldMinimum: row.publicBadge,
              },
            ]
          : [],
      )
      const result = resolveOverallRank({
        policyVersion: ONE_DIVISION_RANK_POLICY_VERSION,
        modes,
        recent,
        now: input.now,
        lifetimeEliteWins: global?.winsVsTier1 ?? 0,
        lifetimeHighRankWins: global?.winsVsTier2Plus ?? 0,
        previous:
          previous?.qualityUplift && previous.band
            ? {
                policyVersion: previous.policyVersion,
                minimum: previous.band.minimum,
                qualityMinimum: previous.qualityMinimum,
              }
            : null,
      })
      if (result.overallRating != null) {
        const times = own
          .filter(row => row.mode !== 'global' && row.publicRating != null)
          .flatMap(row => nextPublicRatingDisplayChangeAt(row.publicRating!, row.publicDecay, input.now) ?? [])
        result.ratingChangeAt = times.length ? Math.min(...times) : null
      }
      const desiredRoleId = result.band
        ? stored.preparation.roleIdsByMinimum[result.band.minimum]
        : stored.preparation.unrankedRoleId
      if (!desiredRoleId) throw new Error('Overall division role mapping is incomplete.')
      updates.push(
        ...checkpoint.queries,
        db
          .delete(divisionQualityCredits)
          .where(
            and(
              eq(divisionQualityCredits.guildId, policy.guildId),
              eq(divisionQualityCredits.playerId, id),
              inArray(divisionQualityCredits.matchId, input.replacedMatchIds),
              incoming.length
                ? sql`${divisionQualityCredits.matchId} not in (select value from json_each(${JSON.stringify(incoming.map(credit => credit.matchId))}))`
                : undefined,
            ),
          ),
      )
      if (incoming.length)
        updates.push(
          db
            .insert(divisionQualityCredits)
            .select(
              db
                .select({
                  guildId: sql<string>`${policy.guildId}`.as('guild_id'),
                  playerId: sql<string>`${id}`.as('player_id'),
                  matchId: sql<string>`json_extract(value,'$.matchId')`.as('match_id'),
                  at: sql<number>`json_extract(value,'$.at')`.as('at'),
                  effectiveGames: sql<number>`json_extract(value,'$.effectiveGames')`.as('effective_games'),
                  highRankWins: sql<number>`json_extract(value,'$.highRankWins')`.as('high_rank_wins'),
                  eliteWins: sql<number>`json_extract(value,'$.eliteWins')`.as('elite_wins'),
                })
                .from(sql`json_each(${JSON.stringify(incoming)})`)
                .where(sql`true`),
            )
            .onConflictDoUpdate({
              target: [divisionQualityCredits.guildId, divisionQualityCredits.playerId, divisionQualityCredits.matchId],
              set: {
                at: sql`excluded.at`,
                effectiveGames: sql`excluded.effective_games`,
                highRankWins: sql`excluded.high_rank_wins`,
                eliteWins: sql`excluded.elite_wins`,
              },
              setWhere: sql`${divisionQualityCredits.at} is not excluded.at or ${divisionQualityCredits.effectiveGames} is not excluded.effective_games
          or ${divisionQualityCredits.highRankWins} is not excluded.high_rank_wins or ${divisionQualityCredits.eliteWins} is not excluded.elite_wins`,
            }),
        )
      updates.push(
        db
          .delete(divisionQualityDirty)
          .where(and(eq(divisionQualityDirty.guildId, policy.guildId), eq(divisionQualityDirty.playerId, id))),
        db
          .insert(divisionRankStates)
          .values({
            guildId: policy.guildId,
            playerId: id,
            sourceRevision: sql`coalesce((select revision from division_rank_sources where player_id=${id}),0)`,
            resultJson: JSON.stringify({ playerId: id, ...result }),
            nextCheckAt: nextOverallRankChangeAt(result),
            desiredRoleId,
            pending: state?.appliedRoleId !== desiredRoleId,
            projectionPending: true,
            appliedRoleId: state?.appliedRoleId ?? null,
          })
          .onConflictDoUpdate({
            target: [divisionRankStates.guildId, divisionRankStates.playerId],
            set: {
              sourceRevision: sql`coalesce((select revision from division_rank_sources where player_id=${id}),0)`,
              resultJson: JSON.stringify({ playerId: id, ...result }),
              nextCheckAt: nextOverallRankChangeAt(result),
              desiredRoleId,
              pending: sql`${divisionRankStates.appliedRoleId} is not ${desiredRoleId}`,
              projectionPending: true,
              retryAt: 0,
              lastError: null,
            },
          }),
      )
      if (result.band)
        updates.push(
          db
            .insert(seasonPeakDivisionRanks)
            .values({ seasonId: input.seasonId, playerId: id, minimum: result.band.minimum, achievedAt: input.now })
            .onConflictDoUpdate({
              target: [seasonPeakDivisionRanks.seasonId, seasonPeakDivisionRanks.playerId],
              set: { minimum: result.band.minimum, achievedAt: input.now },
              setWhere: sql`${seasonPeakDivisionRanks.minimum}<${result.band.minimum}`,
            }),
          db
            .insert(seasonPeakRanks)
            .values({
              seasonId: input.seasonId,
              playerId: id,
              tier: result.band.tier,
              sourceMode: result.sourceMode,
              achievedAt: input.now,
            })
            .onConflictDoUpdate({
              target: [seasonPeakRanks.seasonId, seasonPeakRanks.playerId],
              set: { tier: result.band.tier, sourceMode: result.sourceMode, achievedAt: input.now },
              setWhere: sql`cast(substr(${seasonPeakRanks.tier},5) as integer)>${Number(result.band.tier.slice(4))}`,
            }),
        )
    }
    updates.push(
      markDivisionDelivery(
        db
          .update(divisionRankPolicies)
          .set({ projectionRevision: sql`${divisionRankPolicies.projectionRevision}+1` })
          .where(eq(divisionRankPolicies.guildId, policy.guildId)),
        policy.guildId,
      ),
    )
  }
  return { guards, updates }
}

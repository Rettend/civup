import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb, playerRatings, ratingMaintenance, ratingMutationLeases, seasonPeakRanks, seasons } from '@civup/db'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { applyPendingRankedRoleDiscordChanges, buildGlobalLadderSnapshots, currentRankAssignmentsKey, normalizeRankedRoleAssignments, setCurrentRankAssignments, setRankedRoleDemotionCandidates } from '../services/ranked/role-sync.ts'
import { getRankedRoleConfig } from '../services/ranked/roles.ts'
import { releaseRatingMutation, withinRatingMutation } from '../services/season/maintenance.ts'
import { finalizeSeasonSnapshotRoles } from '../services/season/snapshot-roles.ts'
import { runAtomicSeasonBatch, seasonSourceGuard } from '../services/season/report.ts'
import { clearAllLeaderboardModeSnapshots, rebuildLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { LEADERBOARD_MODES } from '@civup/game'
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'

export function registerSeasonMaintenanceRoutes(app: Hono<Env>) {
  app.get('/api/activity/admin/season-maintenance', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    c.header('Cache-Control', 'no-store')
    const db = createDb(c.env.DB)
    const [state] = await db.select().from(ratingMaintenance).where(sql`${ratingMaintenance.state} = 'paused' AND NOT EXISTS(SELECT 1 FROM ${ratingMutationLeases})`)
    if (!state) return c.json({ error: 'Pause reporting and wait for admitted writers before capturing season metadata.' }, 409)
    const guildId = c.env.ALLOWED_DISCORD_GUILD_ID!
    const [assignments, config] = await Promise.all([
      c.env.KV.get(currentRankAssignmentsKey(guildId), 'json').then(normalizeRankedRoleAssignments),
      getRankedRoleConfig(c.env.KV, guildId),
    ])
    return c.json({ generation: state.generation, assignments, config })
  })

  app.post('/api/activity/admin/season-maintenance', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    const body = await c.req.json<{ action: string, seasonId: string, generation: number, afterPlayerId?: string }>().catch(() => null)
    if (!body || !['opening-roles', 'activate-reads', 'historical-roles'].includes(body.action) || !body.seasonId || !Number.isSafeInteger(body.generation)) return c.json({ error: 'Provide an action, season ID, and paused generation.' }, 400)
    const db = createDb(c.env.DB)
    const id = crypto.randomUUID()
    const [lease] = await db.insert(ratingMutationLeases).select(db.select({ id: sql<string>`${id}`.as('id'), matchId: sql<string>`'season-projections'`.as('match_id'), generation: ratingMaintenance.generation, createdAt: sql<number>`${Date.now()}`.as('created_at') })
      .from(ratingMaintenance).where(sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.state} = 'paused' AND ${ratingMaintenance.generation} = ${body.generation} AND NOT EXISTS(SELECT 1 FROM ${ratingMutationLeases})`)).returning()
    if (!lease) return c.json({ error: 'Maintenance changed or a writer is still running.' }, 409)
    let finished = false
    const outcome = { uncertain: false }
    try {
      const result = await withinRatingMutation(id, async () => {
        const [season] = await db.select().from(seasons).where(eq(seasons.id, body.seasonId))
        if (!season) return { error: 'Season not found.' }
        const guildId = c.env.ALLOWED_DISCORD_GUILD_ID!
        if (body.action === 'historical-roles') {
          if (season.finalizedAt == null || season.active) return { error: 'Finalize the closed season database state first.' }
          const rows = await db.select({ playerId: seasonPeakRanks.playerId }).from(seasonPeakRanks)
            .where(and(eq(seasonPeakRanks.seasonId, season.id), body.afterPlayerId ? gt(seasonPeakRanks.playerId, body.afterPlayerId) : undefined))
            .orderBy(asc(seasonPeakRanks.playerId)).limit(25)
          if (rows.length) await finalizeSeasonSnapshotRoles(db, c.env.KV, guildId, c.env.DISCORD_TOKEN, season, rows.map(row => row.playerId))
          return { ok: true, processed: rows.length, next: rows.length === 25 ? rows.at(-1)!.playerId : null }
        }
        if (!season.active || season.ratingSystem !== 'rp' || !season.isolatedRatingsEnabled) return { error: 'An isolated RP opening is required.' }
        await runAtomicSeasonBatch(db, [seasonSourceGuard(db, sql`NOT EXISTS(SELECT 1 FROM season_match_reports WHERE season_id = ${season.id})
          AND NOT EXISTS(SELECT 1 FROM season_rating_states WHERE season_id = ${season.id} AND revision != 0)
          AND NOT EXISTS(SELECT 1 FROM player_ratings p LEFT JOIN public_rating_seeds s ON s.season_id = ${season.id} AND s.player_id = p.player_id AND s.mode = p.mode WHERE s.player_id IS NULL OR s.hidden_mu != p.mu OR s.hidden_sigma != p.sigma OR s.rating IS NOT p.public_rating)` )])
        if (body.action === 'opening-roles') {
          if (season.publicReadsEnabled) return { error: 'Opening roles must be assigned before enabling public reads.' }
          const config = await getRankedRoleConfig(c.env.KV, guildId)
          if (config.tiers.length !== 5 || config.tiers.some(tier => !tier.roleId)) return { error: 'Configure all five broad rank roles first.' }
          const rows = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'global'))
          const earned = buildGlobalLadderSnapshots(rows.map(row => ({ ...row, publicRating: row.publicRating ?? undefined })), config, true).earn
          const previous = normalizeRankedRoleAssignments(await c.env.KV.get(currentRankAssignmentsKey(guildId), 'json'))
          if (Object.entries(previous.byPlayerId).some(([playerId, assignment]) => assignment.tier !== 'tier5' && !rows.some(row => row.playerId === playerId))) return { error: 'A ranked assignment has no frozen global opening rating. Review it before changing roles.' }
          await setCurrentRankAssignments(c.env.KV, guildId, { byPlayerId: { ...previous.byPlayerId, ...Object.fromEntries(rows.map(row => [row.playerId, {
            tier: earned.get(row.playerId)?.tier ?? 'tier5', sourceMode: null, appliedRoleId: previous.byPlayerId[row.playerId]?.appliedRoleId,
          }])) } })
          await setRankedRoleDemotionCandidates(c.env.KV, guildId, { byPlayerId: {} })
          const applied = await applyPendingRankedRoleDiscordChanges({ kv: c.env.KV, guildId, token: c.env.DISCORD_TOKEN, maxPlayers: 25 })
          if (applied.pendingChanges === 0) await c.env.KV.put(`season-opening:roles:${season.id}`, JSON.stringify({ generation: body.generation, config }))
          return { ok: true, ...applied }
        }
        const ready = await c.env.KV.get<{ generation: number, config: unknown }>(`season-opening:roles:${season.id}`, 'json')
        if (ready?.generation !== body.generation || JSON.stringify(ready.config) !== JSON.stringify(await getRankedRoleConfig(c.env.KV, guildId))) return { error: 'Finish and verify opening role assignments in this maintenance window first.' }
        const pending = await applyPendingRankedRoleDiscordChanges({ kv: c.env.KV, guildId, token: c.env.DISCORD_TOKEN, maxPlayers: 0 })
        if (pending.pendingChanges > 0) return { error: 'Finish opening role assignments before enabling reads.' }
        await db.update(seasons).set({ publicReadsEnabled: true }).where(eq(seasons.id, season.id))
        await clearAllLeaderboardModeSnapshots(c.env.KV)
        for (const mode of LEADERBOARD_MODES) await rebuildLeaderboardModeSnapshot(db, c.env.KV, mode)
        await markLeaderboardsDirty(db, `season-opening:${season.id}`, { civ: true, modes: [...LEADERBOARD_MODES] })
        return { ok: true, publicReadsEnabled: true }
      }, outcome)
      finished = true
      return c.json(result)
    }
    finally { if (finished && !outcome.uncertain) await releaseRatingMutation(db, id) }
  })
}

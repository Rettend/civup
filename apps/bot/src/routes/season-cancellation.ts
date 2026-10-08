import type { Env } from '../env.ts'
import type { Hono, MiddlewareHandler } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import {
  createDb,
  matches,
  matchParticipants,
  playerRatingEvents,
  ratingMaintenance,
  ratingMutationLeases,
  seasonMatchReports,
  seasons,
} from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { removeCivLeaderboardMatchContribution } from '../services/leaderboard/civ-snapshot.ts'
import { markLeaderboardsDirty } from '../services/leaderboard/message.ts'
import { removePlayerCivStatMatchContribution } from '../services/leaderboard/player-civ-stats.ts'
import { wakeDivisionDelivery } from '../services/ranked/division-delivery.ts'
import { markRankedRolesDirty } from '../services/ranked/role-sync.ts'
import { releaseRatingMutation } from '../services/season/maintenance.ts'
import { runSessionTerminalLifecycleCommand } from '../session-runtime/session-do-client.ts'
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'

const FINISH_PATH = '/api/activity/admin/season-cancellation/finish'
const RECOVER_FINISH_PATH = '/api/activity/admin/season-cancellation/recover-finish'
const CLEANUP_RECOVERY_MIN_AGE_MS = 15 * 60_000

interface CancellationRequest {
  operationId: string
  matchId: string
  expectedCancelledAt: number
  expectedGeneration: number
}

function parseCancellationRequest(value: unknown): CancellationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (
    typeof body.operationId !== 'string' ||
    body.operationId.trim().length === 0 ||
    body.operationId.length > 512 ||
    typeof body.matchId !== 'string' ||
    body.matchId.trim().length === 0 ||
    body.matchId.length > 256 ||
    typeof body.expectedCancelledAt !== 'number' ||
    !Number.isSafeInteger(body.expectedCancelledAt) ||
    body.expectedCancelledAt < 0 ||
    typeof body.expectedGeneration !== 'number' ||
    !Number.isSafeInteger(body.expectedGeneration) ||
    body.expectedGeneration < 0
  )
    return null
  return {
    operationId: body.operationId,
    matchId: body.matchId,
    expectedCancelledAt: body.expectedCancelledAt,
    expectedGeneration: body.expectedGeneration,
  }
}

function cancellationMaintenanceGuard(body: CancellationRequest, reviewedLeaseId?: string) {
  return sql`${ratingMaintenance.id} = 1 AND ${ratingMaintenance.state} = 'paused'
    AND ${ratingMaintenance.generation} = ${body.expectedGeneration}
    AND EXISTS(SELECT 1 FROM ${ratingMutationLeases}
      WHERE ${ratingMutationLeases.id} = ${body.operationId}
        AND ${ratingMutationLeases.matchId} = ${body.operationId}
        AND ${ratingMutationLeases.generation} = ${body.expectedGeneration}
        AND ${ratingMutationLeases.createdAt} = ${body.expectedCancelledAt})
    AND NOT EXISTS(SELECT 1 FROM ${ratingMutationLeases}
      WHERE ${ratingMutationLeases.id} <> ${body.operationId}
        ${reviewedLeaseId ? sql`AND ${ratingMutationLeases.id} <> ${reviewedLeaseId}` : sql``})`
}

function clearedCancellationRatingsGuard(matchId: string) {
  return sql`EXISTS(SELECT 1 FROM ${matchParticipants} WHERE ${matchParticipants.matchId} = ${matchId})
    AND NOT EXISTS(SELECT 1 FROM ${matchParticipants}
      WHERE ${matchParticipants.matchId} = ${matchId} AND (
        ${matchParticipants.placement} IS NOT NULL OR ${matchParticipants.ratingBeforeMu} IS NOT NULL
        OR ${matchParticipants.ratingBeforeSigma} IS NOT NULL OR ${matchParticipants.ratingAfterMu} IS NOT NULL
        OR ${matchParticipants.ratingAfterSigma} IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM ${playerRatingEvents} WHERE ${playerRatingEvents.matchId} = ${matchId})`
}

function savedCancellationGuard(body: CancellationRequest) {
  return sql`EXISTS(SELECT 1 FROM ${matches} m JOIN ${seasons} s ON s.id = m.season_id
    JOIN ${seasonMatchReports} r ON r.match_id = m.id AND r.season_id = s.id
    WHERE m.id = ${body.matchId} AND m.status IN ('completed', 'cancelled')
      AND s.active = 1 AND s.rating_system = 'rp' AND s.isolated_ratings_enabled = 1
      AND r.cancelled_at = ${body.expectedCancelledAt}
      AND ${body.operationId} = ${`season-cancellation:${body.expectedCancelledAt}:`} || s.id)`
}

/** Keep accepted cleanup alive if the admin client disconnects. */
const keepCancellationAlive: MiddlewareHandler<Env> = async (c, next) => {
  const context = c.executionCtx
  const task = next()
  context.waitUntil(task)
  await task
}

export function registerSeasonCancellationRoutes(app: Hono<Env>) {
  app.use(FINISH_PATH, keepCancellationAlive)
  app.use(RECOVER_FINISH_PATH, keepCancellationAlive)
  app.get(FINISH_PATH, c => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ version: 2 })
  })
  app.post(FINISH_PATH, async c => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    const body = parseCancellationRequest(await c.req.json<unknown>().catch(() => null))
    if (!body) return c.json({ error: 'Provide the cancellation details and match ID.' }, 400)

    const { operationId, matchId, expectedCancelledAt, expectedGeneration } = body
    const db = createDb(c.env.DB)
    const logContext = {
      operationId,
      matchId,
      expectedCancelledAt,
      expectedGeneration,
      adminUserId: auth.identity.userId,
    }
    let leaseId: string | null = null
    try {
      const maintenanceGuard = cancellationMaintenanceGuard(body)
      const [maintenance] = await db
        .select({ id: ratingMaintenance.id })
        .from(ratingMaintenance)
        .where(maintenanceGuard)
      if (!maintenance) {
        return c.json(
          {
            error:
              'Check the cancellation plan, reporting pause, and any unfinished rating changes before closing this match.',
          },
          409,
        )
      }

      const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
      if (!match) return c.json({ error: 'Match not found.' }, 404)
      if (match.status !== 'completed' && match.status !== 'cancelled')
        return c.json({ error: 'Only a completed or cancelled match can finish this cancellation.' }, 409)
      const [season] = match.seasonId
        ? await db.select().from(seasons).where(eq(seasons.id, match.seasonId)).limit(1)
        : []
      if (!season?.active || season.ratingSystem !== 'rp' || !season.isolatedRatingsEnabled)
        return c.json({ error: 'This cancellation cleanup is not available for this season.' }, 409)
      const [report] = await db
        .select()
        .from(seasonMatchReports)
        .where(eq(seasonMatchReports.matchId, matchId))
        .limit(1)
      if (!report || report.seasonId !== season.id || report.cancelledAt !== expectedCancelledAt)
        return c.json({ error: 'The saved rating cancellation does not match this cancellation time.' }, 409)
      if (operationId !== `season-cancellation:${expectedCancelledAt}:${report.seasonId}`)
        return c.json({ error: 'The cancellation plan does not match this match’s saved cancellation.' }, 409)

      const clearedRatings = clearedCancellationRatingsGuard(matchId)
      const [cleared] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.id, matchId), clearedRatings))
      if (!cleared) return c.json({ error: 'Finish cancelling this match’s ratings before closing it.' }, 409)

      // The parent keeps reporting paused across requests. This temporary lease serializes
      // cleanup and can only be recovered against that parent's saved cancellation.
      const id = `${operationId}:finish:${matchId}:${crypto.randomUUID()}`
      const [lease] = await db
        .insert(ratingMutationLeases)
        .select(
          db
            .select({
              id: sql<string>`${id}`.as('id'),
              matchId: sql<string>`${matchId}`.as('match_id'),
              generation: ratingMaintenance.generation,
              createdAt: sql<number>`${Date.now()}`.as('created_at'),
            })
            .from(ratingMaintenance)
            .where(and(maintenanceGuard, clearedRatings, savedCancellationGuard(body))),
        )
        .returning({ id: ratingMutationLeases.id })
      if (!lease)
        return c.json({ error: 'The match or reporting pause changed. Check them before finishing cancellation.' }, 409)
      leaseId = lease.id
      console.warn('[season-cancellation] admin finishing saved cancellation', logContext)

      const record = await runSessionTerminalLifecycleCommand(c.env.SessionDO, matchId, {
        type: 'cancel-session',
        matchId,
        at: expectedCancelledAt,
      })
      if (record.phase !== 'cancelled') throw new Error('Terminal cancellation returned a non-cancelled session')
      await removeCivLeaderboardMatchContribution(db, matchId)
      await removePlayerCivStatMatchContribution(db, matchId)
      await markLeaderboardsDirty(db, `season-cancellation:${matchId}`, { civ: true, modes: [...LEADERBOARD_MODES] })
      await markRankedRolesDirty(c.env.KV, `season-cancellation:${matchId}`)
      if (c.env.MaintenanceDO) {
        await wakeDivisionDelivery(c.env.MaintenanceDO, auth.identity.guildId!).catch(error => {
          console.error(
            '[season-cancellation] division delivery wake failed; pending work remains queued',
            logContext,
            error,
          )
        })
      }
      const [updated] = await db
        .select({ status: matches.status })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      if (updated?.status !== 'cancelled') throw new Error('Match cancellation readback failed')
      await releaseRatingMutation(db, leaseId)
      leaseId = null
      return c.json({ ok: true, matchId })
    } catch (error) {
      console.error('[season-cancellation] cleanup failed', logContext, error)
      // Release only this request's cleanup lease. The parent remains through partial
      // lifecycle/stat cleanup and prevents reporting from reopening before verification.
      if (leaseId) {
        await releaseRatingMutation(db, leaseId).catch(releaseError => {
          console.error('[season-cancellation] cleanup lease release failed', logContext, releaseError)
        })
      }
      return c.json({ error: 'Could not finish the match cancellation. Check the match before trying again.' }, 500)
    }
  })
  app.post(RECOVER_FINISH_PATH, async c => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)
    const value = await c.req.json<unknown>().catch(() => null)
    const body = parseCancellationRequest(value)
    const leaseId = value && typeof value === 'object' ? (value as Record<string, unknown>).leaseId : null
    if (!body || typeof leaseId !== 'string' || leaseId.length > 1024) {
      return c.json(
        { error: 'Provide the cancellation details and choose the interrupted cancellation to recover.' },
        400,
      )
    }
    const prefix = `${body.operationId}:finish:${body.matchId}:`
    if (
      !leaseId.startsWith(prefix) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(leaseId.slice(prefix.length))
    )
      return c.json({ error: 'Only an interrupted cancellation for this match can be recovered.' }, 409)

    const { operationId, matchId, expectedCancelledAt, expectedGeneration } = body
    const db = createDb(c.env.DB)
    const logContext = {
      operationId,
      matchId,
      expectedCancelledAt,
      expectedGeneration,
      leaseId,
      adminUserId: auth.identity.userId,
    }
    try {
      const [lease] = await db.select().from(ratingMutationLeases).where(eq(ratingMutationLeases.id, leaseId)).limit(1)
      if (!lease || lease.matchId !== matchId || lease.generation !== expectedGeneration)
        return c.json({ error: 'The interrupted cancellation does not match this match and cancellation plan.' }, 409)
      const cutoff = Date.now() - CLEANUP_RECOVERY_MIN_AGE_MS
      if (!Number.isSafeInteger(lease.createdAt) || lease.createdAt < 0)
        return c.json({ error: 'Could not check when this match cancellation started.' }, 409)
      if (lease.createdAt >= cutoff) {
        return c.json(
          {
            error:
              'This match cancellation may still be running. Wait until more than 15 minutes have passed since it started before recovering it.',
          },
          409,
        )
      }

      // Only idempotent terminal/stat cleanup is recoverable here, never a rating writer.
      // Recheck ownership, age, the reporting pause and saved cancellation in the DELETE.
      const [cleared] = await db
        .delete(ratingMutationLeases)
        .where(
          and(
            eq(ratingMutationLeases.id, leaseId),
            eq(ratingMutationLeases.matchId, matchId),
            eq(ratingMutationLeases.generation, expectedGeneration),
            eq(ratingMutationLeases.createdAt, lease.createdAt),
            sql`${ratingMutationLeases.createdAt} < ${cutoff}`,
            sql`EXISTS(SELECT 1 FROM ${ratingMaintenance} WHERE ${cancellationMaintenanceGuard(body, leaseId)})`,
            clearedCancellationRatingsGuard(matchId),
            savedCancellationGuard(body),
          ),
        )
        .returning({ id: ratingMutationLeases.id })
      if (!cleared) {
        return c.json(
          { error: 'The match or cancellation plan changed. Check the saved cancellation and reporting pause.' },
          409,
        )
      }
      console.warn('[season-cancellation] admin recovered interrupted cleanup', {
        ...logContext,
        createdAt: lease.createdAt,
      })
      return c.json({ ok: true, matchId, leaseId, cleared: true })
    } catch (error) {
      console.error('[season-cancellation] cleanup recovery failed', logContext, error)
      return c.json(
        { error: 'Could not recover the interrupted match cancellation. Check the match before trying again.' },
        500,
      )
    }
  })
}

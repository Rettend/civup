import type { Env } from '../../src/env.ts'
import type { Database as SqliteDatabase } from 'bun:sqlite'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
  leaderboardDirtyStates,
  matchCivStatContributions,
  matches,
  matchParticipants,
  matchPlayerCivStatContributions,
  playerCivStats,
  playerRatingEvents,
  playerRatings,
  players,
  ratingMaintenance,
  ratingMutationLeases,
  seasonMatchReports,
  seasons,
} from '@civup/db'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '@civup/utils'
import { registerActivityAdminRoutes } from '../../src/routes/activity-admin.ts'
import { reconcileCivLeaderboardMatchContribution } from '../../src/services/leaderboard/civ-snapshot.ts'
import { reconcilePlayerCivStatMatchContribution } from '../../src/services/leaderboard/player-civ-stats.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const PATH = '/api/activity/admin/season-cancellation/finish'
const RECOVER_PATH = '/api/activity/admin/season-cancellation/recover-finish'
const GUILD_ID = '1234044388733095946'
const MATCH_ID = 'finish-cancellation'
const CANCELLED_AT = 1_800_000_000_000
const GENERATION = 7
const OPERATION_ID = `season-cancellation:${CANCELLED_AT}:current`
const PARENT_LEASE = { id: OPERATION_ID, matchId: OPERATION_ID, generation: GENERATION, createdAt: CANCELLED_AT }
const CLEANUP_LEASE_ID = `${OPERATION_ID}:finish:${MATCH_ID}:11111111-1111-4111-8111-111111111111`
const BODY = {
  operationId: OPERATION_ID,
  matchId: MATCH_ID,
  expectedCancelledAt: CANCELLED_AT,
  expectedGeneration: GENERATION,
}
const RECOVERY_BODY = { ...BODY, leaseId: CLEANUP_LEASE_ID }
const openDatabases: SqliteDatabase[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

describe('finish saved season cancellation', () => {
  test('accepts D1 numeric bindings stored as REAL when matching cancellation ownership', async () => {
    const harness = await createHarness()
    const original = harness.env.DB
    harness.env.DB = new Proxy(original, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => ({
            bind(...values: unknown[]) {
              let index = 0
              const realBindings = query.replaceAll('?', () =>
                typeof values[index++] === 'number' ? 'CAST(? AS REAL)' : '?',
              )
              return target.prepare(realBindings).bind(...values)
            },
          })
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const response = await harness.request()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, matchId: MATCH_ID })
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('requires an operation ID, cancellation time and generation', async () => {
    const harness = await createHarness()
    for (const body of [
      null,
      { ...BODY, operationId: undefined },
      { ...BODY, operationId: '' },
      { ...BODY, operationId: 1 },
      { ...BODY, matchId: '' },
      { ...BODY, expectedCancelledAt: null },
      { ...BODY, expectedCancelledAt: String(CANCELLED_AT) },
      { ...BODY, expectedGeneration: -1 },
      { ...BODY, expectedGeneration: 1.5 },
    ])
      expect((await harness.request(body)).status).toBe(400)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('advertises persistent cancellation ownership in capability version 2', async () => {
    const harness = await createHarness()
    expect((await harness.capability(null)).status).toBe(401)
    expect((await harness.capability('host', '0')).status).toBe(403)
    const response = await harness.capability()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: 2 })
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('requires an authenticated admin in the allowed guild, not the match host', async () => {
    const harness = await createHarness()
    expect((await harness.request(BODY, null)).status).toBe(401)
    expect((await harness.request(BODY, 'host', '0')).status).toBe(403)
    expect((await harness.request(BODY, 'admin', '8', 'other-guild')).status).toBe(403)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('refuses open maintenance, a stale generation, and admitted writers', async () => {
    const harness = await createHarness()
    await harness.db.update(ratingMaintenance).set({ state: 'open' })
    expect((await harness.request()).status).toBe(409)
    await harness.db.update(ratingMaintenance).set({ state: 'paused' })
    expect((await harness.request({ ...BODY, expectedGeneration: GENERATION - 1 })).status).toBe(409)
    await harness.db
      .insert(ratingMutationLeases)
      .values({ id: 'writer', matchId: 'other', generation: GENERATION, createdAt: 1 })
    expect((await harness.request()).status).toBe(409)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toHaveLength(2)
    expect((await harness.db.select().from(matches))[0]!.status).toBe('completed')
  })

  test('requires the exact persistent parent and refuses another unfinished cleanup', async () => {
    const harness = await createHarness()
    await harness.db.delete(ratingMutationLeases)
    expect((await harness.request()).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toHaveLength(0)
    await harness.db.insert(ratingMutationLeases).values(PARENT_LEASE)
    for (const values of [{ matchId: 'other' }, { generation: GENERATION - 1 }, { createdAt: CANCELLED_AT + 1 }]) {
      await harness.db.update(ratingMutationLeases).set(values)
      expect((await harness.request()).status).toBe(409)
      await harness.db.update(ratingMutationLeases).set(PARENT_LEASE)
    }
    const otherOperation = `season-cancellation:${CANCELLED_AT}:other`
    await harness.db.update(ratingMutationLeases).set({ id: otherOperation, matchId: otherOperation })
    expect((await harness.request({ ...BODY, operationId: otherOperation })).status).toBe(409)
    await harness.db.update(ratingMutationLeases).set(PARENT_LEASE)
    await addInterruptedCleanup(harness)
    expect((await harness.request()).status).toBe(409)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toHaveLength(2)
  })

  test('refuses a missing, uncancelled, differently timed, or different-season report', async () => {
    const harness = await createHarness()
    await harness.db.update(seasonMatchReports).set({ cancelledAt: null })
    expect((await harness.request()).status).toBe(409)
    await harness.db.update(seasonMatchReports).set({ cancelledAt: CANCELLED_AT + 1 })
    expect((await harness.request()).status).toBe(409)
    await harness.db.insert(seasons).values({ id: 'other', name: 'Other', seasonNumber: 2, startsAt: 1 })
    await harness.db.update(seasonMatchReports).set({ cancelledAt: CANCELLED_AT, seasonId: 'other' })
    expect((await harness.request()).status).toBe(409)
    await harness.db.delete(seasonMatchReports)
    expect((await harness.request()).status).toBe(409)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('refuses non-terminal matches and inactive, legacy, or non-isolated seasons', async () => {
    const harness = await createHarness()
    await harness.db.update(matches).set({ status: 'active' })
    expect((await harness.request()).status).toBe(409)
    await harness.db.update(matches).set({ status: 'completed' })
    for (const values of [{ active: false }, { ratingSystem: 'legacy' as const }, { isolatedRatingsEnabled: false }]) {
      await harness.db.update(seasons).set(values)
      expect((await harness.request()).status).toBe(409)
      await harness.db.update(seasons).set({ active: true, ratingSystem: 'rp', isolatedRatingsEnabled: true })
    }
    expect(harness.commands).toHaveLength(0)
  })

  test('refuses residual rating events and every participant placement or rating snapshot', async () => {
    const harness = await createHarness()
    await harness.db.insert(playerRatingEvents).values({
      matchId: MATCH_ID,
      playerId: 'host',
      mode: 'global',
      gameMode: 'ffa',
      matchCreatedAt: 1,
      ratingBeforeMu: 25,
      ratingBeforeSigma: 8,
      ratingAfterMu: 26,
      ratingAfterSigma: 7,
    })
    expect((await harness.request()).status).toBe(409)
    await harness.db.delete(playerRatingEvents)
    for (const field of [
      'placement',
      'ratingBeforeMu',
      'ratingBeforeSigma',
      'ratingAfterMu',
      'ratingAfterSigma',
    ] as const) {
      await harness.db
        .update(matchParticipants)
        .set({ [field]: 1 })
        .where(eq(matchParticipants.playerId, 'opponent'))
      expect((await harness.request()).status).toBe(409)
      await harness.db.update(matchParticipants).set({ [field]: null })
    }
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('rechecks the cancelled source atomically before taking its cleanup lease', async () => {
    const harness = await createHarness()
    const prepare = harness.env.DB.prepare.bind(harness.env.DB)
    harness.env.DB.prepare = query => {
      if (query.startsWith('insert into "rating_mutation_leases"'))
        harness.sqlite.run('UPDATE season_match_reports SET cancelled_at = ?', [CANCELLED_AT + 1])
      return prepare(query)
    }
    expect((await harness.request()).status).toBe(409)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('rechecks the parent atomically before taking its cleanup lease', async () => {
    const harness = await createHarness()
    const prepare = harness.env.DB.prepare.bind(harness.env.DB)
    harness.env.DB.prepare = query => {
      if (query.startsWith('insert into "rating_mutation_leases"')) {
        harness.sqlite.run('UPDATE rating_mutation_leases SET generation = ? WHERE id = ?', [
          GENERATION + 1,
          OPERATION_ID,
        ])
      }
      return prepare(query)
    }
    expect((await harness.request()).status).toBe(409)
    expect(harness.commands).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([
      { ...PARENT_LEASE, generation: GENERATION + 1 },
    ])
  })

  test('finishes lifecycle and both stat contributions without recalculating any ratings, including repeated calls', async () => {
    const harness = await createHarness()
    forbidRatingWrites(harness.sqlite)
    const ratings = await harness.db.select().from(playerRatings)
    expect(await harness.db.select().from(matchCivStatContributions)).toHaveLength(1)
    expect(await harness.db.select().from(matchPlayerCivStatContributions)).toHaveLength(1)
    expect(await harness.db.select().from(playerCivStats)).toHaveLength(2)
    for (const permissions of ['8', '32']) {
      const response = await harness.request(BODY, 'admin-not-host', permissions)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, matchId: MATCH_ID })
      expect((await harness.db.select().from(matches))[0]!.status).toBe('cancelled')
      expect(harness.phase).toBe('cancelled')
      expect(await harness.db.select().from(matchCivStatContributions)).toHaveLength(0)
      expect(await harness.db.select().from(matchPlayerCivStatContributions)).toHaveLength(0)
      expect(await harness.db.select().from(playerCivStats)).toHaveLength(0)
      expect(await harness.db.select().from(playerRatings)).toEqual(ratings)
      expect(await harness.db.select().from(playerRatingEvents)).toHaveLength(0)
      expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
    }
    expect(harness.commands).toEqual(
      Array.from({ length: 2 }, () => ({ type: 'cancel-session', matchId: MATCH_ID, at: CANCELLED_AT })),
    )
    expect((await harness.db.select().from(leaderboardDirtyStates)).map(row => row.scope).sort()).toEqual([
      'civ:all',
      'civ:duel',
      'civ:duo',
      'civ:squad',
      'player:duel',
      'player:duo',
      'player:ffa',
      'player:red-death',
      'player:squad',
    ])
    expect(await harness.env.KV.get('ranked-roles:dirty', 'json')).toMatchObject({
      reason: `season-cancellation:${MATCH_ID}`,
    })
    expect(harness.waitUntilTasks).toHaveLength(2)
  })

  test('retries after lifecycle and civ cleanup were saved but player-civ cleanup failed', async () => {
    const harness = await createHarness()
    forbidRatingWrites(harness.sqlite)
    harness.sqlite.exec(`CREATE TRIGGER fail_player_civ_cleanup BEFORE DELETE ON match_player_civ_stat_contributions
      BEGIN SELECT RAISE(ABORT, 'private SQL failure details'); END`)
    const failed = await harness.request()
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({
      error: 'Could not finish the match cancellation. Check the match before trying again.',
    })
    expect((await harness.db.select().from(matches))[0]!.status).toBe('cancelled')
    expect(await harness.db.select().from(matchCivStatContributions)).toHaveLength(0)
    expect(await harness.db.select().from(matchPlayerCivStatContributions)).toHaveLength(1)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
    harness.sqlite.exec('DROP TRIGGER fail_player_civ_cleanup')
    const retry = await harness.request()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ ok: true, matchId: MATCH_ID })
    expect(await harness.db.select().from(matchPlayerCivStatContributions)).toHaveLength(0)
    expect(await harness.db.select().from(playerCivStats)).toHaveLength(0)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
    expect(harness.commands).toHaveLength(2)
  })

  test('a missing lifecycle namespace returns a safe error and leaves stat cleanup available for retry', async () => {
    const harness = await createHarness()
    harness.env.SessionDO = undefined
    const response = await harness.request()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Could not finish the match cancellation. Check the match before trying again.',
    })
    expect(await harness.db.select().from(matchCivStatContributions)).toHaveLength(1)
    expect(await harness.db.select().from(matchPlayerCivStatContributions)).toHaveLength(1)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('wakes division delivery for the authenticated guild after cleanup', async () => {
    const harness = await createHarness()
    const notifications: unknown[] = []
    harness.env.MaintenanceDO = {
      idFromName(name: string) {
        expect(name).toBe('global')
        return name as unknown as DurableObjectId
      },
      get() {
        return {
          async fetch(request: Request) {
            expect(new URL(request.url).pathname).toBe('/ranked-roles/wake')
            notifications.push(await request.json())
            return Response.json({ ok: true })
          },
        }
      },
    } as unknown as DurableObjectNamespace
    expect((await harness.request()).status).toBe(200)
    expect(notifications).toEqual([{ guildId: GUILD_ID }])
  })

  test('recovers a stranded cleanup lease after release fails, then finishes without releasing the parent', async () => {
    const harness = await createHarness()
    harness.sqlite.exec(`CREATE TRIGGER fail_cleanup_release BEFORE DELETE ON rating_mutation_leases
      WHEN OLD.id <> '${OPERATION_ID}' BEGIN SELECT RAISE(ABORT, 'release unavailable'); END`)
    expect((await harness.request()).status).toBe(500)
    const leases = await harness.db.select().from(ratingMutationLeases)
    expect(leases).toHaveLength(2)
    const cleanup = leases.find(lease => lease.id !== OPERATION_ID)!
    expect(cleanup.id).toStartWith(`${OPERATION_ID}:finish:${MATCH_ID}:`)
    expect((await harness.request()).status).toBe(409)
    harness.sqlite.exec('DROP TRIGGER fail_cleanup_release')
    await harness.db
      .update(ratingMutationLeases)
      .set({ createdAt: Date.now() - 16 * 60_000 })
      .where(eq(ratingMutationLeases.id, cleanup.id))
    expect((await harness.recover({ ...RECOVERY_BODY, leaseId: cleanup.id })).status).toBe(200)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
    expect((await harness.request()).status).toBe(200)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })
})

describe('recover interrupted cancellation cleanup', () => {
  test('requires the same authenticated admin and explicit recovery details', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    expect((await harness.recover(RECOVERY_BODY, null)).status).toBe(401)
    expect((await harness.recover(RECOVERY_BODY, 'host', '0')).status).toBe(403)
    expect((await harness.recover(RECOVERY_BODY, 'admin', '8', 'other-guild')).status).toBe(403)
    for (const body of [
      null,
      { ...RECOVERY_BODY, operationId: null },
      { ...RECOVERY_BODY, leaseId: undefined },
      { ...RECOVERY_BODY, leaseId: 1 },
    ])
      expect((await harness.recover(body)).status).toBe(400)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE, cleanup])
    expect(harness.commands).toHaveLength(0)
  })

  test.each(['completed', 'cancelled'])(
    'clears only the reviewed old cleanup for a %s match without any match or rating writes',
    async status => {
      const harness = await createHarness()
      await addInterruptedCleanup(harness)
      await harness.db.update(matches).set({ status })
      const before = {
        matches: await harness.db.select().from(matches),
        participants: await harness.db.select().from(matchParticipants),
        ratings: await harness.db.select().from(playerRatings),
        civ: await harness.db.select().from(matchCivStatContributions),
        playerCiv: await harness.db.select().from(matchPlayerCivStatContributions),
      }
      forbidRatingWrites(harness.sqlite)
      const response = await harness.recover()
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, matchId: MATCH_ID, leaseId: CLEANUP_LEASE_ID, cleared: true })
      expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
      expect(await harness.db.select().from(matches)).toEqual(before.matches)
      expect(await harness.db.select().from(matchParticipants)).toEqual(before.participants)
      expect(await harness.db.select().from(playerRatings)).toEqual(before.ratings)
      expect(await harness.db.select().from(matchCivStatContributions)).toEqual(before.civ)
      expect(await harness.db.select().from(matchPlayerCivStatContributions)).toEqual(before.playerCiv)
      expect(harness.commands).toHaveLength(0)
      expect(harness.waitUntilTasks).toHaveLength(1)
      expect((await harness.recover()).status).toBe(409)
    },
  )

  test('refuses the parent, rating writers, malformed ownership and another match’s cleanup', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    for (const leaseId of [
      OPERATION_ID,
      'rating-writer',
      `${OPERATION_ID}:finish:other:11111111-1111-4111-8111-111111111111`,
      `${CLEANUP_LEASE_ID}:extra`,
      `${OPERATION_ID}:finish:${MATCH_ID}:not-a-uuid`,
    ])
      expect((await harness.recover({ ...RECOVERY_BODY, leaseId })).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE, cleanup])
  })

  test('refuses a recent cleanup, mismatched match or generation, and a missing cleanup', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    for (const values of [
      { createdAt: Date.now() },
      { createdAt: -1 },
      { matchId: 'other' },
      { generation: GENERATION - 1 },
    ]) {
      await harness.db.update(ratingMutationLeases).set(values).where(eq(ratingMutationLeases.id, CLEANUP_LEASE_ID))
      expect((await harness.recover()).status).toBe(409)
      await harness.db.update(ratingMutationLeases).set(cleanup).where(eq(ratingMutationLeases.id, CLEANUP_LEASE_ID))
    }
    await harness.db.delete(ratingMutationLeases).where(eq(ratingMutationLeases.id, CLEANUP_LEASE_ID))
    expect((await harness.recover()).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
  })

  test('requires more than 15 minutes of age, not exactly 15 minutes', async () => {
    const harness = await createHarness()
    const now = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(now)
    try {
      await addInterruptedCleanup(harness, { createdAt: now - 15 * 60_000 })
      const response = await harness.recover()
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        error:
          'This match cancellation may still be running. Wait until more than 15 minutes have passed since it started before recovering it.',
      })
      await harness.db
        .update(ratingMutationLeases)
        .set({ createdAt: now - 15 * 60_000 - 1 })
        .where(eq(ratingMutationLeases.id, CLEANUP_LEASE_ID))
      expect((await harness.recover()).status).toBe(200)
      expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE])
    } finally {
      clock.mockRestore()
    }
  })

  test('keeps both leases and hides unexpected recovery errors', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    harness.sqlite.exec(`CREATE TRIGGER fail_cleanup_recovery BEFORE DELETE ON rating_mutation_leases
      BEGIN SELECT RAISE(ABORT, 'private recovery SQL details'); END`)
    const response = await harness.recover()
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Could not recover the interrupted match cancellation. Check the match before trying again.',
    })
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE, cleanup])
    expect(harness.commands).toHaveLength(0)
  })

  test('requires a paused current-generation parent and refuses unrelated work', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    await harness.db.update(ratingMaintenance).set({ state: 'open' })
    expect((await harness.recover()).status).toBe(409)
    await harness.db.update(ratingMaintenance).set({ state: 'paused', generation: GENERATION + 1 })
    expect((await harness.recover()).status).toBe(409)
    await harness.db.update(ratingMaintenance).set({ generation: GENERATION })
    for (const values of [{ generation: GENERATION - 1 }, { matchId: 'other' }, { createdAt: CANCELLED_AT + 1 }]) {
      await harness.db.update(ratingMutationLeases).set(values).where(eq(ratingMutationLeases.id, OPERATION_ID))
      expect((await harness.recover()).status).toBe(409)
      await harness.db.update(ratingMutationLeases).set(PARENT_LEASE).where(eq(ratingMutationLeases.id, OPERATION_ID))
    }
    await harness.db.delete(ratingMutationLeases).where(eq(ratingMutationLeases.id, OPERATION_ID))
    expect((await harness.recover()).status).toBe(409)
    await harness.db.insert(ratingMutationLeases).values(PARENT_LEASE)
    const unrelated = { id: 'rating-writer', matchId: 'other', generation: GENERATION, createdAt: 1 }
    await harness.db.insert(ratingMutationLeases).values(unrelated)
    expect((await harness.recover()).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([cleanup, PARENT_LEASE, unrelated])
    expect(harness.commands).toHaveLength(0)
  })

  test('refuses an uncancelled, differently timed, missing or different-season saved report', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    for (const cancelledAt of [null, CANCELLED_AT + 1]) {
      await harness.db.update(seasonMatchReports).set({ cancelledAt })
      expect((await harness.recover()).status).toBe(409)
    }
    await harness.db.insert(seasons).values({ id: 'other', name: 'Other', seasonNumber: 2, startsAt: 1 })
    await harness.db.update(seasonMatchReports).set({ seasonId: 'other', cancelledAt: CANCELLED_AT })
    expect((await harness.recover()).status).toBe(409)
    await harness.db.delete(seasonMatchReports)
    expect((await harness.recover()).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE, cleanup])
  })

  test('refuses a non-terminal match or inactive, legacy or non-isolated season', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    await harness.db.update(matches).set({ status: 'active' })
    expect((await harness.recover()).status).toBe(409)
    await harness.db.update(matches).set({ status: 'completed' })
    for (const values of [{ active: false }, { ratingSystem: 'legacy' as const }, { isolatedRatingsEnabled: false }]) {
      await harness.db.update(seasons).set(values)
      expect((await harness.recover()).status).toBe(409)
      await harness.db.update(seasons).set({ active: true, ratingSystem: 'rp', isolatedRatingsEnabled: true })
    }
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE, cleanup])
  })

  test('refuses residual events, placements, snapshots and missing participants', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    await harness.db.insert(playerRatingEvents).values({
      matchId: MATCH_ID,
      playerId: 'host',
      mode: 'global',
      gameMode: 'ffa',
      matchCreatedAt: 1,
      ratingBeforeMu: 25,
      ratingBeforeSigma: 8,
      ratingAfterMu: 26,
      ratingAfterSigma: 7,
    })
    expect((await harness.recover()).status).toBe(409)
    await harness.db.delete(playerRatingEvents)
    for (const field of [
      'placement',
      'ratingBeforeMu',
      'ratingBeforeSigma',
      'ratingAfterMu',
      'ratingAfterSigma',
    ] as const) {
      await harness.db
        .update(matchParticipants)
        .set({ [field]: 1 })
        .where(eq(matchParticipants.playerId, 'opponent'))
      expect((await harness.recover()).status).toBe(409)
      await harness.db.update(matchParticipants).set({ [field]: null })
    }
    await harness.db.delete(matchParticipants)
    expect((await harness.recover()).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([PARENT_LEASE, cleanup])
    expect(harness.commands).toHaveLength(0)
  })

  test('requires an operation ID derived from the saved report even when that parent exists', async () => {
    const harness = await createHarness()
    const operationId = `season-cancellation:${CANCELLED_AT}:other`
    const leaseId = `${operationId}:finish:${MATCH_ID}:11111111-1111-4111-8111-111111111111`
    await harness.db.update(ratingMutationLeases).set({ id: operationId, matchId: operationId })
    const cleanup = await addInterruptedCleanup(harness, { id: leaseId })
    expect((await harness.recover({ ...RECOVERY_BODY, operationId, leaseId })).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([
      { ...PARENT_LEASE, id: operationId, matchId: operationId },
      cleanup,
    ])
  })

  test('atomically rechecks the exact reviewed creation time before deleting cleanup', async () => {
    const harness = await createHarness()
    const cleanup = await addInterruptedCleanup(harness)
    const prepare = harness.env.DB.prepare.bind(harness.env.DB)
    harness.env.DB.prepare = query => {
      if (query.startsWith('delete from "rating_mutation_leases"')) {
        harness.sqlite.run('UPDATE rating_mutation_leases SET created_at = ? WHERE id = ?', [
          cleanup.createdAt - 1,
          CLEANUP_LEASE_ID,
        ])
      }
      return prepare(query)
    }
    expect((await harness.recover()).status).toBe(409)
    expect(await harness.db.select().from(ratingMutationLeases)).toEqual([
      PARENT_LEASE,
      { ...cleanup, createdAt: cleanup.createdAt - 1 },
    ])
  })

  test('atomically refuses a changed saved cancellation or parent before deleting cleanup', async () => {
    for (const query of [
      'UPDATE season_match_reports SET cancelled_at = cancelled_at + 1',
      'UPDATE rating_mutation_leases SET generation = generation + 1 WHERE id = ?',
    ]) {
      const harness = await createHarness()
      await addInterruptedCleanup(harness)
      const prepare = harness.env.DB.prepare.bind(harness.env.DB)
      harness.env.DB.prepare = sql => {
        if (sql.startsWith('delete from "rating_mutation_leases"'))
          harness.sqlite.run(query, query.includes('?') ? [OPERATION_ID] : [])
        return prepare(sql)
      }
      expect((await harness.recover()).status).toBe(409)
      expect(await harness.db.select().from(ratingMutationLeases)).toHaveLength(2)
    }
  })
})

async function addInterruptedCleanup(
  harness: Awaited<ReturnType<typeof createHarness>>,
  values: Partial<typeof ratingMutationLeases.$inferInsert> = {},
) {
  const lease = {
    id: CLEANUP_LEASE_ID,
    matchId: MATCH_ID,
    generation: GENERATION,
    createdAt: Date.now() - 16 * 60_000,
    ...values,
  }
  await harness.db.insert(ratingMutationLeases).values(lease)
  return lease
}

function forbidRatingWrites(sqlite: SqliteDatabase) {
  for (const table of [
    'player_ratings',
    'player_rating_events',
    'season_rating_states',
    'season_match_reports',
    'match_participants',
  ]) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      sqlite.exec(`CREATE TRIGGER forbid_${table}_${operation} BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Cleanup must not recalculate or change ratings'); END`)
    }
  }
}

async function createHarness() {
  const { db, sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  const kv = createTestKv()
  await db.insert(seasons).values({
    id: 'current',
    name: 'Current',
    seasonNumber: 1,
    startsAt: 1,
    active: true,
    ratingSystem: 'rp',
    isolatedRatingsEnabled: true,
  })
  await db.insert(players).values([
    { id: 'host', displayName: 'Host', createdAt: 1 },
    { id: 'opponent', displayName: 'Opponent', createdAt: 1 },
  ])
  await db
    .insert(matches)
    .values({ id: MATCH_ID, gameMode: 'ffa', status: 'completed', seasonId: 'current', createdAt: 1, completedAt: 2 })
  await db.insert(matchParticipants).values([
    { matchId: MATCH_ID, playerId: 'host', civId: 'civ-1', placement: 1 },
    { matchId: MATCH_ID, playerId: 'opponent', civId: 'civ-2', placement: 2 },
  ])
  await db.insert(playerRatings).values({ playerId: 'host', mode: 'global', mu: 27, sigma: 7, gamesPlayed: 3 })
  await reconcileCivLeaderboardMatchContribution(db, MATCH_ID)
  await reconcilePlayerCivStatMatchContribution(db, MATCH_ID)
  await db.update(matchParticipants).set({ placement: null })
  await db
    .insert(seasonMatchReports)
    .values({ matchId: MATCH_ID, seasonId: 'current', acceptedAt: 2, cancelledAt: CANCELLED_AT })
  await db.update(ratingMaintenance).set({ state: 'paused', generation: GENERATION })
  await db.insert(ratingMutationLeases).values(PARENT_LEASE)

  let phase = 'reported'
  const commands: unknown[] = []
  const waitUntilTasks: Promise<unknown>[] = []
  const namespace = {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      expect(String(id)).toBe(MATCH_ID)
      return {
        async fetch(request: Request) {
          expect(new URL(request.url).pathname).toBe('/commands/session-lifecycle')
          commands.push(await request.json())
          // The persistent parent and one temporary cleanup lease cover all mutations.
          const leases = await db.select().from(ratingMutationLeases)
          expect(leases).toHaveLength(2)
          expect(leases.find(lease => lease.id === OPERATION_ID)).toEqual(PARENT_LEASE)
          expect(leases.find(lease => lease.id !== OPERATION_ID)).toMatchObject({
            id: expect.stringContaining(`${OPERATION_ID}:finish:${MATCH_ID}:`),
            matchId: MATCH_ID,
            generation: GENERATION,
          })
          phase = 'cancelled'
          await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, MATCH_ID))
          return Response.json({ record: { phase } })
        },
      }
    },
  } as unknown as DurableObjectNamespace
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(sqlite),
    KV: kv,
    SessionDO: namespace,
    DISCORD_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'test-secret',
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
  }
  const app = new Hono<Env>()
  registerActivityAdminRoutes(app)
  const request = async (
    path: string,
    body: unknown,
    userId: string | null = 'admin',
    permissions = '8',
    guildId = GUILD_ID,
    method = 'POST',
  ) => {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (userId) {
      headers.set(CIVUP_INTERNAL_SECRET_HEADER, 'test-secret')
      headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, userId)
      headers.set(CIVUP_ACTIVITY_GUILD_ID_HEADER, guildId)
      headers.set(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER, permissions)
    }
    const response = await app.fetch(
      new Request(
        `https://bot.test${path}`,
        method === 'GET' ? { method, headers } : { method, headers, body: JSON.stringify(body) },
      ),
      env,
      {
        waitUntil(task: Promise<unknown>) {
          waitUntilTasks.push(task)
        },
        passThroughOnException() {},
      } as ExecutionContext,
    )
    await Promise.all(waitUntilTasks)
    return response
  }
  return {
    db,
    sqlite,
    env,
    commands,
    waitUntilTasks,
    get phase() {
      return phase
    },
    request: (body: unknown = BODY, userId: string | null = 'admin', permissions = '8', guildId = GUILD_ID) =>
      request(PATH, body, userId, permissions, guildId),
    recover: (body: unknown = RECOVERY_BODY, userId: string | null = 'admin', permissions = '8', guildId = GUILD_ID) =>
      request(RECOVER_PATH, body, userId, permissions, guildId),
    capability: (userId: string | null = 'admin', permissions = '8', guildId = GUILD_ID) =>
      request(PATH, undefined, userId, permissions, guildId, 'GET'),
  }
}

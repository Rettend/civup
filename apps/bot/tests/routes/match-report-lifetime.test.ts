import type { Env } from '../../src/env.ts'
import { matches, matchParticipants, playerRatingEvents, players, ratingMutationLeases, seasonMatchReports, seasons } from '@civup/db'
import { CIVUP_ACTIVITY_USER_ID_HEADER, CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerMatchRoutes } from '../../src/routes/match.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('an aborted Activity connection retains the in-flight report until its writer is released', async () => {
  const { db, sqlite } = await createTestDatabase()
  const blocked = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const tasks: Promise<unknown>[] = []
  let response: Promise<Response> | undefined
  try {
    await db.insert(players).values(['p', 'q'].map(id => ({ id, displayName: id, createdAt: 0 })))
    await db.insert(seasons).values({ id: 'old', name: 'Old season', seasonNumber: 1, startsAt: 0, endsAt: 1000, finalizedAt: 2000, isolatedRatingsEnabled: true })
    await db.insert(matches).values({ id: 'm', seasonId: 'old', gameMode: '1v1', status: 'completed', createdAt: 100, completedAt: 1100, draftData: JSON.stringify({ reportedById: 'p' }) })
    await db.insert(matchParticipants).values(['p', 'q'].map((playerId, team) => ({ matchId: 'm', playerId, team, placement: team + 1 })))
    await db.insert(seasonMatchReports).values({ matchId: 'm', seasonId: 'old', acceptedAt: 1100 })
    await db.insert(playerRatingEvents).values(['p', 'q'].flatMap(playerId => ['duel', 'global'].map(mode => ({ matchId: 'm', playerId, mode, gameMode: '1v1', seasonId: 'old', ratingBeforeMu: 25, ratingBeforeSigma: 3, ratingAfterMu: 25, ratingAfterSigma: 3, matchCreatedAt: 100 }))))
    const d1 = createSqliteD1Database(sqlite)
    let held = false
    const withGate = (statement: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => withGate(target.bind(...values), query)
        const value = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        return async (...args: unknown[]) => {
          if (!held && /from "matches"/i.test(query)) {
            held = true
            blocked.resolve()
            await proceed.promise
          }
          return value.apply(target, args)
        }
      },
    })
    const binding = new Proxy(d1, {
      get(target, property) {
        if (property === 'prepare') return (query: string) => withGate(target.prepare(query), query)
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = new Hono<Env>()
    registerMatchRoutes(app)
    const abort = new AbortController()
    response = app.fetch(new Request('https://bot.test/api/match/m/report', {
      method: 'POST', signal: abort.signal,
      headers: { 'Content-Type': 'application/json', [CIVUP_INTERNAL_SECRET_HEADER]: 'secret', [CIVUP_ACTIVITY_USER_ID_HEADER]: 'p' },
      body: JSON.stringify({ reporterId: 'p', placements: 'p' }),
    }), { DB: binding, KV: createTestKv(), CIVUP_SECRET: 'secret', DISCORD_TOKEN: 'token' } as Env['Bindings'], {
      waitUntil(task: Promise<unknown>) { tasks.push(task) }, passThroughOnException() {},
    } as ExecutionContext) as Promise<Response>
    await blocked.promise
    expect(await db.select().from(ratingMutationLeases)).toHaveLength(1)
    abort.abort()
    expect(tasks.length).toBeGreaterThan(0)
    proceed.resolve()
    await Promise.all(tasks)
    expect((await response).status).toBe(200)
    expect(await db.select().from(ratingMutationLeases)).toHaveLength(0)
    expect(await db.select().from(playerRatingEvents)).toHaveLength(4)
  }
  finally {
    proceed.resolve()
    await response?.catch(() => {})
    await Promise.allSettled(tasks)
    sqlite.close()
  }
})

import { matchRepairs, matches } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { processPendingMatchRepairs } from '../../src/services/match/repairs.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000

describe('match repair processor', () => {
  test('claims and completes Activity overview rebuild work', async () => {
    const { db, sqlite } = await createTestDatabase()
    const requests: Request[] = []
    await seedRepair(db, { id: 'repair-activity', repairType: 'activity-rebuild' })

    const result = await processPendingMatchRepairs(db, createTestKv(), {
      now: NOW,
      leaseOwner: 'worker-1',
      activityNamespace: activityNamespace(async request => {
        requests.push(request)
        return Response.json({ ok: true })
      }),
      internalSecret: 'secret',
    })

    expect(result).toEqual({ claimed: 1, completed: 1, retried: 0, attention: 0, superseded: 0 })
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!.url).pathname).toEndWith('/rebuild')
    expect((await loadRepair(db, 'repair-activity'))).toMatchObject({ status: 'completed', attempts: 1, leaseOwner: null, lastError: null })
    sqlite.close()
  })

  test('releases failed work with exponential retry metadata', async () => {
    const { db, sqlite } = await createTestDatabase()
    await seedRepair(db, { id: 'repair-retry', repairType: 'activity-rebuild' })

    const result = await processPendingMatchRepairs(db, createTestKv(), {
      now: NOW,
      leaseOwner: 'worker-1',
      activityNamespace: activityNamespace(async () => new Response('unavailable', { status: 503 })),
    })

    expect(result).toEqual({ claimed: 1, completed: 0, retried: 1, attention: 0, superseded: 0 })
    expect((await loadRepair(db, 'repair-retry'))).toMatchObject({
      status: 'pending',
      attempts: 1,
      leaseOwner: null,
      nextAttemptAt: NOW + 60_000,
      lastError: expect.stringContaining('503'),
    })
    sqlite.close()
  })

  test('supersedes stale result-revision work without running it', async () => {
    const { db, sqlite } = await createTestDatabase()
    let requests = 0
    await db.insert(matches).values({
      id: 'match-newer',
      guildId: '111111111111111111',
      gameMode: '1v1',
      status: 'completed',
      createdAt: NOW - 1,
      completedAt: NOW,
      resultRevision: 2,
    })
    await seedRepair(db, { id: 'repair-stale', repairType: 'activity-rebuild', matchId: 'match-newer', resultRevision: 1 })

    const result = await processPendingMatchRepairs(db, createTestKv(), {
      now: NOW,
      leaseOwner: 'worker-1',
      activityNamespace: activityNamespace(async () => {
        requests += 1
        return Response.json({ ok: true })
      }),
    })

    expect(result.superseded).toBe(1)
    expect(requests).toBe(0)
    expect((await loadRepair(db, 'repair-stale'))?.status).toBe('superseded')
    sqlite.close()
  })

  test('does not claim work with a live lease', async () => {
    const { db, sqlite } = await createTestDatabase()
    await seedRepair(db, { id: 'repair-leased', repairType: 'activity-rebuild', leaseOwner: 'other', leaseExpiresAt: NOW + 1 })

    const result = await processPendingMatchRepairs(db, createTestKv(), { now: NOW, leaseOwner: 'worker-1' })

    expect(result.claimed).toBe(0)
    expect((await loadRepair(db, 'repair-leased'))?.status).toBe('pending')
    sqlite.close()
  })
})

async function seedRepair(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: { id: string, repairType: string, matchId?: string | null, resultRevision?: number, leaseOwner?: string | null, leaseExpiresAt?: number | null },
): Promise<void> {
  await db.insert(matchRepairs).values({
    id: input.id,
    idempotencyKey: input.id,
    sessionId: null,
    matchId: input.matchId ?? null,
    resultRevision: input.resultRevision ?? 0,
    repairType: input.repairType,
    status: 'pending',
    leaseOwner: input.leaseOwner ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    attempts: 0,
    nextAttemptAt: NOW,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function loadRepair(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], id: string) {
  return (await db.select().from(matchRepairs).where(eq(matchRepairs.id, id)).limit(1))[0] ?? null
}

function activityNamespace(handler: (request: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName: name => name as unknown as DurableObjectId,
    get: () => ({ fetch: handler }) as DurableObjectStub,
  } as DurableObjectNamespace
}

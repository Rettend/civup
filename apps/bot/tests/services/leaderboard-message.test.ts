import type { Database } from '@civup/db'
import { leaderboardDirtyStates, leaderboardMessageStates, matches, matchParticipants, playerRatings, players, seasons } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { backfillCivLeaderboardStatsFromHistory, getStoredCivLeaderboardSnapshot, rebuildCivLeaderboardSnapshot, reconcileCivLeaderboardMatchContribution } from '../../src/services/leaderboard/civ-snapshot.ts'
import { archiveSeasonLeaderboards, markLeaderboardsDirty, refreshDirtyLeaderboards, upsertLeaderboardMessagesForChannel } from '../../src/services/leaderboard/message.ts'
import { ensureLeaderboardModeSnapshot, getStoredLeaderboardModeSnapshot, leaderboardModeSnapshotKey, rebuildLeaderboardModeSnapshot } from '../../src/services/leaderboard/snapshot.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch

describe('leaderboard message service', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('archives the current leaderboard and creates a fresh live message on season end', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-1')

    await db.insert(players).values({
      id: '100010000000000001',
      displayName: 'Player One',
      avatarUrl: null,
      createdAt: NOW,
    })
    await db.insert(playerRatings).values({
      playerId: '100010000000000001',
      mode: 'ffa',
      mu: 35,
      sigma: 6,
      gamesPlayed: 10,
      wins: 5,
      lastPlayedAt: NOW,
    })
    await db.insert(seasons).values({
      id: 'season-9',
      seasonNumber: 9,
      name: 'Season 9',
      startsAt: NOW - 10_000,
      endsAt: null,
      active: true,
    })

    const postPayloads: any[] = []
    const patchPayloads: any[] = []
    let messageCounter = 0
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-1/messages')) {
        messageCounter += 1
        const payload = await readDiscordMultipartPayload(init)
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: `message-${messageCounter}` }), { status: 200 })
      }
      if (init?.method === 'PATCH' && url.includes('/channels/channel-1/messages/')) {
        const payload = await readDiscordMultipartPayload(init)
        patchPayloads.push(payload)
        return new Response('{}', { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    await upsertLeaderboardMessagesForChannel(db, kv, 'token', 'channel-1', { modes: ['ffa'] })
    await db.update(seasons).set({ active: false, endsAt: NOW + 1 }).where(eq(seasons.id, 'season-9'))
    await archiveSeasonLeaderboards(db, kv, 'token', 'Season 9', { modes: ['ffa'] })

    expect(postPayloads).toHaveLength(2)
    expect(patchPayloads).toHaveLength(1)
    expect(patchPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-ffa.png')
    expect(postPayloads[1].attachments?.[0]?.filename).toBe('leaderboard-ffa.png')

    const [state] = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, 'player:ffa')).limit(1)
    expect(state?.messageId).toBe('message-2')

    sqlite.close()
  })

  test('legacy player snapshots without a cache version rebuild from D1', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelRating(db, '100010000000000002', 10)
      await kv.put(leaderboardModeSnapshotKey('duel'), JSON.stringify({
        updatedAt: NOW - 1,
        rows: [{
          playerId: '100010000000000002',
          mu: 30,
          sigma: 6,
          gamesPlayed: 9,
          wins: 9,
          lastPlayedAt: NOW - 1,
        }],
      }))

      const snapshot = await ensureLeaderboardModeSnapshot(db, kv, 'duel')

      expect(snapshot.rows.find(row => row.playerId === '100010000000000002')?.gamesPlayed).toBe(10)
    }
    finally {
      sqlite.close()
    }
  })

  test('dirty refresh rebuilds stale player snapshot from ratings and clears dirty state', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-leaderboard')

    const postPayloads: any[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-leaderboard/messages')) {
        const payload = await readDiscordMultipartPayload(init)
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: 'leaderboard-message-1' }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await seedDuelRating(db, '100010000000000003', 9)
      await rebuildLeaderboardModeSnapshot(db, kv, 'duel', NOW)

      await db
        .update(playerRatings)
        .set({ gamesPlayed: 10, wins: 10, lastPlayedAt: NOW + 1 })
        .where(eq(playerRatings.playerId, '100010000000000003'))
      await markLeaderboardsDirty(db, 'test-report', { modes: ['duel'], now: NOW + 10 * 60 * 1000 })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel'],
        now: NOW + 10 * 60 * 1000,
      })
      const snapshot = await getStoredLeaderboardModeSnapshot(kv, 'duel')
      const dirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(refreshed).toBe(true)
      expect(snapshot?.rows.find(row => row.playerId === '100010000000000003')?.gamesPlayed).toBe(10)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duel.png')
      expect(dirtyRows).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('dirty refresh rebuilds and updates configured civ leaderboards', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:civ-leaderboard', 'channel-civ')

    const postPayloads: any[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-civ/messages')) {
        const payload = JSON.parse(String(init.body))
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: 'civ-message-1' }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await db.insert(players).values({
        id: '100010000000000004',
        displayName: 'Civ Player',
        avatarUrl: null,
        createdAt: NOW,
      })
      await seedCompletedLeaderMatch(db, 'civ-match-1', '100010000000000004', 'rome-trajan', 1)
      await backfillCivLeaderboardStatsFromHistory(db, NOW)
      await rebuildCivLeaderboardSnapshot(db, kv, NOW)
      await seedCompletedLeaderMatch(db, 'civ-match-2', '100010000000000004', 'rome-trajan', 2)
      await markLeaderboardsDirty(db, 'test-report', { civ: true, now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', { modes: ['duel'] })
      const snapshot = await getStoredCivLeaderboardSnapshot(kv)
      const dirtyRows = await db.select().from(leaderboardDirtyStates)
      const civState = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, 'civ')).limit(1)

      expect(refreshed).toBe(true)
      expect(snapshot?.rows.find(row => row.civId === 'rome-trajan')?.picks).toBe(2)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].embeds).toHaveLength(3)
      expect(JSON.stringify(postPayloads[0].embeds)).toContain('Top Banned Leaders')
      expect(civState[0]?.messageId).toBe('civ-message-1')
      expect(dirtyRows).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('dirty civ refresh waits for historical backfill and keeps dirty state', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:civ-leaderboard', 'channel-civ')

    const postPayloads: any[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-civ/messages')) {
        postPayloads.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ id: 'civ-message-1' }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await db.insert(players).values({
        id: '100010000000000005',
        displayName: 'Civ Player 2',
        avatarUrl: null,
        createdAt: NOW,
      })
      await seedCompletedLeaderMatch(db, 'civ-match-uninitialized', '100010000000000005', 'rome-trajan', 1)
      await markLeaderboardsDirty(db, 'test-report', { civ: true, now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', { modes: ['duel'] })
      const snapshot = await getStoredCivLeaderboardSnapshot(kv)
      const dirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(refreshed).toBe(false)
      expect(snapshot).toBeNull()
      expect(postPayloads).toHaveLength(0)
      expect(dirtyRows.map(row => row.scope)).toEqual(['civ'])
    }
    finally {
      sqlite.close()
    }
  })
})

async function readDiscordMultipartPayload(init: RequestInit): Promise<any> {
  if (!(init.body instanceof FormData)) return JSON.parse(String(init.body))
  const payload = init.body.get('payload_json')
  return JSON.parse(String(payload))
}

async function seedDuelRating(db: Database, playerId: string, gamesPlayed: number): Promise<void> {
  await db.insert(players).values({
    id: playerId,
    displayName: playerId,
    avatarUrl: null,
    createdAt: NOW,
  })
  await db.insert(playerRatings).values({
    playerId,
    mode: 'duel',
    mu: 30,
    sigma: 6,
    gamesPlayed,
    wins: gamesPlayed,
    lastPlayedAt: NOW,
  })
}

async function seedCompletedLeaderMatch(
  db: Database,
  matchId: string,
  playerId: string,
  civId: string,
  placement: number,
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    gameMode: 'ffa',
    status: 'completed',
    isOld: false,
    seasonId: null,
    draftData: JSON.stringify({ state: { bans: [{ civId }] } }),
    createdAt: NOW,
    completedAt: NOW,
  })
  await db.insert(matchParticipants).values({
    matchId,
    playerId,
    team: null,
    civId,
    placement,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  })
  await reconcileCivLeaderboardMatchContribution(db, matchId)
}

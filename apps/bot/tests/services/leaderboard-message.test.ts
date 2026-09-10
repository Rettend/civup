import type { Database } from '@civup/db'
import { leaderboardDecaySchedules, leaderboardDirtyStates, leaderboardMessageStates, matches, matchParticipants, playerRatings, players, publicRatingDecayPolicies, seasons, seasonRatingStates, seasonPeakRanks } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { backfillCivLeaderboardStatsFromHistory, civLeaderboardSnapshotKey, getStoredCivLeaderboardSnapshot, rebuildCivLeaderboardSnapshot, reconcileCivLeaderboardMatchContribution } from '../../src/services/leaderboard/civ-snapshot.ts'
import { archiveSeasonLeaderboards, markLeaderboardsDirty, refreshDirtyLeaderboards, upsertCivLeaderboardMessageForChannel, upsertLeaderboardMessagesForChannel } from '../../src/services/leaderboard/message.ts'
import { ensureLeaderboardModeSnapshot, getStoredLeaderboardModeSnapshot, leaderboardModeSnapshotKey, rebuildLeaderboardModeSnapshot } from '../../src/services/leaderboard/snapshot.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'
import { buildPlayerLeaderboardImageDataBatch } from '../../src/services/leaderboard/image.ts'
import { attachLobbyBalanceRatingsToSnapshot, type LobbySnapshot } from '../../src/services/activity/session-state.ts'

const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch

describe('leaderboard message service', () => {
  test('an expired decay clock refreshes without a report and preserves reports arriving during publication', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await kv.put('system:channel:leaderboard', 'channel')
      await db.insert(leaderboardDecaySchedules).values({ mode: 'duel', updatedAt: NOW - 100, nextDecayAt: NOW - 1 })
      globalThis.fetch = (async (_input, init) => {
        expect(init?.method).toBe('POST')
        await markLeaderboardsDirty(db, 'new-report', { modes: ['duel'], now: NOW + 1 })
        return Response.json({ id: 'new-message' })
      }) as typeof fetch
      expect(await refreshDirtyLeaderboards(db, kv, 'token', { now: NOW, playerModeLimit: 1 })).toBe(true)
      expect(await db.select().from(leaderboardDirtyStates)).toEqual([{ scope: 'player:duel', dirtyAt: NOW + 1, reason: 'new-report' }])
    }
    finally { sqlite.close() }
  })
  test('idle decay scheduling uses D1 without KV reads and refreshes its deadline from projected RP', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const day = 86_400_000
    try {
      await db.update(publicRatingDecayPolicies).set({ enabledAt: NOW })
      await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: NOW, active: true, ratingSystem: 'rp', publicReadsEnabled: true })
      await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: NOW })
      await db.insert(playerRatings).values({ playerId: 'p', mode: 'duel', mu: 40, sigma: 3, publicRating: 1600 })
      await rebuildLeaderboardModeSnapshot(db, kv, 'duel', NOW)
      expect((await db.select().from(leaderboardDecaySchedules))[0]?.nextDecayAt).toBe(NOW + 60 * day)
      const noKv = new Proxy(kv, { get() { throw new Error('Idle decay must not access KV') } })
      expect(await refreshDirtyLeaderboards(db, noKv, 'token', { now: NOW + 59 * day })).toBe(false)
      const refreshed = await rebuildLeaderboardModeSnapshot(db, kv, 'duel', NOW + 61 * day)
      expect(refreshed.rows[0]?.publicRating).toBe(1598)
      expect((await db.select().from(leaderboardDecaySchedules))[0]?.nextDecayAt).toBe(NOW + 62 * day)
    }
    finally { sqlite.close() }
  })
  test('Activity cache keeps lifetime balance evidence separate from season results and preserves history without mode games', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(seasons).values([
        { id: 's8', name: 'Season 8', seasonNumber: 8, startsAt: NOW - 1000, active: false },
        { id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: NOW, active: true, ratingSystem: 'rp', publicReadsEnabled: true },
      ])
      await db.insert(players).values(['experienced', 'new-to-duel'].map(id => ({ id, displayName: id, createdAt: NOW })))
      await db.insert(seasonPeakRanks).values({ seasonId: 's8', playerId: 'new-to-duel', tier: 'tier2', achievedAt: NOW - 1 })
      await db.insert(playerRatings).values({ playerId: 'experienced', mode: 'duel', mu: 30, sigma: 3, gamesPlayed: 40, wins: 30, publicRating: 1300 })
      await db.insert(seasonRatingStates).values({ seasonId: 's9', playerId: 'experienced', mode: 'duel', mu: 30, sigma: 3, publicRating: 1300, seasonGames: 2, seasonWins: 1, evidence: {}, updatedAt: NOW })
      await rebuildLeaderboardModeSnapshot(db, kv, 'duel', NOW)
      const stored = await getStoredLeaderboardModeSnapshot(kv, 'duel')
      expect(stored?.rows[0]).toMatchObject({ gamesPlayed: 40, wins: 30, seasonGames: 2, seasonWins: 1 })
      const lobby = { draftConfig: {}, entries: [{ playerId: 'experienced' }, { playerId: 'new-to-duel' }] } as LobbySnapshot
      const attached = await attachLobbyBalanceRatingsToSnapshot(kv, '1v1', lobby, stored)
      expect(attached.entries[0]?.balanceRating).toMatchObject({ rank: 1, gamesPlayed: 40, wins: 30, seasonGames: 2, seasonWins: 1, seasonNumber: 9 })
      expect(attached.entries[1]?.balanceRating).toMatchObject({ rank: null, gamesPlayed: 0, publicRating: 750, pastRanks: [{ seasonNumber: 8, tier: 'tier2' }] })
    }
    finally { sqlite.close() }
  })
  test('RP boards retain opening standings but display only selected-season game totals', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: NOW, active: true, ratingSystem: 'rp', publicReadsEnabled: true })
      await db.insert(players).values({ id: 'player', displayName: 'Player', createdAt: NOW })
      await db.insert(seasonRatingStates).values({ seasonId: 's9', playerId: 'player', mode: 'duo', mu: 25, sigma: 3, publicRating: 1200, seasonGames: 0, seasonWins: 0, evidence: {}, updatedAt: NOW })
      const input = [{ mode: 'duo' as const, rows: [{ playerId: 'player', mode: 'duo' as const, mu: 25, sigma: 3, publicRating: 1200, gamesPlayed: 100, wins: 60, lastPlayedAt: NOW }] }]
      const [opening] = await buildPlayerLeaderboardImageDataBatch(db, input)
      expect(opening!.rows[0]).toMatchObject({ displayRating: 1200, gamesPlayed: 0, wins: 0, winRate: 0 })
      await db.update(seasonRatingStates).set({ seasonGames: 2, seasonWins: 1 })
      const [played] = await buildPlayerLeaderboardImageDataBatch(db, input)
      expect(played!.rows[0]).toMatchObject({ gamesPlayed: 2, wins: 1, winRate: 0.5 })
      const [legacy] = await buildPlayerLeaderboardImageDataBatch(db, input.map(item => ({ ...item, options: { ratingSystem: 'legacy' as const } })))
      expect(legacy!.rows[0]).toMatchObject({ gamesPlayed: 100, wins: 60, winRate: 0.6 })
    }
    finally { sqlite.close() }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('new season and BBG boards retain old messages and update only their new period on retry', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: NOW, active: true, ratingSystem: 'rp', publicReadsEnabled: true })
      await db.insert(leaderboardMessageStates).values(['player:duel', 'civ:duel', 'civ:duel:2'].map(scope => ({ scope, channelId: 'channel', messageId: `old-${scope}`, updatedAt: NOW })))
      await kv.put(civLeaderboardSnapshotKey('duel'), JSON.stringify({ updatedAt: NOW, historyInitialized: true, label: 'BBG 7.5.0', periodId: 'release-1', modeScope: 'duel', completedMatchCount: 1, rows: [] }))
      let created = 0
      let edited = 0
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).not.toContain('old-')
        expect(init?.method).not.toBe('DELETE')
        if (init?.method === 'POST') return new Response(JSON.stringify({ id: `new-${++created}` }), { status: 200 })
        if (init?.method === 'PATCH') { edited++; return new Response('{}', { status: 200 }) }
        throw new Error(`Unexpected request: ${input}`)
      }) as typeof fetch
      for (let i = 0; i < 2; i++) {
        await upsertLeaderboardMessagesForChannel(db, kv, 'token', 'channel', { modes: ['duel'] })
        await upsertCivLeaderboardMessageForChannel(db, kv, 'token', 'channel', { modeScope: 'duel' })
      }
      expect(created).toBeGreaterThanOrEqual(2)
      expect(edited).toBe(created)
      expect((await db.select().from(leaderboardMessageStates)).filter(row => row.messageId.startsWith('old-'))).toHaveLength(3)
    }
    finally { sqlite.close() }
  })

  test('advances an existing dirty scope when later matches are reported', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await markLeaderboardsDirty(db, 'first-report', { modes: ['duel'], now: NOW })
      await markLeaderboardsDirty(db, 'later-report', { modes: ['duel'], now: NOW + 100 })
      await markLeaderboardsDirty(db, 'out-of-order-report', { modes: ['duel'], now: NOW + 50 })

      const rows = await db.select().from(leaderboardDirtyStates)
      expect(rows).toEqual([{
        scope: 'player:duel',
        dirtyAt: NOW + 100,
        reason: 'later-report',
      }])
    }
    finally {
      sqlite.close()
    }
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

  test('older player snapshot versions rebuild from D1', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelRating(db, '100010000000000002', 10)
      await kv.put(leaderboardModeSnapshotKey('duel'), JSON.stringify({
        version: 3,
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

  test('unarchives a leaderboard thread and retries the message update', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-leaderboard')

    let messageEditAttempts = 0
    const requests: Array<{ method: string, path: string, body: unknown }> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body instanceof FormData
        ? JSON.parse(String(init.body.get('payload_json')))
        : init?.body ? JSON.parse(String(init.body)) : null
      requests.push({ method, path: url.pathname, body })

      if (method === 'PATCH' && url.pathname === '/api/v10/channels/channel-leaderboard') {
        return Response.json({ id: 'channel-leaderboard', archived: false })
      }
      if (method === 'PATCH' && url.pathname === '/api/v10/channels/channel-leaderboard/messages/leaderboard-message-1') {
        messageEditAttempts += 1
        if (messageEditAttempts === 1) {
          return Response.json({ message: 'Thread is archived', code: 50083 }, { status: 400 })
        }
        return Response.json({ id: 'leaderboard-message-1' })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await seedDuelRating(db, '100010000000000037', 10)
      await rebuildLeaderboardModeSnapshot(db, kv, 'duel', NOW)
      await db.insert(leaderboardMessageStates).values({
        scope: 'player:duel',
        channelId: 'channel-leaderboard',
        messageId: 'leaderboard-message-1',
        updatedAt: NOW,
      })
      await markLeaderboardsDirty(db, 'test-report', { modes: ['duel'], now: NOW + 1 })

      await expect(refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel'],
        now: NOW + 1,
      })).resolves.toBe(true)

      expect(requests.map(request => `${request.method} ${request.path}`)).toEqual([
        'PATCH /api/v10/channels/channel-leaderboard/messages/leaderboard-message-1',
        'PATCH /api/v10/channels/channel-leaderboard',
        'PATCH /api/v10/channels/channel-leaderboard/messages/leaderboard-message-1',
      ])
      expect(requests[1]?.body).toEqual({ archived: false })
    }
    finally {
      sqlite.close()
    }
  })

  test('dirty refresh processes one player mode when limited', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-leaderboard')

    const postPayloads: any[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-leaderboard/messages')) {
        const payload = await readDiscordMultipartPayload(init)
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: `leaderboard-message-${postPayloads.length}` }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await db.insert(players).values([
        { id: '100010000000000030', displayName: 'Duel Player', avatarUrl: null, createdAt: NOW },
        { id: '100010000000000031', displayName: 'Duo Player', avatarUrl: null, createdAt: NOW },
      ])
      await db.insert(playerRatings).values([
        { playerId: '100010000000000030', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 10, lastPlayedAt: NOW },
        { playerId: '100010000000000031', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 10, wins: 8, lastPlayedAt: NOW },
      ])
      await markLeaderboardsDirty(db, 'test-batch', { modes: ['duel', 'duo'], now: NOW })

      const firstRefresh = await refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel', 'duo'],
        now: NOW,
        playerModeLimit: 1,
      })
      const firstDirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(firstRefresh).toBe(true)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duel.png')
      expect(firstDirtyRows.map(row => row.scope)).toEqual(['player:duo'])

      const secondRefresh = await refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel', 'duo'],
        now: NOW,
        playerModeLimit: 1,
      })
      const secondDirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(secondRefresh).toBe(true)
      expect(postPayloads).toHaveLength(2)
      expect(postPayloads[1].attachments?.[0]?.filename).toBe('leaderboard-duo.png')
      expect(secondDirtyRows).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('limited dirty refresh processes oldest player mode first', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-leaderboard')

    const postPayloads: any[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-leaderboard/messages')) {
        const payload = await readDiscordMultipartPayload(init)
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: `leaderboard-message-${postPayloads.length}` }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await db.insert(players).values([
        { id: '100010000000000034', displayName: 'Newer Duel Player', avatarUrl: null, createdAt: NOW },
        { id: '100010000000000035', displayName: 'Older Duo Player', avatarUrl: null, createdAt: NOW },
      ])
      await db.insert(playerRatings).values([
        { playerId: '100010000000000034', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 10, lastPlayedAt: NOW },
        { playerId: '100010000000000035', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 10, wins: 8, lastPlayedAt: NOW },
      ])
      await markLeaderboardsDirty(db, 'older-duo', { modes: ['duo'], now: NOW })
      await markLeaderboardsDirty(db, 'newer-duel', { modes: ['duel'], now: NOW + 1 })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel', 'duo'],
        now: NOW + 2,
        playerModeLimit: 1,
      })
      const dirtyScopes = (await db.select().from(leaderboardDirtyStates)).map(row => row.scope).sort()

      expect(refreshed).toBe(true)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duo.png')
      expect(dirtyScopes).toEqual(['player:duel'])
    }
    finally {
      sqlite.close()
    }
  })

  test('civ dirty scopes are narrowed from leaderboard mode', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await markLeaderboardsDirty(db, 'duel-civ', { civ: true, modes: ['duel'], now: NOW })

      const dirtyScopes = (await db.select().from(leaderboardDirtyStates)).map(row => row.scope).sort()
      expect(dirtyScopes).toEqual(['civ:all', 'civ:duel', 'player:duel'])
    }
    finally {
      sqlite.close()
    }
  })

  test('dirty refresh reuses fresh player snapshot before updating message', async () => {
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
      await seedDuelRating(db, '100010000000000036', 10)
      await rebuildLeaderboardModeSnapshot(db, kv, 'duel', NOW + 100)
      await markLeaderboardsDirty(db, 'test-report', { modes: ['duel'], now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel'],
        now: NOW + 200,
        playerModeLimit: 1,
      })
      const snapshot = await getStoredLeaderboardModeSnapshot(kv, 'duel')
      const dirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(refreshed).toBe(true)
      expect(snapshot?.updatedAt).toBe(NOW + 100)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duel.png')
      expect(dirtyRows).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('limited legacy dirty refresh keeps unprocessed player modes queued', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:leaderboard', 'channel-leaderboard')

    const postPayloads: any[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/channels/channel-leaderboard/messages')) {
        const payload = await readDiscordMultipartPayload(init)
        postPayloads.push(payload)
        return new Response(JSON.stringify({ id: `leaderboard-message-${postPayloads.length}` }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await db.insert(players).values([
        { id: '100010000000000032', displayName: 'Legacy Duel Player', avatarUrl: null, createdAt: NOW },
        { id: '100010000000000033', displayName: 'Legacy Duo Player', avatarUrl: null, createdAt: NOW },
      ])
      await db.insert(playerRatings).values([
        { playerId: '100010000000000032', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 10, lastPlayedAt: NOW },
        { playerId: '100010000000000033', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 10, wins: 8, lastPlayedAt: NOW },
      ])
      await markLeaderboardsDirty(db, 'legacy-test')

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', {
        modes: ['duel', 'duo'],
        now: NOW,
        playerModeLimit: 1,
      })
      const dirtyScopes = (await db.select().from(leaderboardDirtyStates)).map(row => row.scope).sort()

      expect(refreshed).toBe(true)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duel.png')
      expect(dirtyScopes).toEqual(['civ:all', 'civ:duel', 'civ:duo', 'civ:squad', 'player:duo'])
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

  test('dirty refresh updates each configured civ leaderboard scope', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await kv.put('system:channel:civ-leaderboard-all', 'channel-civ-all')
    await kv.put('system:channel:civ-leaderboard-duel', 'channel-civ-duel')
    await kv.put('system:channel:civ-leaderboard-duo', 'channel-civ-duo')
    await kv.put('system:channel:civ-leaderboard-squad', 'channel-civ-squad')

    const postPayloads: Array<{ channelId: string, payload: any }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const match = url.match(/\/channels\/(channel-civ-[^/]+)\/messages/)
      if (init?.method === 'POST' && match) {
        const payload = JSON.parse(String(init.body))
        postPayloads.push({ channelId: match[1]!, payload })
        return new Response(JSON.stringify({ id: `civ-message-${postPayloads.length}` }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    try {
      await db.insert(players).values({
        id: '100010000000000006',
        displayName: 'Civ Player 3',
        avatarUrl: null,
        createdAt: NOW,
      })
      await seedCompletedLeaderMatch(db, 'civ-scope-match', '100010000000000006', 'rome-trajan', 1)
      await backfillCivLeaderboardStatsFromHistory(db, NOW)
      await markLeaderboardsDirty(db, 'test-report', { civ: true, now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', { modes: ['duel'] })
      const messageScopes = (await db.select().from(leaderboardMessageStates)).map(row => row.scope).sort()
      const dirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(refreshed).toBe(true)
      expect(postPayloads.map(row => row.channelId).sort()).toEqual(['channel-civ-all', 'channel-civ-duel', 'channel-civ-duo', 'channel-civ-squad'])
      expect(postPayloads.every(row => row.payload.embeds?.length === 3)).toBe(true)
      expect(messageScopes).toEqual(['civ', 'civ:duel', 'civ:duo', 'civ:squad'])
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
      expect(dirtyRows.map(row => row.scope).sort()).toEqual(['civ:all', 'civ:duel', 'civ:duo', 'civ:squad'])
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

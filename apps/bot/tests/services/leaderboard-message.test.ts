import type { Database } from '@civup/db'
import { leaderboardDirtyStates, leaderboardMessageStates, matches, matchParticipants, players, scopedPlayerRatings as playerRatings, seasons } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { backfillCivLeaderboardStatsFromHistory as backfillCivLeaderboardStatsFromHistorySource, getStoredCivLeaderboardSnapshot as getStoredCivLeaderboardSnapshotSource, rebuildCivLeaderboardSnapshot as rebuildCivLeaderboardSnapshotSource, reconcileCivLeaderboardMatchContribution as reconcileCivLeaderboardMatchContributionSource } from '../../src/services/leaderboard/civ-snapshot.ts'
import { archiveSeasonLeaderboards as archiveSeasonLeaderboardsSource, markLeaderboardsDirty as markLeaderboardsDirtySource, refreshDirtyLeaderboards as refreshDirtyLeaderboardsSource, upsertLeaderboardMessagesForChannel as upsertLeaderboardMessagesForChannelSource } from '../../src/services/leaderboard/message.ts'
import { ensureLeaderboardModeSnapshot as ensureLeaderboardModeSnapshotSource, getStoredLeaderboardModeSnapshot as getStoredLeaderboardModeSnapshotSource, leaderboardModeSnapshotKey as leaderboardModeSnapshotKeySource, rebuildLeaderboardModeSnapshot as rebuildLeaderboardModeSnapshotSource } from '../../src/services/leaderboard/snapshot.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const GUILD_ID = '111111111111111111'
const STATS_CONTEXT = createStatsContext(GUILD_ID, GUILD_ID)
const PRIMARY_CHANNEL_SCOPE = { guildId: GUILD_ID, legacyGuildId: GUILD_ID }
const originalFetch = globalThis.fetch
const playerDirtyScope = (mode: string) => `stats:dirty:${STATS_CONTEXT.statsKey}:player:${mode}`
const playerMessageScope = (mode: string) => `leaderboard:message:${GUILD_ID}:${STATS_CONTEXT.statsKey}:player:${mode}:1`
const civDirtyScope = (mode: string) => `stats:dirty:${STATS_CONTEXT.statsKey}:civ:${mode}`
const civMessageScope = (mode: string) => `leaderboard:message:${GUILD_ID}:${STATS_CONTEXT.statsKey}:civ:${mode}:1`

const markLeaderboardsDirty = (db: Database, reason: string, options?: Parameters<typeof markLeaderboardsDirtySource>[3]) => markLeaderboardsDirtySource(db, STATS_CONTEXT, reason, options)
const archiveSeasonLeaderboards = (db: Database, kv: KVNamespace, token: string, seasonName: string, options: Omit<Parameters<typeof archiveSeasonLeaderboardsSource>[4], 'statsContext'>) => archiveSeasonLeaderboardsSource(db, kv, token, seasonName, { ...options, statsContext: STATS_CONTEXT })
const refreshDirtyLeaderboards = (db: Database, kv: KVNamespace, token: string, options: Omit<Parameters<typeof refreshDirtyLeaderboardsSource>[3], 'statsContext'>) => refreshDirtyLeaderboardsSource(db, kv, token, { ...options, statsContext: STATS_CONTEXT })
const upsertLeaderboardMessagesForChannel = (db: Database, kv: KVNamespace, token: string, channelId: string, options: Omit<Parameters<typeof upsertLeaderboardMessagesForChannelSource>[4], 'statsContext' | 'publicationGuildId'>) => upsertLeaderboardMessagesForChannelSource(db, kv, token, channelId, { ...options, statsContext: STATS_CONTEXT, publicationGuildId: GUILD_ID })
const leaderboardModeSnapshotKey = (mode: Parameters<typeof leaderboardModeSnapshotKeySource>[1]) => leaderboardModeSnapshotKeySource(STATS_CONTEXT, mode)
const ensureLeaderboardModeSnapshot = (db: Database, kv: KVNamespace, mode: Parameters<typeof ensureLeaderboardModeSnapshotSource>[3]) => ensureLeaderboardModeSnapshotSource(db, kv, STATS_CONTEXT, mode)
const getStoredLeaderboardModeSnapshot = (kv: KVNamespace, mode: Parameters<typeof getStoredLeaderboardModeSnapshotSource>[2]) => getStoredLeaderboardModeSnapshotSource(kv, STATS_CONTEXT, mode)
const rebuildLeaderboardModeSnapshot = (db: Database, kv: KVNamespace, mode: Parameters<typeof rebuildLeaderboardModeSnapshotSource>[3], updatedAt?: number) => rebuildLeaderboardModeSnapshotSource(db, kv, STATS_CONTEXT, mode, updatedAt)
const backfillCivLeaderboardStatsFromHistory = (db: Database, updatedAt?: number) => backfillCivLeaderboardStatsFromHistorySource(db, STATS_CONTEXT, updatedAt)
const getStoredCivLeaderboardSnapshot = (kv: KVNamespace) => getStoredCivLeaderboardSnapshotSource(kv, STATS_CONTEXT)
const rebuildCivLeaderboardSnapshot = (db: Database, kv: KVNamespace, updatedAt?: number) => rebuildCivLeaderboardSnapshotSource(db, kv, STATS_CONTEXT, updatedAt)
const reconcileCivLeaderboardMatchContribution = (db: Database, matchId: string) => reconcileCivLeaderboardMatchContributionSource(db, STATS_CONTEXT, matchId)

describe('leaderboard message service', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('advances an existing dirty scope when later matches are reported', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await markLeaderboardsDirty(db, 'first-report', { modes: ['duel'], now: NOW })
      await markLeaderboardsDirty(db, 'later-report', { modes: ['duel'], now: NOW + 100 })
      await markLeaderboardsDirty(db, 'out-of-order-report', { modes: ['duel'], now: NOW + 50 })

      const rows = await db.select().from(leaderboardDirtyStates)
      expect(rows).toEqual([{
        scope: playerDirtyScope('duel'),
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
      statsKey: STATS_CONTEXT.statsKey,
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
    await archiveSeasonLeaderboards(db, kv, 'token', 'Season 9', { channelScope: PRIMARY_CHANNEL_SCOPE, modes: ['ffa'] })

    expect(postPayloads).toHaveLength(2)
    expect(patchPayloads).toHaveLength(1)
    expect(patchPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-ffa.png')
    expect(postPayloads[1].attachments?.[0]?.filename).toBe('leaderboard-ffa.png')

    const [state] = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, playerMessageScope('ffa'))).limit(1)
    expect(state?.messageId).toBe('message-2')

    sqlite.close()
  })

  test('older player snapshot versions rebuild from D1', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedDuelRating(db, '100010000000000002', 10)
      await kv.put(leaderboardModeSnapshotKey('duel'), JSON.stringify({
        version: 2,
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
        channelScope: PRIMARY_CHANNEL_SCOPE,
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
        scope: playerMessageScope('duel'),
        channelId: 'channel-leaderboard',
        messageId: 'leaderboard-message-1',
        updatedAt: NOW,
      })
      await markLeaderboardsDirty(db, 'test-report', { modes: ['duel'], now: NOW + 1 })

      await expect(refreshDirtyLeaderboards(db, kv, 'token', {
        channelScope: PRIMARY_CHANNEL_SCOPE,
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
        { statsKey: STATS_CONTEXT.statsKey, playerId: '100010000000000030', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 10, lastPlayedAt: NOW },
        { statsKey: STATS_CONTEXT.statsKey, playerId: '100010000000000031', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 10, wins: 8, lastPlayedAt: NOW },
      ])
      await markLeaderboardsDirty(db, 'test-batch', { modes: ['duel', 'duo'], now: NOW })

      const firstRefresh = await refreshDirtyLeaderboards(db, kv, 'token', {
        channelScope: PRIMARY_CHANNEL_SCOPE,
        modes: ['duel', 'duo'],
        now: NOW,
        playerModeLimit: 1,
      })
      const firstDirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(firstRefresh).toBe(true)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duel.png')
      expect(firstDirtyRows.map(row => row.scope)).toEqual([playerDirtyScope('duo')])

      const secondRefresh = await refreshDirtyLeaderboards(db, kv, 'token', {
        channelScope: PRIMARY_CHANNEL_SCOPE,
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
        { statsKey: STATS_CONTEXT.statsKey, playerId: '100010000000000034', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 10, lastPlayedAt: NOW },
        { statsKey: STATS_CONTEXT.statsKey, playerId: '100010000000000035', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 10, wins: 8, lastPlayedAt: NOW },
      ])
      await markLeaderboardsDirty(db, 'older-duo', { modes: ['duo'], now: NOW })
      await markLeaderboardsDirty(db, 'newer-duel', { modes: ['duel'], now: NOW + 1 })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', {
        channelScope: PRIMARY_CHANNEL_SCOPE,
        modes: ['duel', 'duo'],
        now: NOW + 2,
        playerModeLimit: 1,
      })
      const dirtyScopes = (await db.select().from(leaderboardDirtyStates)).map(row => row.scope).sort()

      expect(refreshed).toBe(true)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duo.png')
      expect(dirtyScopes).toEqual([playerDirtyScope('duel')])
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
      expect(dirtyScopes).toEqual([civDirtyScope('all'), civDirtyScope('duel'), playerDirtyScope('duel')].sort())
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
        channelScope: PRIMARY_CHANNEL_SCOPE,
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
        { statsKey: STATS_CONTEXT.statsKey, playerId: '100010000000000032', mode: 'duel', mu: 30, sigma: 5, gamesPlayed: 10, wins: 10, lastPlayedAt: NOW },
        { statsKey: STATS_CONTEXT.statsKey, playerId: '100010000000000033', mode: 'duo', mu: 31, sigma: 5, gamesPlayed: 10, wins: 8, lastPlayedAt: NOW },
      ])
      await markLeaderboardsDirty(db, 'legacy-test')

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', {
        channelScope: PRIMARY_CHANNEL_SCOPE,
        modes: ['duel', 'duo'],
        now: NOW,
        playerModeLimit: 1,
      })
      const dirtyScopes = (await db.select().from(leaderboardDirtyStates)).map(row => row.scope).sort()

      expect(refreshed).toBe(true)
      expect(postPayloads).toHaveLength(1)
      expect(postPayloads[0].attachments?.[0]?.filename).toBe('leaderboard-duel.png')
      expect(dirtyScopes).toEqual([
        playerDirtyScope('duo'),
        playerDirtyScope('ffa'),
        playerDirtyScope('red-death'),
        playerDirtyScope('squad'),
      ].sort())
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
      await markLeaderboardsDirty(db, 'test-report', { civ: true, modes: [], now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', { channelScope: PRIMARY_CHANNEL_SCOPE, modes: [] })
      const snapshot = await getStoredCivLeaderboardSnapshot(kv)
      const dirtyRows = await db.select().from(leaderboardDirtyStates)
      const civState = await db.select().from(leaderboardMessageStates).where(eq(leaderboardMessageStates.scope, civMessageScope('all'))).limit(1)

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
      await seedCompletedLeaderMatch(db, 'civ-scope-duo-match', '100010000000000006', 'rome-trajan', 1, '2v2')
      await seedCompletedLeaderMatch(db, 'civ-scope-squad-match', '100010000000000006', 'rome-trajan', 1, '3v3')
      await backfillCivLeaderboardStatsFromHistory(db, NOW)
      await markLeaderboardsDirty(db, 'test-report', { civ: true, modes: [], now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', { channelScope: PRIMARY_CHANNEL_SCOPE, modes: [] })
      const messageScopes = (await db.select().from(leaderboardMessageStates)).map(row => row.scope).sort()
      const dirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(refreshed).toBe(true)
      expect(postPayloads.map(row => row.channelId).sort()).toEqual(['channel-civ-all', 'channel-civ-duel', 'channel-civ-duo', 'channel-civ-squad'])
      expect(postPayloads.every(row => row.payload.embeds?.length === 3)).toBe(true)
      expect(messageScopes).toEqual(['all', 'duel', 'duo', 'squad'].map(civMessageScope).sort())
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
      await markLeaderboardsDirty(db, 'test-report', { civ: true, modes: [], now: NOW })

      const refreshed = await refreshDirtyLeaderboards(db, kv, 'token', { channelScope: PRIMARY_CHANNEL_SCOPE, modes: [] })
      const snapshot = await getStoredCivLeaderboardSnapshot(kv)
      const dirtyRows = await db.select().from(leaderboardDirtyStates)

      expect(refreshed).toBe(false)
      expect(snapshot).toBeNull()
      expect(postPayloads).toHaveLength(0)
      expect(dirtyRows.map(row => row.scope).sort()).toEqual(['all', 'duel', 'duo', 'squad'].map(civDirtyScope).sort())
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
    statsKey: STATS_CONTEXT.statsKey,
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
  gameMode = 'ffa',
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    guildId: GUILD_ID,
    gameMode,
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
    sourceGuildId: GUILD_ID,
    sourceKind: 'discord',
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

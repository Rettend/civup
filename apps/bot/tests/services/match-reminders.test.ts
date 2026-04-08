import { matches } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { attachLobbyMatch, createLobby, setLobbyStatus } from '../../src/services/lobby/index.ts'
import { sendOverdueHostReportReminders } from '../../src/services/match/reminders.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('host report reminders', () => {
  test('sends the 3h reminder once for overdue active matches', async () => {
    const now = Date.now()
    const { db, sqlite } = await createTestDatabase()
    const { kv } = createTrackedKv()
    const fetchCalls: Array<{ url: string, body: unknown }> = []

    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })

      if (fetchCalls.length === 1) {
        return new Response(JSON.stringify({ id: 'dm-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ id: `message-${fetchCalls.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const lobby = await createLobby(kv, {
        mode: '2v2',
        guildId: 'guild-1',
        hostId: 'host-1',
        channelId: 'channel-1',
        messageId: 'message-1',
      })
      const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
      await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

      await db.insert(matches).values({
        id: 'match-1',
        gameMode: '2v2',
        status: 'active',
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: now - (3 * 60 * 60 * 1000) - 1,
          hostId: 'host-1',
          state: { seats: [{ playerId: 'host-1' }] },
        }),
        createdAt: now - (4 * 60 * 60 * 1000),
        completedAt: null,
      })

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 1,
        sentCount: 1,
      })

      expect(fetchCalls.map(call => call.url)).toEqual([
        'https://discord.com/api/v10/users/@me/channels',
        'https://discord.com/api/v10/channels/dm-1/messages',
      ])
      expect(fetchCalls[1]?.body).toEqual(expect.objectContaining({
        content: 'Reminder: you have an unreported **2v2** game. Don\'t forget to report it: https://discord.com/channels/guild-1/channel-1/message-1',
      }))

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 0,
        sentCount: 0,
      })
      expect(fetchCalls).toHaveLength(2)
    }
    finally {
      sqlite.close()
    }
  })

  test('sends only the 6h reminder when both thresholds are already overdue', async () => {
    const now = Date.now()
    const { db, sqlite } = await createTestDatabase()
    const { kv } = createTrackedKv()
    const fetchCalls: Array<{ url: string, body: unknown }> = []

    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })

      if (fetchCalls.length === 1) {
        return new Response(JSON.stringify({ id: 'dm-6h' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ id: `message-${fetchCalls.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const lobby = await createLobby(kv, {
        mode: 'ffa',
        guildId: 'guild-2',
        hostId: 'host-2',
        channelId: 'channel-2',
        messageId: 'message-2',
      })
      const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-2', lobby)
      await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

      await db.insert(matches).values({
        id: 'match-2',
        gameMode: 'ffa',
        status: 'active',
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: now - (7 * 60 * 60 * 1000),
          hostId: 'host-2',
          state: { seats: [{ playerId: 'host-2' }] },
        }),
        createdAt: now - (8 * 60 * 60 * 1000),
        completedAt: null,
      })

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 1,
        sentCount: 1,
      })

      expect(fetchCalls[1]?.body).toEqual(expect.objectContaining({
        content: 'Reminder: you still have an unreported **FFA** game. Don\'t forget to report it: https://discord.com/channels/guild-2/channel-2/message-2',
      }))

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 0,
        sentCount: 0,
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('does not mark reminders as sent when delivery fails', async () => {
    const now = Date.now()
    const { db, sqlite } = await createTestDatabase()
    const { kv } = createTrackedKv()

    try {
      const lobby = await createLobby(kv, {
        mode: '1v1',
        guildId: 'guild-fail',
        hostId: 'host-fail',
        channelId: 'channel-fail',
        messageId: 'message-fail',
      })
      const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-fail', lobby)
      await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

      await db.insert(matches).values({
        id: 'match-fail',
        gameMode: '1v1',
        status: 'active',
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: now - (3 * 60 * 60 * 1000) - 1,
          hostId: 'host-fail',
          state: { seats: [{ playerId: 'host-fail' }] },
        }),
        createdAt: now - (4 * 60 * 60 * 1000),
        completedAt: null,
      })

      globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 1,
        sentCount: 0,
      })

      let successAttempt = 0
      globalThis.fetch = (async () => {
        successAttempt += 1
        return new Response(JSON.stringify({ id: successAttempt === 1 ? 'dm-ok' : 'message-ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 1,
        sentCount: 1,
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('limits reminder sends per run', async () => {
    const now = Date.now()
    const { db, sqlite } = await createTestDatabase()
    const { kv } = createTrackedKv()
    const fetchCalls: Array<{ url: string, body: unknown }> = []

    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })

      if (fetchCalls.length % 2 === 1) {
        return new Response(JSON.stringify({ id: `dm-${fetchCalls.length}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ id: `message-${fetchCalls.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      for (let index = 1; index <= 6; index++) {
        const suffix = String(index)
        const lobby = await createLobby(kv, {
          mode: '2v2',
          guildId: `guild-${suffix}`,
          hostId: `host-${suffix}`,
          channelId: `channel-${suffix}`,
          messageId: `message-${suffix}`,
        })
        const draftingLobby = await attachLobbyMatch(kv, lobby.id, `match-${suffix}`, lobby)
        await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

        await db.insert(matches).values({
          id: `match-${suffix}`,
          gameMode: '2v2',
          status: 'active',
          seasonId: null,
          draftData: JSON.stringify({
            completedAt: now - (3 * 60 * 60 * 1000) - 1,
            hostId: `host-${suffix}`,
            state: { seats: [{ playerId: `host-${suffix}` }] },
          }),
          createdAt: now - (4 * 60 * 60 * 1000),
          completedAt: null,
        })
      }

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 4,
        sentCount: 4,
      })

      await expect(sendOverdueHostReportReminders(db, kv, 'token', { now })).resolves.toEqual({
        attemptedCount: 2,
        sentCount: 2,
      })
    }
    finally {
      sqlite.close()
    }
  })
})

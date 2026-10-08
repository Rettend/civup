import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { matches, matchParticipants } from '@civup/db'
import { command_mod } from '../../src/commands/mod.ts'
import { getSessionRecord } from '../../src/session-runtime/session-do-client.ts'
import {
  buildTestLobbyEnv,
  createLobby,
  getExistingTestLobbyRuntime,
  setLobbyMemberPlayerIds,
  startTestSessionDraft,
} from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch
const CANCELLATION_ERROR = 'Could not confirm the cancellation. Check the match before trying again.'

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('/mod match cancel deferred failures', () => {
  test('replies with a safe error when acquiring the rating writer throws', async () => {
    const fixture = await createFixture('drafting')
    const logs = spyOn(console, 'error').mockImplementation(() => {})
    const internalError = new Error('private database failure')
    try {
      const failingDb = new Proxy(fixture.d1, {
        get(target, property) {
          if (property === 'prepare') {
            return (query: string) => {
              if (query.includes('rating_mutation_leases')) throw internalError
              return target.prepare(query)
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const invocation = createInvocation({ ...fixture.env, DB: failingDb }, fixture.lobby.id)

      await invocation.run()

      expect(invocation.replies).toEqual([CANCELLATION_ERROR])
      expect(invocation.replies.join(' ')).not.toContain(internalError.message)
      expect(logs).toHaveBeenCalledWith(`Failed to cancel match ${fixture.lobby.id} by moderator:`, expect.any(Error))
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('draft')
      expect((await fixture.db.select().from(matches))[0]?.status).toBe('drafting')
    } finally {
      logs.mockRestore()
      fixture.sqlite.close()
    }
  })

  test('keeps a deliberately written validation error', async () => {
    const fixture = await createFixture('open')
    try {
      const invocation = createInvocation(fixture.env, 'missing-match')

      await invocation.run()

      expect(invocation.replies).toEqual(['Match **missing-match** not found.'])
    } finally {
      fixture.sqlite.close()
    }
  })

  test('reports saved cancellation when a later tournament lookup fails', async () => {
    const fixture = await createFixture('drafting')
    const logs = spyOn(console, 'error').mockImplementation(() => {})
    const internalError = new Error('private tournament lookup failure')
    let tournamentLookups = 0
    try {
      const failingDb = new Proxy(fixture.d1, {
        get(target, property) {
          if (property === 'prepare') {
            return (query: string) => {
              if (query.includes('from "tournament_matches"') && ++tournamentLookups === 2) throw internalError
              return target.prepare(query)
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const invocation = createInvocation({ ...fixture.env, DB: failingDb }, fixture.lobby.id)

      await invocation.run()

      expect(invocation.replies).toEqual([
        `Match **${fixture.lobby.id}** was cancelled, but its Discord messages could not be updated.`,
      ])
      expect(invocation.replies.join(' ')).not.toContain(internalError.message)
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('cancelled')
      expect((await fixture.db.select().from(matches))[0]?.status).toBe('cancelled')
    } finally {
      logs.mockRestore()
      fixture.sqlite.close()
    }
  })

  test('logs a failed error reply without rejecting the deferred task', async () => {
    const fixture = await createFixture('open')
    const logs = spyOn(console, 'error').mockImplementation(() => {})
    const responseError = new Error('Discord reply unavailable')
    try {
      const invocation = createInvocation(fixture.env, 'missing-match', {
        reply: async () => {
          throw responseError
        },
      })

      await expect(invocation.run()).resolves.toBeUndefined()

      expect(logs).toHaveBeenCalledWith(
        'Failed to send cancellation error response for match missing-match:',
        responseError,
      )
    } finally {
      logs.mockRestore()
      fixture.sqlite.close()
    }
  })

  for (const status of ['open', 'drafting', 'completed'] as const) {
    test(`acknowledges ${status} cancellation before a slow Discord update finishes`, async () => {
      const fixture = await createFixture(status)
      const events: string[] = []
      let releaseDiscord!: () => void
      const pendingDiscord = new Promise<void>(resolve => {
        releaseDiscord = resolve
      })
      globalThis.fetch = (async () => {
        events.push('discord-start')
        await pendingDiscord
        events.push('discord-finish')
        return Response.json({ id: 'message-1', channel_id: 'channel-1' })
      }) as typeof fetch
      const invocation = createInvocation(fixture.env, fixture.lobby.id, {
        reply: async () => {
          events.push('reply')
        },
      })
      try {
        await invocation.run()

        expect(invocation.replies).toHaveLength(1)
        expect(invocation.replies[0]).toContain(
          `Cancelled ${status === 'open' ? 'open lobby' : 'match'} **${fixture.lobby.id}**`,
        )
        expect(events[0]).toBe('reply')
        expect(events).not.toContain('discord-finish')
        expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('cancelled')
        if (status !== 'open') expect((await fixture.db.select().from(matches))[0]?.status).toBe('cancelled')
      } finally {
        releaseDiscord()
        await invocation.tasks.at(-1)
        fixture.sqlite.close()
      }
      expect(events).toContain('discord-finish')
    })
  }

  test('does not replace confirmed cancellation with an error when optional Discord work fails', async () => {
    const fixture = await createFixture('completed')
    const logs = spyOn(console, 'error').mockImplementation(() => {})
    const discordError = new Error('Discord message unavailable')
    globalThis.fetch = (async () => {
      throw discordError
    }) as typeof fetch
    try {
      const invocation = createInvocation(fixture.env, fixture.lobby.id)

      await invocation.run()
      await invocation.tasks.at(-1)

      expect(invocation.replies).toHaveLength(1)
      expect(invocation.replies[0]).toContain(`Cancelled match **${fixture.lobby.id}**`)
      expect(logs).toHaveBeenCalledWith(`Failed to update cancelled embed for match ${fixture.lobby.id}:`, discordError)
      expect(logs).toHaveBeenCalledWith(
        `Failed to post archive cancellation note for match ${fixture.lobby.id}:`,
        discordError,
      )
      expect((await fixture.db.select().from(matches))[0]?.status).toBe('cancelled')
    } finally {
      logs.mockRestore()
      fixture.sqlite.close()
    }
  })
})

async function createFixture(status: 'open' | 'drafting' | 'completed') {
  globalThis.fetch = (async () => Response.json({ id: 'message-1', channel_id: 'channel-1' })) as typeof fetch
  const { db, sqlite } = await createTestDatabase()
  const kv = createTestKv()
  const lobby = await createLobby(kv, {
    id: 'mod-cancel-test',
    mode: '1v1',
    guildId: 'guild-1',
    hostId: 'host',
    channelId: 'channel-1',
    messageId: 'message-1',
    db,
  })
  await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'participant'], lobby)
  if (status !== 'open') {
    await startTestSessionDraft(kv, lobby.id)
    if (status === 'completed') {
      await db.update(matches).set({ status: 'completed', completedAt: Date.now() }).where(eq(matches.id, lobby.id))
      await db.update(matchParticipants).set({ placement: 1 }).where(eq(matchParticipants.matchId, lobby.id))
      await db.update(matchParticipants).set({ placement: 2 }).where(eq(matchParticipants.playerId, 'participant'))
      await kv.put('system:channel:archive', 'archive-channel')
    }
  }
  const runtime = getExistingTestLobbyRuntime(kv)
  return { db, sqlite, kv, lobby, env: buildTestLobbyEnv(kv), d1: runtime.d1, namespace: runtime.sessionNamespace }
}

function createInvocation(
  env: Record<string, unknown>,
  matchId: string,
  options: { reply?: () => Promise<void> } = {},
) {
  const replies: string[] = []
  const tasks: Promise<unknown>[] = []
  let deferred: Promise<void> | undefined
  const context = {
    env,
    sub: { string: 'match cancel' },
    var: { match_id: matchId },
    interaction: {
      guild_id: 'guild-1',
      member: { user: { id: 'moderator', username: 'moderator' }, roles: [], permissions: '8' },
    },
    executionCtx: {
      waitUntil(task: Promise<unknown>) {
        tasks.push(task)
      },
    },
    async followup(data?: unknown) {
      if (!data) return
      await options.reply?.()
      const payload = JSON.parse(JSON.stringify(data)) as { embeds: Array<{ description: string }> }
      replies.push(...payload.embeds.map(embed => embed.description))
    },
    flags: (_flag: string) => ({
      resDefer(callback: (context: unknown) => Promise<void>) {
        deferred = callback(context)
        return Response.json({ type: 5 })
      },
    }),
  }
  return {
    replies,
    tasks,
    async run() {
      const response = await command_mod.handler(context as unknown as Parameters<typeof command_mod.handler>[0])
      expect(await response.json()).toEqual({ type: 5 })
      expect(deferred).toBeDefined()
      await deferred
    },
  }
}

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { matches, sessionDirectory } from '@civup/db'
import { command_match } from '../../src/commands/match/command.ts'
import { command_mod } from '../../src/commands/mod.ts'
import { getLobbyById } from '../../src/services/lobby/index.ts'
import { addModRole } from '../../src/services/permissions/index.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import {
  buildTestLobbyEnv,
  completeTestSessionDraft,
  createLobby,
  getExistingTestLobbyRuntime,
  setLobbyMemberPlayerIds,
  startTestSessionDraft,
} from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch
const MOD_ROLE = '123456789012345678'

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cancel command permissions and lobby lookup', () => {
  for (const actor of ['host', 'participant', 'other-moderator']) {
    test(`/mod match cancel lets a configured moderator cancel as ${actor}`, async () => {
      const fixture = await createFixture()
      try {
        const replies = await invokeCancel(fixture.env, 'mod', actor, fixture.lobby.id, [MOD_ROLE])
        expect(replies).toContain(`Cancelled open lobby **${fixture.lobby.id}**.`)
        expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('cancelled')
      } finally {
        fixture.sqlite.close()
      }
    })
  }

  for (const phase of ['drafting', 'active']) {
    test(`/mod match cancel lets a moderator participant cancel a ${phase} match`, async () => {
      const fixture = await createFixture()
      try {
        await startTestSessionDraft(fixture.kv, fixture.lobby.id)
        if (phase === 'active') {
          await completeTestSessionDraft(fixture.kv, fixture.lobby.id)
          await runSessionDraftLifecycleCommand(fixture.namespace, fixture.lobby.id, { type: 'draft-finalized' })
          await fixture.db.update(matches).set({ status: 'active' }).where(eq(matches.id, fixture.lobby.id))
        }
        const [before] = await fixture.db.select().from(matches).where(eq(matches.id, fixture.lobby.id))
        expect(before?.status).toBe(phase)

        const replies = await invokeCancel(fixture.env, 'mod', 'participant', fixture.lobby.id, [MOD_ROLE])
        expect(replies.join('\n')).toContain(`Cancelled match **${fixture.lobby.id}** (was ${phase}).`)
        expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('cancelled')
        const [after] = await fixture.db.select().from(matches).where(eq(matches.id, fixture.lobby.id))
        expect(after?.status).toBe('cancelled')
      } finally {
        fixture.sqlite.close()
      }
    })
  }

  test('/match cancel accepts the host with only the current session directory, without legacy KV', async () => {
    const fixture = await createFixture()
    try {
      expect(await getLobbyById(fixture.kv, fixture.lobby.id)).toBeNull()
      const replies = await invokeCancel(fixture.env, 'match', 'host', fixture.lobby.id)
      expect(replies).toContain('Cancelled hosted 1v1 lobby.')
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('cancelled')
    } finally {
      fixture.sqlite.close()
    }
  })

  test('/match cancel produces the screenshot error for a moderator participant who is not the host', async () => {
    const fixture = await createFixture()
    try {
      const replies = await invokeCancel(fixture.env, 'match', 'participant', fixture.lobby.id, [MOD_ROLE])
      expect(replies).toContain('You can only cancel your own hosted lobby or match.')
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('open')
    } finally {
      fixture.sqlite.close()
    }
  })

  test('/mod match cancel rejects an unconfigured role with a moderator permission error', async () => {
    const fixture = await createFixture()
    try {
      const replies = await invokeCancel(fixture.env, 'mod', 'participant', fixture.lobby.id, ['987654321098765432'])
      expect(replies.join('\n')).toContain('configured Mod role')
      expect(replies.join('\n')).not.toContain('own hosted')
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('open')
    } finally {
      fixture.sqlite.close()
    }
  })

  test('/match cancel does not blame host ownership when the lobby cannot be found', async () => {
    const fixture = await createFixture()
    try {
      const replies = await invokeCancel(fixture.env, 'match', 'host', 'missing-lobby', [MOD_ROLE])
      expect(replies).toContain('Could not find that lobby or match.')
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('open')
    } finally {
      fixture.sqlite.close()
    }
  })

  test('/match cancel distinguishes missing directory data from a different host', async () => {
    const fixture = await createFixture()
    try {
      await fixture.db.delete(sessionDirectory).where(eq(sessionDirectory.sessionId, fixture.lobby.id))
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.hostId).toBe('host')
      const replies = await invokeCancel(fixture.env, 'match', 'host', fixture.lobby.id, [MOD_ROLE])
      expect(replies).toContain('Could not find that lobby or match.')
      expect((await getSessionRecord(fixture.namespace, fixture.lobby.id))?.phase).toBe('open')
    } finally {
      fixture.sqlite.close()
    }
  })
})

async function createFixture() {
  const { db, sqlite } = await createTestDatabase()
  const kv = createTestKv()
  await addModRole(kv, 'guild-1', MOD_ROLE)
  const lobby = await createLobby(kv, {
    id: 'cancel-test-lobby',
    mode: '1v1',
    guildId: 'guild-1',
    hostId: 'host',
    channelId: 'channel-1',
    messageId: 'message-1',
    db,
  })
  await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'participant'], lobby)
  // Discord message edits are the only external HTTP calls in these tests.
  globalThis.fetch = (async () => Response.json({ id: 'message-1', channel_id: 'channel-1' })) as typeof fetch
  return {
    db,
    sqlite,
    kv,
    lobby,
    env: buildTestLobbyEnv(kv),
    namespace: getExistingTestLobbyRuntime(kv).sessionNamespace,
  }
}

async function invokeCancel(
  env: Record<string, unknown>,
  command: 'match' | 'mod',
  actorId: string,
  targetId: string,
  roles: string[] = [],
) {
  const replies: string[] = []
  const context = {
    env,
    sub: { string: command === 'mod' ? 'match cancel' : 'cancel' },
    var: { match_id: targetId },
    interaction: {
      guild_id: 'guild-1',
      member: { user: { id: actorId, username: actorId }, roles, permissions: '0' },
    },
    executionCtx: { waitUntil: (_promise: Promise<unknown>) => {} },
    async followup(data?: unknown) {
      if (!data) return
      const payload = JSON.parse(JSON.stringify(data)) as { embeds: Array<{ description: string }> }
      replies.push(...payload.embeds.map(embed => embed.description))
    },
    flags: (_flag: string) => ({
      resDefer: (callback: (deferred: unknown) => Promise<void>) => callback(context),
    }),
  }
  const handler = command === 'mod' ? command_mod.handler : command_match.handler
  await handler(context as unknown as Parameters<typeof handler>[0])
  return replies
}

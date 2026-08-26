import { matchParticipants } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getSessionRecord } from '../../src/session-runtime/session-do-client.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createLobby, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestSessionNamespace } from '../helpers/session-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const GUILD_ID = '111111111111111111'

describe('session roster source guild persistence', () => {
  test('hydrates stored source metadata and carries it into match provenance', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const sourceGuild = {
      id: GUILD_ID,
      name: 'Origin',
      iconUrl: 'https://cdn.discordapp.com/icon.png',
    }
    const queueEntries = [
      { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10, sourceGuild },
      { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11, sourceGuild },
    ]
    const sessionNamespace = createTestSessionNamespace({
      DB: createSqliteD1Database(sqlite),
      KV: kv,
      ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
    })

    try {
      const lobby = await createLobby(kv, {
        mode: '1v1',
        guildId: GUILD_ID,
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        sessionNamespace,
        queueEntries,
      })
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby, {
        db,
        sessionNamespace,
        queueEntries,
      })

      sessionNamespace.__evictRoom(lobby.id)
      const hydrated = await getSessionRecord(sessionNamespace, lobby.id)
      expect(hydrated?.roster.participants.find(member => member.playerId === 'p1')?.sourceGuild).toEqual(sourceGuild)

      await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, {
        db,
        sessionNamespace,
        queueEntries,
      })
      const participants = await db.select({
        playerId: matchParticipants.playerId,
        sourceGuildId: matchParticipants.sourceGuildId,
        sourceKind: matchParticipants.sourceKind,
      }).from(matchParticipants).where(eq(matchParticipants.matchId, lobby.id))

      expect(participants).toHaveLength(2)
      expect(participants.every(participant => (
        participant.sourceGuildId === GUILD_ID && participant.sourceKind === 'joined'
      ))).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })
})

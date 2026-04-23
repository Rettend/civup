import { describe, expect, test } from 'bun:test'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { eq, isNull } from 'drizzle-orm'
import { createLobby, setLobbyStatus } from '../../src/services/lobby/index.ts'
import { isSessionAdmissionError } from '../../src/services/session/index.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('session directory admission', () => {
  test('projects lobby creation into the session directory', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-1',
      db,
    })

    const [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, lobby.id)).limit(1)
    expect(directoryRow).toMatchObject({
      sessionId: lobby.id,
      phase: 'open',
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-1',
      version: 1,
      closedAt: null,
    })

    const liveMembers = await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))
    expect(liveMembers).toHaveLength(1)
    expect(liveMembers[0]).toMatchObject({
      sessionId: lobby.id,
      playerId: 'host-1',
      role: 'participant',
    })

    sqlite.close()
  })

  test('enforces one live session per participant and releases on terminal status', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    const first = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-1',
      db,
    })

    try {
      await createLobby(kv, {
        mode: '2v2',
        hostId: 'host-1',
        channelId: 'draft-channel',
        messageId: 'message-2',
        db,
      })
      throw new Error('Expected duplicate live session admission to fail')
    }
    catch (error) {
      expect(isSessionAdmissionError(error)).toBe(true)
    }

    await setLobbyStatus(kv, first.id, 'cancelled', first, { db })

    const replacement = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-3',
      db,
    })

    const liveMembers = await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))
    expect(liveMembers.map(row => row.sessionId)).toEqual([replacement.id])

    sqlite.close()
  })
})

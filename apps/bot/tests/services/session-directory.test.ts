import { describe, expect, test } from 'bun:test'
import { matches, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { eq, isNull } from 'drizzle-orm'
import { createLobby, setLobbyStatus, startLobbyDraft } from '../../src/services/lobby/index.ts'
import { createDraftMatch } from '../../src/services/match/index.ts'
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

  test('releases stale draft membership when the match row is terminal', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    const first = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-1',
      db,
    })
    await createDraftMatch(db, {
      matchId: first.id,
      mode: '1v1',
      seats: [
        { playerId: 'host-1', displayName: 'Host 1' },
        { playerId: 'player-2', displayName: 'Player 2' },
      ],
    })
    await startLobbyDraft(kv, first.id, first, { db })
    await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, first.id))

    const replacement = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-2',
      db,
    })

    const liveMembers = await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))
    expect(liveMembers.map(row => row.sessionId)).toEqual([replacement.id])

    sqlite.close()
  })
})

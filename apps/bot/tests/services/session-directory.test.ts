import type { SessionRecord } from '../../src/session-runtime/session-record.ts'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { projectSessionRecord, SESSION_DIRECTORY_OPEN_STALE_MS } from '../../src/services/session/directory.ts'
import { getOpenSessionLobbyProjectionsByChannel } from '../../src/services/session/lobby-projection.ts'
import { getActivitySessionById } from '../../src/services/activity/session-state.ts'
import { isSessionAdmissionError } from '../../src/services/session/index.ts'
import { createLobby, setLobbyStatus } from '../helpers/lobby-runtime.ts'
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

  test('defaults missing persisted blindBans config to enabled', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'draft-channel',
      messageId: 'message-1',
      db,
    })

    const [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, lobby.id)).limit(1)
    const configWithoutBlindBans = JSON.parse(directoryRow!.configJson) as Record<string, unknown>
    delete configWithoutBlindBans.blindBans
    await db.update(sessionDirectory)
      .set({ configJson: JSON.stringify(configWithoutBlindBans) })
      .where(eq(sessionDirectory.sessionId, lobby.id))

    const activitySession = await getActivitySessionById(db, lobby.id)
    const [projection] = await getOpenSessionLobbyProjectionsByChannel(db, 'draft-channel')

    expect(activitySession?.config.blindBans).toBe(true)
    expect(projection?.draftConfig.blindBans).toBe(true)

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

  test('rolls back the directory row when live admission fails', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const now = Date.now()
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', playerIds: ['host-1'], updatedAt: now }))

      try {
        await projectSessionRecord(db, buildSessionRecord({ id: 'second', playerIds: ['host-1'], updatedAt: now + 1 }))
        throw new Error('Expected duplicate live admission to fail')
      }
      catch (error) {
        expect(isSessionAdmissionError(error)).toBe(true)
      }

      const secondRows = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'second'))
      expect(secondRows).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('rolls back earlier member inserts when a later live admission fails', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const now = Date.now()
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', playerIds: ['p2'], updatedAt: now }))

      try {
        await projectSessionRecord(db, buildSessionRecord({ id: 'second', playerIds: ['p1', 'p2'], updatedAt: now + 1 }))
        throw new Error('Expected partial live admission to fail')
      }
      catch (error) {
        expect(isSessionAdmissionError(error)).toBe(true)
      }

      expect(await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'second'))).toHaveLength(0)
      expect(await db.select().from(sessionDirectoryMembers).where(and(
        eq(sessionDirectoryMembers.sessionId, 'second'),
        isNull(sessionDirectoryMembers.leftAt),
      ))).toHaveLength(0)
      expect(await db.select().from(sessionDirectoryMembers).where(and(
        eq(sessionDirectoryMembers.playerId, 'p1'),
        isNull(sessionDirectoryMembers.leftAt),
      ))).toHaveLength(0)
    }
    finally {
      sqlite.close()
    }
  })

  test('releases active admission while keeping the active projection visible', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', playerIds: ['host-1'] }))
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', phase: 'active', matchId: 'first', version: 2, playerIds: ['host-1'] }))

      const [activeRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'first')).limit(1)
      expect(activeRow).toMatchObject({ sessionId: 'first', phase: 'active', closedAt: null })
      expect((await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))).map(row => row.sessionId)).toEqual([])

      await projectSessionRecord(db, buildSessionRecord({ id: 'second', playerIds: ['host-1'] }))

      expect((await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))).map(row => row.sessionId)).toEqual(['second'])
    }
    finally {
      sqlite.close()
    }
  })

  test('releases swap admission while keeping the completed draft visible', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', playerIds: ['host-1'] }))
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', phase: 'swap', matchId: 'first', version: 2, playerIds: ['host-1'] }))

      const [swapRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'first')).limit(1)
      expect(swapRow).toMatchObject({ sessionId: 'first', phase: 'swap', closedAt: null })
      expect((await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))).map(row => row.sessionId)).toEqual([])

      await projectSessionRecord(db, buildSessionRecord({ id: 'second', playerIds: ['host-1'] }))

      expect((await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))).map(row => row.sessionId)).toEqual(['second'])
    }
    finally {
      sqlite.close()
    }
  })

  test('ignores stale projections before checking live admission conflicts', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', playerIds: ['host-1'] }))
      await projectSessionRecord(db, buildSessionRecord({ id: 'first', phase: 'active', matchId: 'first', version: 2, playerIds: ['host-1'] }))

      await projectSessionRecord(db, buildSessionRecord({ id: 'first', version: 1, playerIds: ['host-1'] }))

      const liveMembers = await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))
      expect(liveMembers.map(row => row.sessionId)).toEqual([])
      const [firstRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'first')).limit(1)
      expect(firstRow).toMatchObject({ phase: 'active', version: 2 })
    }
    finally {
      sqlite.close()
    }
  })

  test('does not repair fresh open admission conflicts during new projections', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await projectSessionRecord(db, buildSessionRecord({ id: 'fresh-open', playerIds: ['host-1'], updatedAt: Date.now() }))

      try {
        await projectSessionRecord(db, buildSessionRecord({ id: 'second-open', playerIds: ['host-1'], updatedAt: Date.now() }))
        throw new Error('Expected fresh open admission to block')
      }
      catch (error) {
        expect(isSessionAdmissionError(error)).toBe(true)
      }

      const liveMembers = await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))
      expect(liveMembers.map(row => row.sessionId)).toEqual(['fresh-open'])

      const [freshMember] = await db.select().from(sessionDirectoryMembers).where(and(
        eq(sessionDirectoryMembers.sessionId, 'fresh-open'),
        eq(sessionDirectoryMembers.playerId, 'host-1'),
      )).limit(1)
      expect(freshMember?.leftAt).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('repairs stale open admission conflicts during new projections', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      const staleAt = Date.now() - SESSION_DIRECTORY_OPEN_STALE_MS - 1
      await projectSessionRecord(db, buildSessionRecord({ id: 'stale-open', playerIds: ['host-1', 'player-2'], updatedAt: staleAt }))

      const originalConsoleWarn = console.warn
      console.warn = () => {}
      try {
        await projectSessionRecord(db, buildSessionRecord({ id: 'fresh-open', playerIds: ['host-1'], updatedAt: Date.now() }))
      }
      finally {
        console.warn = originalConsoleWarn
      }

      const liveMembers = await db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))
      expect(liveMembers.map(row => row.sessionId)).toEqual(['fresh-open'])

      const staleMembers = await db.select().from(sessionDirectoryMembers).where(eq(sessionDirectoryMembers.sessionId, 'stale-open'))
      expect(staleMembers.map(row => row.leftAt == null)).toEqual([false, false])

      const [staleDirectory] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'stale-open')).limit(1)
      expect(staleDirectory).toMatchObject({ phase: 'cancelled', version: 2 })
      expect(staleDirectory?.closedAt).not.toBeNull()
    }
    finally {
      sqlite.close()
    }
  })
})

function buildSessionRecord(options: {
  id: string
  phase?: SessionRecord['phase']
  version?: number
  matchId?: string | null
  updatedAt?: number
  playerIds: string[]
}): SessionRecord {
  const phase = options.phase ?? 'open'
  const version = options.version ?? 1
  const updatedAt = options.updatedAt ?? version * 10
  const playerIds = options.playerIds
  return {
    id: options.id,
    phase,
    version,
    hostId: playerIds[0] ?? 'host-1',
    guildId: 'guild-1',
    channelId: 'draft-channel',
    mode: '1v1',
    matchId: options.matchId ?? (phase === 'open' ? null : options.id),
    config: {
      pickTimerSeconds: 30,
      banTimerSeconds: 30,
      blindBans: false,
      simultaneousPick: false,
      redDeath: false,
      mapVoteEnabled: false,
      randomDraft: false,
      duplicateFactions: false,
      leaderPoolSize: null,
      dealOptionsSize: null,
      minRole: null,
      maxRole: null,
    },
    roster: {
      participants: playerIds.map((playerId, slotIndex) => ({
        playerId,
        displayName: playerId,
        avatarUrl: null,
        joinedAt: 1,
        slotIndex,
      })),
      slots: playerIds,
    },
    lastArrange: null,
    projectionState: {
      channelId: 'draft-channel',
      messageId: `message-${options.id}`,
      steamLobbyLink: null,
    },
    createdAt: 1,
    updatedAt,
    lastActivityAt: updatedAt,
    closedAt: phase === 'reported' || phase === 'cancelled' ? updatedAt : null,
    lifecycleSync: null,
    terminalSync: null,
    ...(phase === 'open' ? {} : { frozenAt: 1 }),
  } as SessionRecord
}

import { matches, matchParticipants, players, sessionDirectory } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { resolveCanonicalSessionId, resolveJoinButtonLiveMatchId, shouldJoinOpenLobbyFromActivityButton } from '../../src/commands/match/components.ts'
import { lobbyComponents } from '../../src/embeds/match.ts'
import { storeMatchMessageMapping } from '../../src/services/match/message.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('resolveJoinButtonLiveMatchId', () => {
  test('resolves the clicked message match', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([{ id: 'p1', displayName: 'Player 1', avatarUrl: null, createdAt: 1 }])
      await db.insert(matches).values([
        { id: 'match-from-message', gameMode: '1v1', status: 'active', createdAt: 1, completedAt: null, seasonId: null, draftData: JSON.stringify({ completedAt: 1 }) },
        { id: 'match-from-user-map', gameMode: '1v1', status: 'drafting', createdAt: 2, completedAt: null, seasonId: null, draftData: null },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'match-from-message', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'match-from-user-map', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])
      await storeMatchMessageMapping(db, 'message-1', 'match-from-message')

      await expect(resolveJoinButtonLiveMatchId(createTestD1Adapter(db), 'p1', 'message-1', db)).resolves.toBe('match-from-message')
    }
    finally {
      sqlite.close()
    }
  })
})

describe('browser launch canonicalization', () => {
  test('resolves a match ID to its distinct canonical session ID', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(sessionDirectory).values({
        sessionId: 'stable-session-id',
        phase: 'active',
        mode: '1v1',
        guildId: 'guild-1',
        channelId: 'channel-1',
        hostId: 'host-1',
        messageId: 'message-1',
        matchId: 'different-match-id',
        steamLobbyLink: null,
        version: 2,
        rosterJson: JSON.stringify({ participants: [], slots: [] }),
        configJson: '{}',
        createdAt: 1,
        updatedAt: 2,
        lastActivityAt: 2,
        closedAt: null,
      })
      await expect(resolveCanonicalSessionId(db, 'different-match-id')).resolves.toBe('stable-session-id')
    }
    finally {
      sqlite.close()
    }
  })
})

describe('match join activity button', () => {
  test('does not auto-join a full lobby for a non-member spectator', () => {
    expect(shouldJoinOpenLobbyFromActivityButton({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    }, 'spectator')).toBe(false)
  })

  test('still auto-joins when an open seat exists', () => {
    expect(shouldJoinOpenLobbyFromActivityButton({
      memberPlayerIds: ['p1'],
      slots: ['p1', null],
    }, 'spectator')).toBe(true)
  })
})

describe('lobby components', () => {
  test('renders join and browse buttons', () => {
    expect(JSON.parse(JSON.stringify(lobbyComponents('1v1', 'lobby-1')))).toEqual([{
      type: 1,
      components: [
        expect.objectContaining({ type: 2, label: 'Join', style: 1, custom_id: 'match-join;1v1:lobby-1' }),
        expect.objectContaining({ type: 2, label: 'Browse', style: 2, custom_id: 'match-browse;' }),
      ],
    }])
  })
})

function createTestD1Adapter(db: Awaited<ReturnType<typeof createTestDatabase>>['db']): D1Database {
  const sqlite = (db as { $client?: { query?: (sql: string) => { all: (...values: unknown[]) => unknown[] } } }).$client
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all<T = Record<string, unknown>>() {
              return { results: sqlite?.query?.(query).all(...values) as T[] | undefined }
            },
          }
        },
      }
    },
  } as D1Database
}

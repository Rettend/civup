import { describe, expect, test } from 'bun:test'
import { CIVUP_INTERNAL_SECRET_HEADER, PARTYSERVER_NAMESPACE_HEADER, PARTYSERVER_ROOM_HEADER } from '@civup/utils'
import type { ActivityOverviewOptionSnapshot } from '../../src/services/activity/session-state.ts'
import { mergeActivityOverviewSnapshotForSessionUpdate } from '../../src/services/activity/session-state.ts'
import { publishActivitySessionUpdate } from '../../src/session-runtime/activity-feed-client.ts'
import type { SessionRecord } from '../../src/session-runtime/session-record.ts'

describe('activity feed client', () => {
  test('publishes through PartyServer room routing headers', async () => {
    let capturedRequest: Request | null = null
    const namespace = {
      idFromName(name: string) {
        return { name }
      },
      get() {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            capturedRequest = input instanceof Request ? input : new Request(input, init)
            return Response.json({ ok: true })
          },
        }
      },
    } as unknown as DurableObjectNamespace

    await publishActivitySessionUpdate(namespace, buildSessionRecord(), 'secret')

    expect(capturedRequest?.headers.get(PARTYSERVER_ROOM_HEADER)).toBe('channel-1')
    expect(capturedRequest?.headers.get(PARTYSERVER_NAMESPACE_HEADER)).toBe('activity')
    expect(capturedRequest?.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe('secret')
  })

  test('removes terminal sessions and stale completed options from overview updates', () => {
    const current = {
      channelId: 'channel-1',
      options: [
        buildOverviewOption({ id: 'session-1', lobbyId: 'session-1', kind: 'lobby', status: 'open' }),
        buildOverviewOption({ id: 'old-match-1', lobbyId: 'old-session-1', kind: 'match', status: 'completed', matchId: 'old-match-1' }),
        buildOverviewOption({ id: 'session-2', lobbyId: 'session-2', kind: 'lobby', status: 'open' }),
      ],
    }

    const overview = mergeActivityOverviewSnapshotForSessionUpdate(current, {
      ...buildSessionRecord(),
      phase: 'reported',
      matchId: 'match-1',
      updatedAt: 10,
      closedAt: 10,
    })

    expect(overview?.options.map(option => option.id)).toEqual(['session-2'])
  })
})

function buildOverviewOption(overrides: Partial<ActivityOverviewOptionSnapshot> = {}): ActivityOverviewOptionSnapshot {
  return {
    kind: 'lobby',
    id: 'session-1',
    lobbyId: 'session-1',
    matchId: null,
    channelId: 'channel-1',
    mode: '1v1',
    status: 'open',
    participantCount: 1,
    targetSize: 2,
    redDeath: false,
    hostId: 'host-1',
    memberPlayerIds: ['host-1'],
    updatedAt: 1,
    ...overrides,
  }
}

function buildSessionRecord(): SessionRecord {
  return {
    id: 'session-1',
    phase: 'open',
    version: 1,
    hostId: 'host-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    mode: '1v1',
    matchId: null,
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
      participants: [],
      slots: [null, null],
    },
    lastArrange: null,
    projectionState: {
      channelId: 'channel-1',
      messageId: 'message-1',
      steamLobbyLink: null,
    },
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    closedAt: null,
  }
}

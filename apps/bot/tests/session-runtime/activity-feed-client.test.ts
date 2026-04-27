import { describe, expect, test } from 'bun:test'
import { CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'
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

    expect(capturedRequest?.headers.get('x-partykit-room')).toBe('channel-1')
    expect(capturedRequest?.headers.get('x-partykit-namespace')).toBe('activity')
    expect(capturedRequest?.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe('secret')
  })
})

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

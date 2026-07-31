import { ACTIVITY_FEED_ROOM } from '@civup/utils'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface PartySocketOptions {
  host: string
  party: string
  prefix: string
  room: string
  query: Record<string, string>
}

const socketOptions: PartySocketOptions[] = []

class FakePartySocket extends EventTarget {
  retryCount = 0
  shouldReconnect = true

  constructor(options: PartySocketOptions) {
    super()
    socketOptions.push(options)
  }

  close() {}
  send() {}
}

mock.module('partysocket', () => ({ default: FakePartySocket }))

const { cacheActivitySessionToken, clearActivitySessionToken } = await import('../src/client/lib/activity-session')
const { configureClientPlatform } = await import('../src/client/platform/runtime')
const { watchLobbyState } = await import('../src/client/stores/connection-store')

describe('Activity feed connection', () => {
  beforeEach(() => {
    socketOptions.length = 0
    clearActivitySessionToken()
    configureClientPlatform('discord-embedded', 'token')
  })

  test('all overview watchers connect to the shared feed room', () => {
    cacheActivitySessionToken('activity-session-token')

    const watch = watchLobbyState({ host: 'activity.test' }, {
      channelId: '1496817844812386365',
      userId: 'player-1',
      onStateChanged: () => {},
    })

    expect(socketOptions).toHaveLength(1)
    expect(socketOptions[0]).toMatchObject({
      party: 'activity',
      room: ACTIVITY_FEED_ROOM,
      query: { activitySession: 'activity-session-token' },
    })
    expect(socketOptions[0]?.room).not.toBe('1496817844812386365')
    watch.close()
  })
})

import { describe, expect, test } from 'bun:test'
import { buildSessionRoster, buildSessionRosterQueueEntries } from '../../src/session-runtime/session-record.ts'

describe('session roster source guild persistence', () => {
  test('round-trips trusted source guild metadata and accepts legacy members without it', () => {
    const roster = buildSessionRoster({ memberPlayerIds: ['p1', 'p2'], slots: ['p1', 'p2'] }, [
      {
        playerId: 'p1',
        displayName: 'Player One',
        avatarUrl: null,
        joinedAt: 10,
        sourceGuild: { id: '111111111111111111', name: 'Origin', iconUrl: 'https://cdn.discordapp.com/icon.png' },
      },
      { playerId: 'p2', displayName: 'Legacy Player', avatarUrl: null, joinedAt: 11 },
    ])

    expect(roster.participants[0]?.sourceGuild).toEqual({
      id: '111111111111111111',
      name: 'Origin',
      iconUrl: 'https://cdn.discordapp.com/icon.png',
    })
    expect(roster.participants[1]?.sourceGuild).toBeUndefined()
    expect(buildSessionRosterQueueEntries({ roster })[0]?.sourceGuild?.id).toBe('111111111111111111')
  })
})

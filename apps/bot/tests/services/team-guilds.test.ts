import type { QueueEntry } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { arrangeLobbySlots } from '../../src/services/lobby/arrange.ts'
import { validateLobbyParties, validateTeamGuildSlots } from '../../src/services/lobby/team-guilds.ts'

const PRIMARY = { id: '111111111111111111', name: 'Primary Server' }
const PARTNER = { id: '222222222222222222', name: 'Partner Server' }

describe('team-column server locks', () => {
  test('locks from the first occupant, rejects another server, and unlocks when empty', () => {
    const entries = [entry('a1', PRIMARY), entry('a2', PRIMARY), entry('b1', PARTNER), entry('b2', PARTNER)]
    const valid = validateTeamGuildSlots('2v2', ['a1', 'a2', 'b1', 'b2'], entries)
    expect(valid.error).toBeNull()
    expect(valid.locks.map(lock => lock.sourceGuild?.id ?? null)).toEqual([PRIMARY.id, PARTNER.id])

    const mixed = validateTeamGuildSlots('2v2', ['a1', 'b1', 'a2', 'b2'], entries)
    expect(mixed.error).toContain('Team A is locked to')
    expect(mixed.error).toContain('Partner Server')

    const emptied = validateTeamGuildSlots('2v2', [null, null, 'b1', 'b2'], entries)
    expect(emptied.error).toBeNull()
    expect(emptied.locks.map(lock => lock.sourceGuild?.id ?? null)).toEqual([null, PARTNER.id])
    expect(validateTeamGuildSlots('2v2', ['b1', null, null, null], entries).error).toBeNull()
  })

  test('leaves FFA unaffected and only permits the documented legacy-primary source fallback', () => {
    const missingSource = [entry('legacy', null)]
    expect(validateTeamGuildSlots('ffa', ['legacy', null], missingSource).error).toBeNull()
    expect(validateTeamGuildSlots('2v2', ['legacy', null, null, null], missingSource).error).toContain('has no join server')
    expect(validateTeamGuildSlots('2v2', ['legacy', null, null, null], missingSource, {
      primaryGuildId: PRIMARY.id,
      allowLegacyPrimarySource: true,
    }).locks[0]?.sourceGuild?.id).toBe(PRIMARY.id)
  })

  test('keeps arrange output and parties within one source server', () => {
    const entries = [
      entry('a1', PRIMARY),
      entry('b1', PARTNER),
      entry('a2', PRIMARY),
      entry('b2', PARTNER),
    ]
    const arranged = arrangeLobbySlots({
      mode: '2v2',
      slots: ['a1', 'b1', 'a2', 'b2'],
      queueEntries: entries,
      strategy: 'balance',
    })
    if ('error' in arranged) throw new Error(arranged.error)
    expect(validateTeamGuildSlots('2v2', arranged.slots, entries).error).toBeNull()

    const crossServerParty = [
      entry('a1', PRIMARY, ['b1']),
      entry('b1', PARTNER, ['a1']),
    ]
    expect(validateLobbyParties('2v2', crossServerParty, ['a1', 'b1'], 4)).toContain('joined from')
    expect(arrangeLobbySlots({
      mode: '2v2',
      slots: ['a1', 'b1', null, null],
      queueEntries: crossServerParty,
      strategy: 'randomize',
    })).toEqual({ error: expect.stringContaining('joined from') })
  })
})

function entry(playerId: string, sourceGuild: QueueEntry['sourceGuild'] | null, partyIds?: string[]): QueueEntry {
  return {
    playerId,
    displayName: playerId,
    avatarUrl: null,
    joinedAt: 1,
    ...(sourceGuild ? { sourceGuild } : {}),
    ...(partyIds ? { partyIds } : {}),
  }
}

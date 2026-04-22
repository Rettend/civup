import type { MatchRow, ParticipantRow } from '../../src/services/match/types.ts'
import { describe, expect, test } from 'bun:test'
import { getMatchInvariantViolations } from '../../src/services/match/invariants.ts'

function createMatch(overrides: Partial<MatchRow> = {}): MatchRow {
  return {
    id: 'match-1',
    gameMode: '2v2',
    status: 'active',
    createdAt: 1,
    completedAt: null,
    draftData: JSON.stringify({
      completedAt: 100,
      state: {
        seats: [
          { playerId: 'p1' },
          { playerId: 'p2' },
          { playerId: 'p3' },
          { playerId: 'p4' },
        ],
      },
    }),
    ...overrides,
  }
}

function createParticipants(overrides: Partial<ParticipantRow>[] = []): ParticipantRow[] {
  return [
    {
      matchId: 'match-1',
      playerId: 'p1',
      team: 0,
      civId: 'a',
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
      ...overrides[0],
    },
    {
      matchId: 'match-1',
      playerId: 'p2',
      team: 1,
      civId: 'b',
      placement: null,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
      ...overrides[1],
    },
  ]
}

describe('match invariants', () => {
  test('accept a valid active match aggregate', () => {
    expect(getMatchInvariantViolations(createMatch(), createParticipants())).toHaveLength(0)
  })

  test('report missing civ assignments and placements for terminal states', () => {
    const activeViolations = getMatchInvariantViolations(
      createMatch(),
      createParticipants([{ civId: null }]),
    )
    const completedViolations = getMatchInvariantViolations(
      createMatch({
        status: 'completed',
        completedAt: 200,
      }),
      createParticipants([{ placement: 1 }, { placement: null }]),
    )

    expect(activeViolations.some(violation => violation.message.includes('civ assignment'))).toBe(true)
    expect(completedViolations.some(violation => violation.message.includes('placement'))).toBe(true)
  })
})

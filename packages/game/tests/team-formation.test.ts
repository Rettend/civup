import type { DraftSeat, DraftState } from '../src/types.ts'
import { describe, expect, test } from 'bun:test'
import {
  applyTeamFormationToDraftState,
  buildTeamFormationSnapshot,
  createTeamFormationState,
  getNextTeamFormationOwner,
  getTeamFormationSnakeOrder,
  remapDraftSteps,
  selectTeamFormationGroup,
  selectTeamFormationTimeout,
  startTeamFormation,
} from '../src/team-formation.ts'

const guildA = { id: '111111111111111111', name: 'A' }
const guildB = { id: '222222222222222222', name: 'B' }

function seats(size = 6): DraftSeat[] {
  return Array.from({ length: size }, (_, index) => ({
    playerId: `p${index}`,
    displayName: `P${index}`,
    sourceGuild: index % 2 === 0 ? guildA : guildB,
    ...(index < 2 ? { team: index } : {}),
  }))
}

describe('team formation', () => {
  test('uses mirrored snake ownership and derives turns from consumed quotas', () => {
    expect(getTeamFormationSnakeOrder(4, 0)).toEqual([0, 1, 1, 0, 0, 1])
    expect(getTeamFormationSnakeOrder(4, 1)).toEqual([1, 0, 0, 1, 1, 0])
    expect(getNextTeamFormationOwner(0, 3, [2, 0])).toBe(1)
    expect(getNextTeamFormationOwner(0, 3, [2, 2])).toBe(0)
  })

  test('keeps parties atomic and auto-assigns captain parties', () => {
    const created = createTeamFormationState({
      mode: '3v3',
      seats: seats(),
      partySeatIndices: [[0, 2], [1, 3]],
      timerSeconds: 45,
    })
    expect('error' in created).toBe(false)
    if ('error' in created) return
    expect(created.state.teamSeatIndices).toEqual([[0, 2], [1, 3]])

    const started = startTeamFormation(created.state, seats(), 0, 1_000)
    expect('error' in started).toBe(false)
    if ('error' in started) return
    expect(started.state.currentTeam).toBe(1)
    expect(started.state.endsAt).toBe(46_000)
    expect(started.state.groups.map(group => group.seatIndices)).toEqual([[4], [5]])
  })

  test('rejects a party containing both captains', () => {
    expect(createTeamFormationState({ mode: '3v3', seats: seats(), partySeatIndices: [[0, 1]] })).toEqual({
      error: 'A party cannot contain both captains.',
    })
  })

  test('enforces captain source locks and rejects impossible distributions', () => {
    const invalidSeats = seats()
    invalidSeats[4] = { ...invalidSeats[4]!, sourceGuild: guildB }
    expect(createTeamFormationState({ mode: '3v3', seats: invalidSeats })).toEqual({
      error: 'Players cannot be assigned into legal Captain Pick teams.',
    })
  })

  test('exposes only legal source-compatible groups for the current captain', () => {
    const roster = seats(8)
    const created = createTeamFormationState({
      mode: '4v4',
      seats: roster,
      partySeatIndices: [[2, 4], [3, 5]],
    })
    expect('error' in created).toBe(false)
    if ('error' in created) return
    const started = startTeamFormation(created.state, roster, 0, 0)
    expect('error' in started).toBe(false)
    if ('error' in started) return
    expect(started.state.currentTeam).toBe(0)
    expect(started.state.legalGroupIds).toContain('group:2')
    expect(started.state.legalGroupIds).not.toContain('group:3')
  })

  test('assigns a selected party together and consumes multiple ownership positions', () => {
    const roster = seats(8)
    const created = createTeamFormationState({ mode: '4v4', seats: roster, partySeatIndices: [[2, 4], [3, 5]] })
    if ('error' in created) throw new Error(created.error)
    const started = startTeamFormation(created.state, roster, 0, 0)
    if ('error' in started) throw new Error(started.error)
    const picked = selectTeamFormationGroup(started.state, roster, 0, 'group:2', started.state.revision, 100)
    if ('error' in picked) throw new Error(picked.error)
    expect(picked.state.teamSeatIndices[0]).toEqual([0, 2, 4])
    expect(picked.state.consumedByTeam).toEqual([2, 0])
    expect(picked.state.currentTeam).toBe(1)
  })

  test('rejects non-captain picks and resolves timeouts from the legal candidate set', () => {
    const roster = seats()
    const created = createTeamFormationState({ mode: '3v3', seats: roster, timerSeconds: 30 })
    if ('error' in created) throw new Error(created.error)
    const started = startTeamFormation(created.state, roster, 0, 1_000)
    if ('error' in started) throw new Error(started.error)

    expect(selectTeamFormationGroup(started.state, roster, 1, started.state.legalGroupIds[0]!, started.state.revision, 2_000)).toEqual({
      error: 'Only the current captain can pick a player.',
    })

    expect(selectTeamFormationGroup(started.state, roster, 0, started.state.legalGroupIds[0]!, started.state.revision + 1, 2_000)).toEqual({
      error: 'That Captain Pick turn has already changed.',
    })

    const timedOut = selectTeamFormationTimeout(started.state, roster, 2_000, () => 0.999)
    if ('error' in timedOut) throw new Error(timedOut.error)
    expect(timedOut.state.unassignedSeatIndices.length).toBe(started.state.unassignedSeatIndices.length - 1)
    expect(timedOut.state.endsAt).toBe(32_000)
  })

  test('drops candidate and stats payloads from completed snapshots', () => {
    const snapshot = buildTeamFormationSnapshot({
      enabled: true,
      phase: 'done',
      revision: 2,
      firstTeam: 0,
      currentTeam: null,
      captainSeatIndices: [0, 1],
      teamSeatIndices: [[0, 2], [1, 3]],
      unassignedSeatIndices: [],
      groups: [{ id: 'stale', seatIndices: [2] }],
      legalGroupIds: ['stale'],
      consumedByTeam: [1, 1],
      timerSeconds: 45,
      endsAt: null,
      statsBySeat: { 2: { publicRating: 1200, rank: 5, gamesPlayed: 10, wins: 6 } },
    })
    expect(snapshot.groups).toEqual([])
    expect(snapshot.legalGroupIds).toEqual([])
    expect(snapshot.statsBySeat).toEqual({})
    expect(snapshot.timerSeconds).toBe(45)
  })

  test('remaps all seat-bearing draft step fields after teams finish', () => {
    const map = new Map([[0, 0], [1, 1], [2, 4], [3, 2], [4, 3], [5, 5]])
    expect(remapDraftSteps([{
      action: 'pick',
      seats: [2, 3],
      count: 1,
      timer: 60,
      fallbackPickOrder: [0, 1, 3, 2],
      civBlitzCategoriesBySeat: { 2: ['unit'], 3: ['leaderAbility'] },
    }], map)).toEqual([{
      action: 'pick',
      seats: [4, 2],
      count: 1,
      timer: 60,
      fallbackPickOrder: [0, 1, 2, 4],
      civBlitzCategoriesBySeat: { 4: ['unit'], 2: ['leaderAbility'] },
    }])

    const state: DraftState = {
      matchId: 'm',
      formatId: 'default-3v3',
      seats: seats(),
      steps: [{ action: 'pick', seats: [2, 3], count: 1, timer: 60 }],
      currentStepIndex: -1,
      submissions: {},
      bans: [],
      picks: [],
      availableCivIds: ['x'],
      status: 'waiting',
      cancelReason: null,
      pendingBlindBans: [],
    }
    const formation = {
      enabled: true,
      phase: 'done' as const,
      revision: 4,
      firstTeam: 0 as const,
      currentTeam: null,
      captainSeatIndices: [0, 1] as [number, number],
      teamSeatIndices: [[0, 4, 3], [1, 2, 5]] as [number[], number[]],
      unassignedSeatIndices: [],
      groups: [],
      legalGroupIds: [],
      consumedByTeam: [2, 2] as [number, number],
      timerSeconds: 60,
      endsAt: null,
      statsBySeat: {},
    }
    const applied = applyTeamFormationToDraftState(state, formation)
    if ('error' in applied) throw new Error(applied.error)
    expect(applied.state.seats.map(seat => seat.team)).toEqual([0, 1, 1, 0, 0, 1])
    expect(applied.state.steps[0]?.seats).toEqual([4, 2])
  })
})

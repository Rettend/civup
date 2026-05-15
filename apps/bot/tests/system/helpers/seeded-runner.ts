import type { GameMode } from '@civup/game'
import type { SystemWorld } from './world.ts'
import { createSeededRandom, swapSeatPicks } from '@civup/game'
import { expect } from 'bun:test'
import { assertSystemWorldInvariants, expectLobbyState, expectMatchState, expectQueuePlayers } from './assertions.ts'

const MODE_CASES = [
  { mode: '1v1', playerCount: 2 },
  { mode: '2v2', playerCount: 4 },
  { mode: '3v3', playerCount: 6 },
  { mode: 'ffa', playerCount: 8 },
] as const satisfies readonly { mode: GameMode, playerCount: number }[]

type SeededOutcome = 'reported' | 'timed-out' | 'cancelled' | 'finalized'

export interface SeededSystemSequenceResult {
  steps: string[]
}

export async function runSeededSystemSequence(
  world: SystemWorld,
  seed: string,
  options: {
    cycles?: number
  } = {},
): Promise<SeededSystemSequenceResult> {
  const random = createSeededRandom(seed)
  const cycles = Math.max(1, options.cycles ?? 5)
  const steps: string[] = []

  for (let cycle = 0; cycle < cycles; cycle++) {
    const modeCase = pick(random, MODE_CASES)
    const hostId = `seed-${cycle + 1}-p1`
    const players = createPlayers(modeCase.playerCount, `seed-${cycle + 1}-p`)
    const channelId = `channel-seeded-${cycle + 1}`
    const spectatorId = `seed-spec-${cycle + 1}`
    const lobby = await world.lobby.createOpen({
      mode: modeCase.mode,
      players,
      hostId,
      channelId,
    })
    steps.push(`cycle ${cycle + 1}: create ${modeCase.mode}`)
    await assertSystemWorldInvariants(world)

    const config = buildCycleConfig(modeCase.mode, random)
    if (config) {
      const configured = await world.lobby.config(modeCase.mode, {
        hostId,
        lobbyId: lobby.id,
        ...config,
      })
      expect(configured.status).toBe(200)
      await world.flushBackgroundTasks()
      steps.push(`cycle ${cycle + 1}: config ${modeCase.mode}`)
      await assertSystemWorldInvariants(world)
    }

    if (random() < 0.5) {
      const selected = await world.activity.targetLobby({
        channelId,
        userId: spectatorId,
        lobbyId: lobby.id,
      })
      expect(selected.body).toMatchObject({
        snapshot: {
          selection: {
            kind: 'lobby',
            option: { id: lobby.id },
          },
        },
      })
    }

    const started = await startSeededDraft(world, modeCase.mode, hostId, lobby.id, random)
    steps.push(`cycle ${cycle + 1}: start ${modeCase.mode}`)
    await expectLobbyState(world, {
      lobbyId: lobby.id,
      status: 'drafting',
      matchId: started.matchId,
    })
    await expectMatchState(world, {
      matchId: started.matchId,
      status: 'drafting',
      participantPlayerIds: [...players.map(player => player.id)].sort(),
      civsAssigned: false,
      placementsAssigned: false,
    })
    await expectQueuePlayers(world, modeCase.mode, [])
    await assertSystemWorldInvariants(world)

    const outcome = pickOutcome(modeCase.mode, random)
    switch (outcome) {
      case 'timed-out': {
        const timeoutResponse = random() < 0.5
          ? await replaySeededTimeout(world, started.matchId)
          : await world.party.timeoutDraft(started.matchId)
        expect(timeoutResponse.status).toBe(200)
        await world.flushBackgroundTasks()

        await expectMatchState(world, {
          matchId: started.matchId,
          status: 'cancelled',
          placementsAssigned: false,
        })
        const reopenedLobby = await expectLobbyState(world, {
          lobbyId: lobby.id,
          status: 'open',
        })
        expect(reopenedLobby.memberPlayerIds.length).toBeGreaterThan(0)
        steps.push(`cycle ${cycle + 1}: timeout ${modeCase.mode}`)
        await assertSystemWorldInvariants(world)

        const cleanedUp = await world.lobby.cancel(modeCase.mode, {
          hostId: reopenedLobby.hostId,
          lobbyId: reopenedLobby.id,
        })
        expect(cleanedUp.status).toBe(200)
        await world.flushBackgroundTasks()
        break
      }

      case 'cancelled': {
        const reason = random() < 0.5 ? 'revert' : 'scrub'
        const cancelled = await world.party.cancelDraft(started.matchId, { reason })
        expect(cancelled.status).toBe(200)
        await world.flushBackgroundTasks()

        await expectMatchState(world, {
          matchId: started.matchId,
          status: 'cancelled',
          placementsAssigned: false,
        })
        if (reason === 'revert') {
          const reopenedLobby = await expectLobbyState(world, {
            lobbyId: lobby.id,
            status: 'open',
          })
          const cleanedUp = await world.lobby.cancel(modeCase.mode, {
            hostId: reopenedLobby.hostId,
            lobbyId: reopenedLobby.id,
          })
          expect(cleanedUp.status).toBe(200)
          await world.flushBackgroundTasks()
        }
        else {
          expect(await world.lobby.getById(lobby.id)).toBeNull()
        }

        steps.push(`cycle ${cycle + 1}: cancel ${modeCase.mode} (${reason})`)
        await assertSystemWorldInvariants(world)
        break
      }

      case 'reported':
      case 'finalized': {
        const completed = random() < 0.4
          ? await replaySeededCompletion(world, started.matchId)
          : await world.party.completeDraft(started.matchId)
        expect(completed.status).toBe(200)
        await world.flushBackgroundTasks()

        await expectMatchState(world, {
          matchId: started.matchId,
          status: 'active',
          civsAssigned: true,
          placementsAssigned: false,
        })
        steps.push(`cycle ${cycle + 1}: activate ${modeCase.mode}`)
        await assertSystemWorldInvariants(world)

        if (outcome === 'finalized') {
          const finalized = await world.party.completeDraft(started.matchId, {
            finalized: true,
            transformState: swapFirstTeammatePicks,
          })
          expect(finalized.status).toBe(200)
          await world.flushBackgroundTasks()

          await expectMatchState(world, {
            matchId: started.matchId,
            status: 'active',
            civsAssigned: true,
            placementsAssigned: false,
          })
          steps.push(`cycle ${cycle + 1}: finalize ${modeCase.mode}`)
          await assertSystemWorldInvariants(world)
        }

        const activeParticipants = await world.match.getParticipants(started.matchId)
        const report = await world.match.report(started.matchId, {
          reporterId: hostId,
          placements: buildPlacements(modeCase.mode, activeParticipants),
        })
        expect(report.ok).toBe(true)
        await world.flushBackgroundTasks()

        await expectMatchState(world, {
          matchId: started.matchId,
          status: 'completed',
          civsAssigned: true,
          placementsAssigned: true,
        })
        steps.push(`cycle ${cycle + 1}: report ${modeCase.mode}`)
        await assertSystemWorldInvariants(world)

        if (random() < 0.35) {
          const staleComplete = await world.party.replayDraftComplete(started.matchId)
          const staleCancel = await world.party.cancelDraft(started.matchId, { reason: 'scrub' })
          expect(staleComplete.status).toBe(200)
          expect(staleCancel.status).toBe(200)
          await world.flushBackgroundTasks()

          await expectMatchState(world, {
            matchId: started.matchId,
            status: 'completed',
            civsAssigned: true,
            placementsAssigned: true,
          })
          steps.push(`cycle ${cycle + 1}: stale replay ${modeCase.mode}`)
          await assertSystemWorldInvariants(world)
        }
        break
      }
    }
  }

  return { steps }
}

async function startSeededDraft(
  world: SystemWorld,
  mode: GameMode,
  hostId: string,
  lobbyId: string,
  random: () => number,
) {
  if (random() < 0.35) {
    const [first, second] = await Promise.all([
      world.lobby.start(mode, { hostId, lobbyId }),
      world.lobby.start(mode, { hostId, lobbyId }),
    ])
    expect(first.matchId).toBe(second.matchId)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    await world.flushBackgroundTasks()
    return first
  }

  const started = await world.lobby.start(mode, { hostId, lobbyId })
  await world.flushBackgroundTasks()
  return started
}

async function replaySeededCompletion(world: SystemWorld, matchId: string): Promise<Response> {
  world.party.draftComplete(matchId)
  return world.party.replayDraftComplete(matchId)
}

async function replaySeededTimeout(world: SystemWorld, matchId: string): Promise<Response> {
  world.party.draftTimeout(matchId)
  return world.party.replayDraftCancel(matchId)
}

function pickOutcome(mode: GameMode, random: () => number): SeededOutcome {
  const outcomes: SeededOutcome[] = mode === 'ffa' || mode === '1v1'
    ? ['reported', 'timed-out', 'cancelled']
    : ['reported', 'timed-out', 'cancelled', 'finalized']
  return pick(random, outcomes)
}

function buildCycleConfig(
  mode: GameMode,
  random: () => number,
): Record<string, boolean | number> | null {
  if (mode === 'ffa') {
    return random() < 0.5 ? { simultaneousPick: true } : null
  }

  if (mode === '3v3' && random() < 0.5) {
    return { redDeath: true, dealOptionsSize: 3 }
  }

  if (mode === '1v1') {
    if (random() < 0.34) return { blindBans: false }
    if (random() < 0.5) return { randomDraft: true }
    return null
  }

  if (random() < 0.4) {
    return { mapVoteEnabled: true }
  }

  return null
}

function swapFirstTeammatePicks(state: Parameters<typeof swapSeatPicks>[0]) {
  const teammateSeatsByTeam = new Map<number, number[]>()

  for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
    const team = state.seats[seatIndex]?.team
    if (team == null) continue
    const seatIndices = teammateSeatsByTeam.get(team) ?? []
    seatIndices.push(seatIndex)
    teammateSeatsByTeam.set(team, seatIndices)
  }

  for (const seatIndices of teammateSeatsByTeam.values()) {
    if (seatIndices.length < 2) continue
    const [fromSeat, toSeat] = seatIndices
    if (fromSeat == null || toSeat == null) continue

    const swappedPicks = swapSeatPicks(state, fromSeat, toSeat)
    if ('error' in swappedPicks) continue

    return {
      ...state,
      picks: swappedPicks,
    }
  }

  throw new Error(`Expected teammate picks to be swappable for ${state.matchId}`)
}

function buildPlacements(mode: GameMode, participants: Array<{ playerId: string, team: number | null }>): string {
  if (mode !== 'ffa') return 'A'

  const orderedTeamRepresentatives = new Map<number, string>()
  for (const participant of participants) {
    if (participant.team == null || orderedTeamRepresentatives.has(participant.team)) continue
    orderedTeamRepresentatives.set(participant.team, participant.playerId)
  }

  const playerIds = orderedTeamRepresentatives.size > 0 ? [...orderedTeamRepresentatives.values()] : participants.map(participant => participant.playerId)
  return playerIds.map(playerId => `<@${playerId}>`).join('\n')
}

function createPlayers(count: number, prefix: string) {
  return Array.from({ length: count }, (_value, index) => ({ id: `${prefix}${index + 1}` }))
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(random() * items.length))
  const item = items[index]
  if (item == null) throw new Error('Expected seeded picker to select an item')
  return item
}

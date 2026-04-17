import type { DraftState } from '@civup/game'
import type { ActivityTargetOption, LobbyJoinEligibilitySnapshot, LobbySnapshot } from '../src/client/stores'

type DraftStatus = DraftState['status']

export const TEST_LEADER_IDS = {
  abrahamLincoln: 'america-abraham-lincoln',
  teddyBullMoose: 'america-teddy-roosevelt-bull-moose',
  teddyRoughRider: 'america-teddy-roosevelt-rough-rider',
  saladinVizier: 'arabia-saladin-vizier',
  saladinSultan: 'arabia-saladin-sultan',
  johnCurtin: 'australia-john-curtin',
  montezuma: 'aztec-montezuma',
  hammurabi: 'babylon-hammurabi',
} as const

export function createActivityTargetOption(overrides: Partial<ActivityTargetOption> = {}): ActivityTargetOption {
  return {
    kind: 'lobby',
    id: 'lobby-1',
    lobbyId: 'lobby-1',
    matchId: null,
    channelId: 'channel-1',
    mode: 'ffa',
    status: 'open',
    participantCount: 2,
    targetSize: 4,
    redDeath: false,
    isMember: false,
    isHost: false,
    updatedAt: 1,
    ...overrides,
  }
}

export function createJoinEligibility(overrides: Partial<LobbyJoinEligibilitySnapshot> = {}): LobbyJoinEligibilitySnapshot {
  return {
    canJoin: true,
    blockedReason: null,
    pendingSlot: 2,
    ...overrides,
  }
}

export function createLobbySnapshot(overrides: Partial<LobbySnapshot> = {}): LobbySnapshot {
  return {
    id: 'lobby-1',
    revision: 1,
    mode: 'ffa',
    hostId: 'host-1',
    status: 'open',
    steamLobbyLink: 'steam://joinlobby/289070/example',
    minRole: null,
    maxRole: null,
    lastArrange: null,
    entries: [
      { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
      { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
      null,
      null,
    ],
    minPlayers: 2,
    targetSize: 4,
    draftConfig: {
      banTimerSeconds: 60,
      pickTimerSeconds: 90,
      leaderPoolSize: 6,
      leaderDataVersion: 'live',
      blindBans: true,
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    },
    serverDefaults: {
      banTimerSeconds: 60,
      pickTimerSeconds: 90,
    },
    ...overrides,
  }
}

export function createWaitingDraftState(overrides: Partial<DraftState> = {}): DraftState {
  return createDraftState('waiting', overrides)
}

export function createActiveDraftState(overrides: Partial<DraftState> = {}): DraftState {
  return createDraftState('active', overrides)
}

export function createCompleteDraftState(overrides: Partial<DraftState> = {}): DraftState {
  return createDraftState('complete', overrides)
}

export function createCancelledDraftState(cancelReason: DraftState['cancelReason'], overrides: Partial<DraftState> = {}): DraftState {
  return createDraftState('cancelled', { cancelReason, ...overrides })
}

function createDraftState(status: DraftStatus, overrides: Partial<DraftState>): DraftState {
  const isTeamMode = overrides.formatId?.startsWith('2v2') === true

  return {
    matchId: 'match-1',
    status,
    formatId: 'ffa',
    currentStepIndex: 0,
    seats: [
      { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null, ...(isTeamMode ? { team: 0 } : {}) },
      { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, ...(isTeamMode ? { team: 1 } : {}) },
      { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null, ...(isTeamMode ? { team: 0 } : {}) },
      { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null, ...(isTeamMode ? { team: 1 } : {}) },
    ],
    bans: [],
    picks: status === 'complete'
      ? [
          { seatIndex: 0, civId: TEST_LEADER_IDS.abrahamLincoln, stepIndex: 1 },
          { seatIndex: 1, civId: TEST_LEADER_IDS.saladinVizier, stepIndex: 1 },
          { seatIndex: 2, civId: TEST_LEADER_IDS.johnCurtin, stepIndex: 1 },
          { seatIndex: 3, civId: TEST_LEADER_IDS.montezuma, stepIndex: 1 },
        ]
      : [],
    steps: [
      { action: 'ban', count: 1, timer: 60, seats: [0] },
      { action: 'pick', count: 1, timer: 90, seats: [0] },
    ],
    submissions: {},
    availableCivIds: Object.values(TEST_LEADER_IDS),
    cancelReason: null,
    pendingBlindBans: [],
    ...overrides,
  } satisfies DraftState
}

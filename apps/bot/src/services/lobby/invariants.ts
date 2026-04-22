import type { QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import type { RuntimeInvariantViolation } from '@civup/utils'
import { normalizeCompetitiveTierBounds } from '@civup/game'
import { enforceRuntimeInvariants } from '@civup/utils'
import { normalizeStoredSlots, sameStringArray } from './normalize.ts'

interface LobbyProjectionInvariantSnapshot {
  channelIndexed?: boolean
  hostLobbyId?: string | null
  matchLobbyId?: string | null
  modeIndexed?: boolean
}

export interface LobbyInvariantOptions {
  checkOpenRoster?: boolean
  checkSlotNormalization?: boolean
  context?: Record<string, unknown>
  projection?: LobbyProjectionInvariantSnapshot
  queueEntries?: QueueEntry[]
  strict?: boolean
}

export function getLobbyInvariantViolations(
  lobby: LobbyState,
  options: LobbyInvariantOptions = {},
): RuntimeInvariantViolation[] {
  const violations: RuntimeInvariantViolation[] = []
  const push = (message: string, context?: Record<string, unknown>) => {
    violations.push({
      scope: 'lobby-invariant',
      message,
      context: {
        lobbyId: lobby.id,
        mode: lobby.mode,
        status: lobby.status,
        hostId: lobby.hostId,
        matchId: lobby.matchId,
        revision: lobby.revision,
        ...options.context,
        ...context,
      },
    })
  }

  if (lobby.hostId.trim().length === 0) {
    push('Lobby hostId must be a non-empty string.')
  }

  const slotPlayerIds = lobby.slots.filter((playerId): playerId is string => typeof playerId === 'string' && playerId.length > 0)
  if (options.checkSlotNormalization === true) {
    const normalizedSlots = normalizeStoredSlots(lobby.mode, lobby.slots)
    if (!sameNullableStringArray(lobby.slots, normalizedSlots)) {
      push('Lobby slots must stay normalized for the mode.', {
        slots: lobby.slots,
        normalizedSlots,
      })
    }

    for (const playerId of slotPlayerIds) {
      if (!lobby.memberPlayerIds.includes(playerId)) {
        push('Every occupied slot must belong to a lobby member.', {
          playerId,
          memberPlayerIds: lobby.memberPlayerIds,
          slots: lobby.slots,
        })
      }
    }
  }

  const { swapped } = normalizeCompetitiveTierBounds(lobby.minRole, lobby.maxRole)
  if (swapped) {
    push('Lobby minRole must not rank above maxRole.', {
      minRole: lobby.minRole,
      maxRole: lobby.maxRole,
    })
  }

  if (lobby.status === 'open' && lobby.matchId != null) {
    push('Open lobbies must not retain a live matchId.', {
      matchId: lobby.matchId,
    })
  }

  if ((lobby.status === 'drafting' || lobby.status === 'active') && lobby.matchId == null) {
    push('Drafting and active lobbies must have a matchId.', {
      matchId: lobby.matchId,
    })
  }

  if (options.checkOpenRoster === true) {
    if (options.queueEntries) {
      const derivedMemberPlayerIds = deriveQueueBackedLobbyMemberPlayerIds(lobby, options.queueEntries)
      if (lobby.status === 'open' && !sameStringArray(lobby.memberPlayerIds, derivedMemberPlayerIds)) {
        push('Open lobby members must match the queue-backed roster.', {
          memberPlayerIds: lobby.memberPlayerIds,
          derivedMemberPlayerIds,
        })
      }
      if (lobby.status === 'open' && !derivedMemberPlayerIds.includes(lobby.hostId)) {
        push('Open lobby host must stay present in the queue-backed roster.', {
          derivedMemberPlayerIds,
        })
      }
    }
    else if (lobby.status === 'open' && !slotPlayerIds.includes(lobby.hostId) && !lobby.memberPlayerIds.includes(lobby.hostId)) {
      push('Open lobby host must remain represented in slots or memberPlayerIds.')
    }
  }

  if (options.projection) {
    if (options.projection.modeIndexed !== true) {
      push('Lobby writes must keep the mode index in sync.')
    }
    if (options.projection.channelIndexed !== true) {
      push('Lobby writes must keep the channel index in sync.')
    }

    const expectedHostLobbyId = isCurrentLobbyStatus(lobby.status) ? lobby.id : null
    if ((options.projection.hostLobbyId ?? null) !== expectedHostLobbyId) {
      push('Lobby writes must keep the host index aligned with current lobby status.', {
        expectedHostLobbyId,
        actualHostLobbyId: options.projection.hostLobbyId ?? null,
      })
    }

    const expectedMatchLobbyId = lobby.matchId ? lobby.id : null
    if ((options.projection.matchLobbyId ?? null) !== expectedMatchLobbyId) {
      push('Lobby writes must keep the match index aligned with match ownership.', {
        expectedMatchLobbyId,
        actualMatchLobbyId: options.projection.matchLobbyId ?? null,
      })
    }
  }

  return violations
}

export function assertLobbyInvariants(
  lobby: LobbyState,
  options: LobbyInvariantOptions = {},
): void {
  enforceRuntimeInvariants(getLobbyInvariantViolations(lobby, options), {
    strict: options.strict,
  })
}

function deriveQueueBackedLobbyMemberPlayerIds(
  lobby: Pick<LobbyState, 'hostId' | 'memberPlayerIds' | 'slots'>,
  queueEntries: QueueEntry[],
): string[] {
  const queueByPlayerId = new Set(queueEntries.map(entry => entry.playerId))
  const memberIds: string[] = []
  const seen = new Set<string>()
  const append = (playerId: string | null | undefined) => {
    if (!playerId || seen.has(playerId) || !queueByPlayerId.has(playerId)) return
    seen.add(playerId)
    memberIds.push(playerId)
  }

  for (const playerId of lobby.memberPlayerIds) append(playerId)
  for (const playerId of lobby.slots) append(playerId)
  append(lobby.hostId)

  return memberIds
}

function isCurrentLobbyStatus(status: LobbyState['status']): boolean {
  return status === 'open' || status === 'drafting' || status === 'active'
}

function sameNullableStringArray(left: (string | null)[], right: (string | null)[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

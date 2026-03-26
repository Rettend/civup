import type { DraftState, DraftStep, QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import { stateStoreMdelete, stateStoreMput } from '../state/store.ts'
import { draftRosterKey, LOBBY_TTL, matchKey } from './keys.ts'
import { putLobby } from './store.ts'

export interface LobbyTimeoutRecoveryResult {
  lobby: LobbyState
  queueEntries: QueueEntry[]
  timedOutPlayerIds: string[]
}

export async function storeLobbyDraftRoster(
  kv: KVNamespace,
  lobbyId: string,
  entries: QueueEntry[],
): Promise<void> {
  const normalized = normalizeQueueEntries(entries)
  await stateStoreMput(kv, [{
    key: draftRosterKey(lobbyId),
    value: JSON.stringify(normalized),
    expirationTtl: LOBBY_TTL,
  }])
}

export async function getLobbyDraftRoster(kv: KVNamespace, lobbyId: string): Promise<QueueEntry[]> {
  const raw = await kv.get(draftRosterKey(lobbyId), 'json')
  return normalizeQueueEntries(raw)
}

export async function reopenLobbyAfterTimedOutDraft(
  kv: KVNamespace,
  lobby: LobbyState,
  state: DraftState,
  options?: {
    draftRoster?: QueueEntry[]
    now?: number
  },
): Promise<LobbyTimeoutRecoveryResult | null> {
  const timedOutPlayerIds = getTimedOutDraftPlayerIds(state)
  if (timedOutPlayerIds.length === 0) return null

  const timedOutSet = new Set(timedOutPlayerIds)
  const remainingMemberIds = lobby.memberPlayerIds.filter(playerId => !timedOutSet.has(playerId))
  if (remainingMemberIds.length === 0) return null

  const remainingMemberSet = new Set(remainingMemberIds)
  const nextSlots = lobby.slots.map((playerId) => {
    if (!playerId || timedOutSet.has(playerId)) return null
    return playerId
  })
  const slottedPlayerIds = nextSlots.filter((playerId): playerId is string => playerId != null)
  const nextHostId = remainingMemberSet.has(lobby.hostId)
    ? lobby.hostId
    : slottedPlayerIds[0] ?? remainingMemberIds[0]

  if (!nextHostId) return null

  const now = options?.now ?? Date.now()
  const queueEntries = buildRecoveredQueueEntries(
    remainingMemberIds,
    remainingMemberSet,
    normalizeQueueEntries(options?.draftRoster ?? []),
    state,
    now,
  )

  const nextLobby: LobbyState = {
    ...lobby,
    hostId: nextHostId,
    status: 'open',
    matchId: null,
    memberPlayerIds: remainingMemberIds,
    slots: nextSlots,
    lastActivityAt: now,
    updatedAt: now,
    revision: lobby.revision + 1,
  }

  if (lobby.matchId) {
    await stateStoreMdelete(kv, [matchKey(lobby.matchId)])
  }
  await putLobby(kv, nextLobby)

  return {
    lobby: nextLobby,
    queueEntries,
    timedOutPlayerIds,
  }
}

export function getTimedOutDraftPlayerIds(state: DraftState): string[] {
  if (state.status !== 'cancelled' || state.cancelReason !== 'timeout') return []

  const step = state.steps[state.currentStepIndex]
  if (!step || step.action !== 'pick') return []

  const timedOutPlayerIds: string[] = []
  const seen = new Set<string>()
  for (const seatIndex of activeSeatIndices(step, state.seats.length)) {
    const seat = state.seats[seatIndex]
    if (!seat) continue

    const lockedPicks = state.picks.filter(pick => pick.seatIndex === seatIndex && pick.stepIndex === state.currentStepIndex)
    if (lockedPicks.length >= step.count || seen.has(seat.playerId)) continue

    timedOutPlayerIds.push(seat.playerId)
    seen.add(seat.playerId)
  }

  return timedOutPlayerIds
}

function buildRecoveredQueueEntries(
  remainingMemberIds: string[],
  remainingMemberSet: ReadonlySet<string>,
  draftRoster: QueueEntry[],
  state: DraftState,
  now: number,
): QueueEntry[] {
  const seatByPlayerId = new Map(state.seats.map(seat => [seat.playerId, seat]))
  const rosterByPlayerId = new Map(draftRoster.map(entry => [entry.playerId, entry]))
  const entries: QueueEntry[] = []
  const usedPlayerIds = new Set<string>()
  let nextJoinedAt = Math.max(now, ...draftRoster.map(entry => entry.joinedAt), 0)

  const pushEntry = (playerId: string, source?: QueueEntry) => {
    if (!remainingMemberSet.has(playerId) || usedPlayerIds.has(playerId)) return

    const fallbackSeat = seatByPlayerId.get(playerId)
    nextJoinedAt += 1
    const partyIds = source?.partyIds?.filter(candidate => candidate !== playerId && remainingMemberSet.has(candidate))
    entries.push({
      playerId,
      displayName: source?.displayName ?? fallbackSeat?.displayName ?? 'Unknown',
      avatarUrl: source?.avatarUrl ?? fallbackSeat?.avatarUrl ?? null,
      joinedAt: source?.joinedAt ?? nextJoinedAt,
      partyIds: partyIds && partyIds.length > 0 ? partyIds : undefined,
    })
    usedPlayerIds.add(playerId)
  }

  for (const entry of draftRoster) {
    pushEntry(entry.playerId, entry)
  }

  for (const playerId of remainingMemberIds) {
    pushEntry(playerId, rosterByPlayerId.get(playerId))
  }

  return entries
}

function activeSeatIndices(step: DraftStep, seatCount: number): number[] {
  if (step.seats === 'all') return Array.from({ length: seatCount }, (_, seatIndex) => seatIndex)
  return step.seats
}

function normalizeQueueEntries(value: unknown): QueueEntry[] {
  if (!Array.isArray(value)) return []

  const entries: QueueEntry[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue

    const entry = candidate as Partial<QueueEntry>
    const playerId = typeof entry.playerId === 'string' ? entry.playerId.trim() : ''
    if (!playerId || seen.has(playerId)) continue

    entries.push({
      playerId,
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim().length > 0
        ? entry.displayName
        : 'Unknown',
      avatarUrl: typeof entry.avatarUrl === 'string' ? entry.avatarUrl : null,
      joinedAt: typeof entry.joinedAt === 'number' && Number.isFinite(entry.joinedAt)
        ? Math.round(entry.joinedAt)
        : Date.now(),
      partyIds: Array.isArray(entry.partyIds)
        ? entry.partyIds.filter((partyId): partyId is string => typeof partyId === 'string' && partyId.length > 0)
        : undefined,
    })
    seen.add(playerId)
  }

  return entries
}

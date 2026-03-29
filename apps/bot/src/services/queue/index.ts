import type { GameMode, QueueEntry, QueueState } from '@civup/game'
import { defaultPlayerCount, formatModeLabel, GAME_MODES, maxPlayerCount } from '@civup/game'
import { stateStoreMget } from '../state/store.ts'

const QUEUE_KEY_PREFIX = 'queue:'
const QUEUE_TTL = 60 * 60 // 1 hour KV TTL
export const MAX_QUEUE_ENTRIES = 64

interface StoredQueueState {
  entries?: unknown
  targetSize?: unknown
}

function queueKey(mode: GameMode): string {
  return `${QUEUE_KEY_PREFIX}${mode}`
}

function defaultQueueTargetSize(mode: GameMode): number {
  return defaultPlayerCount(mode)
}

function normalizeQueueTargetSize(mode: GameMode, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultQueueTargetSize(mode)
  const rounded = Math.round(value)
  if (rounded <= 0) return defaultQueueTargetSize(mode)
  return Math.min(maxPlayerCount(mode), rounded)
}

function normalizeQueueEntries(value: unknown): QueueEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: QueueEntry[] = []

  for (const row of value) {
    if (!row || typeof row !== 'object') continue

    const candidate = row as Partial<QueueEntry>
    const playerId = typeof candidate.playerId === 'string' ? candidate.playerId.trim() : ''
    if (!playerId || seen.has(playerId)) continue

    const displayName = typeof candidate.displayName === 'string' && candidate.displayName.trim().length > 0
      ? candidate.displayName
      : 'Unknown'

    const avatarUrl = typeof candidate.avatarUrl === 'string'
      ? candidate.avatarUrl
      : null

    const joinedAt = typeof candidate.joinedAt === 'number' && Number.isFinite(candidate.joinedAt)
      ? Math.round(candidate.joinedAt)
      : Date.now()

    normalized.push({
      playerId,
      displayName,
      avatarUrl,
      joinedAt,
      partyIds: Array.isArray(candidate.partyIds)
        ? candidate.partyIds.filter((partyId): partyId is string => typeof partyId === 'string')
        : undefined,
    })
    seen.add(playerId)
  }

  return normalized
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function sameQueueEntries(a: QueueEntry[], b: QueueEntry[]): boolean {
  if (a.length !== b.length) return false

  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (!left || !right) return false
    if (left.playerId !== right.playerId) return false
    if (left.displayName !== right.displayName) return false
    if ((left.avatarUrl ?? null) !== (right.avatarUrl ?? null)) return false
    if (left.joinedAt !== right.joinedAt) return false
    if (!sameStringArray(left.partyIds, right.partyIds)) return false
  }

  return true
}

async function persistQueueState(
  kv: KVNamespace,
  mode: GameMode,
  entries: QueueEntry[],
  targetSize: number,
): Promise<void> {
  if (entries.length === 0) {
    await kv.delete(queueKey(mode))
    return
  }

  await kv.put(queueKey(mode), JSON.stringify({
    entries,
    targetSize,
  } satisfies { entries: QueueEntry[], targetSize: number }), { expirationTtl: QUEUE_TTL })
}

export async function getPlayerQueueMode(
  kv: KVNamespace,
  playerId: string,
): Promise<GameMode | null> {
  return getPlayerQueueModeFromStates((await getQueueStates(kv)).values(), playerId)
}

export async function getQueueStates(
  kv: KVNamespace,
  modes: readonly GameMode[] = GAME_MODES,
): Promise<Map<GameMode, QueueState>> {
  const requestedModes = [...new Set(modes)]
  if (requestedModes.length === 0) return new Map()

  const rawQueueStates = await stateStoreMget(
    kv,
    requestedModes.map(mode => ({ key: queueKey(mode), type: 'json' })),
  )

  const queueStates = new Map<GameMode, QueueState>()
  for (let index = 0; index < requestedModes.length; index++) {
    const mode = requestedModes[index]
    if (!mode) continue
    queueStates.set(mode, parseQueueState(mode, rawQueueStates[index]))
  }

  return queueStates
}

export function getPlayerQueueModeFromStates(
  queueStates: Iterable<QueueState>,
  playerId: string,
): GameMode | null {
  for (const state of queueStates) {
    if (!state.entries.some(entry => entry.playerId === playerId)) continue
    return state.mode
  }

  return null
}

export function parseQueueState(mode: GameMode, raw: unknown): QueueState {
  if (Array.isArray(raw)) {
    return {
      mode,
      entries: normalizeQueueEntries(raw),
      targetSize: defaultQueueTargetSize(mode),
    }
  }

  const parsed = raw as StoredQueueState | null
  const entries = normalizeQueueEntries(parsed?.entries)
  return {
    mode,
    entries,
    targetSize: normalizeQueueTargetSize(mode, parsed?.targetSize),
  }
}

/**
 * Get the current queue state for a mode.
 */
export async function getQueueState(kv: KVNamespace, mode: GameMode): Promise<QueueState> {
  const raw = await kv.get(queueKey(mode), 'json') as QueueEntry[] | StoredQueueState | null
  return parseQueueState(mode, raw)
}

/**
 * Replace queue entries for a mode.
 */
export async function setQueueEntries(
  kv: KVNamespace,
  mode: GameMode,
  entries: QueueEntry[],
  options?: {
    currentState?: QueueState
  },
): Promise<void> {
  const state = options?.currentState ?? await getQueueState(kv, mode)
  const normalized = normalizeQueueEntries(entries)
  if (!sameQueueEntries(state.entries, normalized)) {
    await persistQueueState(kv, mode, normalized, state.targetSize)
  }
}

/**
 * Add a player to a queue. Returns error if they're already queued.
 */
export async function addToQueue(
  kv: KVNamespace,
  mode: GameMode,
  entry: QueueEntry,
  options?: {
    existingMode?: GameMode | null
    currentState?: QueueState
  },
): Promise<{ error?: string, state?: QueueState }> {
  // Check if player is already in any queue
  const existing = options?.existingMode !== undefined
    ? options.existingMode
    : await getPlayerQueueMode(kv, entry.playerId)
  if (existing) {
    return { error: `You're already in the **${formatModeLabel(existing)}** queue. Leave first with \`/match leave\`.` }
  }

  const state = options?.currentState ?? await getQueueState(kv, mode)
  if (state.entries.length >= MAX_QUEUE_ENTRIES) {
    return { error: `The **${formatModeLabel(mode)}** queue is full right now.` }
  }

  const nextState: QueueState = {
    ...state,
    entries: [...state.entries, entry],
  }

  await setQueueEntries(kv, mode, nextState.entries, {
    currentState: state,
  })
  return { state: nextState }
}

/**
 * Move all queue entries from one mode to another.
 */
export async function moveQueueMode(
  kv: KVNamespace,
  fromMode: GameMode,
  toMode: GameMode,
): Promise<QueueState> {
  const fromState = await getQueueState(kv, fromMode)
  const toState = await getQueueState(kv, toMode)

  const movedEntries = [...fromState.entries]
  await persistQueueState(kv, toMode, movedEntries, toState.targetSize)

  if (fromMode !== toMode) {
    await kv.delete(queueKey(fromMode))
  }

  return {
    mode: toMode,
    entries: movedEntries,
    targetSize: toState.targetSize,
  }
}

/** Move specific queue entries from one mode to another. */
export async function moveQueueEntriesBetweenModes(
  kv: KVNamespace,
  fromMode: GameMode,
  toMode: GameMode,
  playerIds: string[],
): Promise<{ from: QueueState, to: QueueState }> {
  const playerSet = new Set(playerIds)
  const fromState = await getQueueState(kv, fromMode)
  const toState = await getQueueState(kv, toMode)

  const movedEntries = fromState.entries.filter(entry => playerSet.has(entry.playerId))
  const remainingEntries = fromState.entries.filter(entry => !playerSet.has(entry.playerId))
  const destinationEntries = [...toState.entries.filter(entry => !playerSet.has(entry.playerId)), ...movedEntries]

  await setQueueEntries(kv, fromMode, remainingEntries, {
    currentState: fromState,
  })
  await setQueueEntries(kv, toMode, destinationEntries, {
    currentState: toState,
  })

  return {
    from: {
      ...fromState,
      entries: remainingEntries,
    },
    to: {
      ...toState,
      entries: destinationEntries,
    },
  }
}

/**
 * Remove a player from whatever queue they're in.
 * Returns the mode they were removed from, or null if not queued.
 */
export async function removeFromQueue(
  kv: KVNamespace,
  playerId: string,
): Promise<GameMode | null> {
  const mode = await getPlayerQueueMode(kv, playerId)
  if (!mode) return null

  const state = await getQueueState(kv, mode)
  const remaining = state.entries.filter(entry => entry.playerId !== playerId)
  if (remaining.length === state.entries.length) {
    return null
  }

  await setQueueEntries(kv, mode, remaining, {
    currentState: state,
  })

  return mode
}

/**
 * Remove one player from their queue and unlink them from any premade teammates.
 */
export async function removeFromQueueAndUnlinkParty(
  kv: KVNamespace,
  playerId: string,
): Promise<{ mode: GameMode | null, removedPlayerIds: string[] }> {
  const mode = await getPlayerQueueMode(kv, playerId)
  if (!mode) return { mode: null, removedPlayerIds: [] }

  const state = await getQueueState(kv, mode)
  const nextEntries = unlinkPlayerFromPremadeEntries(state.entries, playerId)
  if (nextEntries.length === state.entries.length) {
    return { mode: null, removedPlayerIds: [] }
  }

  await setQueueEntries(kv, mode, nextEntries, {
    currentState: state,
  })

  return { mode, removedPlayerIds: [playerId] }
}

/**
 * Check if a queue is full and return the matched entries.
 * Does NOT clear the queue — caller is responsible for that after creating the match.
 */
export async function checkQueueFull(
  kv: KVNamespace,
  mode: GameMode,
): Promise<QueueEntry[] | null> {
  const state = await getQueueState(kv, mode)
  if (state.entries.length >= state.targetSize) {
    return state.entries.slice(0, state.targetSize)
  }
  return null
}

/**
 * Clear a queue after a match has been created from it.
 */
export async function clearQueue(
  kv: KVNamespace,
  mode: GameMode,
  playerIds: string[],
  options?: {
    currentState?: QueueState
  },
): Promise<QueueState> {
  const state = options?.currentState ?? await getQueueState(kv, mode)
  const playerSet = new Set(playerIds)
  const remaining = state.entries.filter(entry => !playerSet.has(entry.playerId))
  await setQueueEntries(kv, mode, remaining, {
    currentState: state,
  })

  return {
    ...state,
    entries: remaining,
  }
}

function unlinkPlayerFromPremadeEntries(entries: QueueEntry[], playerId: string): QueueEntry[] {
  const nextEntries: QueueEntry[] = []

  for (const entry of entries) {
    if (entry.playerId === playerId) {
      continue
    }

    if (!entry.partyIds || !entry.partyIds.includes(playerId)) {
      nextEntries.push(entry)
      continue
    }

    const nextPartyIds = entry.partyIds.filter(teammateId => teammateId !== playerId)
    nextEntries.push({
      ...entry,
      partyIds: nextPartyIds.length > 0 ? nextPartyIds : undefined,
    })
  }

  return nextEntries
}

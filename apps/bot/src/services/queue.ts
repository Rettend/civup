import type { GameMode, QueueEntry, QueueState } from '@civup/game'
import { GAME_MODES, maxPlayerCount } from '@civup/game'

const QUEUE_KEY_PREFIX = 'queue:'
const PLAYER_QUEUE_KEY = 'player-queue:'
const QUEUE_TTL = 60 * 60 // 1 hour KV TTL
const MAX_QUEUE_ENTRIES = 64

interface StoredQueueState {
  entries?: unknown
  targetSize?: unknown
}

function queueKey(mode: GameMode): string {
  return `${QUEUE_KEY_PREFIX}${mode}`
}

function playerQueueKey(playerId: string): string {
  return `${PLAYER_QUEUE_KEY}${playerId}`
}

function defaultQueueTargetSize(mode: GameMode): number {
  return maxPlayerCount(mode)
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
  const key = playerQueueKey(playerId)
  const cached = await kv.get(key)
  if (cached && GAME_MODES.includes(cached as GameMode)) {
    return cached as GameMode
  }

  if (cached) {
    await kv.delete(key)
  }

  for (const mode of GAME_MODES) {
    const state = await getQueueState(kv, mode)
    if (!state.entries.some(entry => entry.playerId === playerId)) continue

    await kv.put(key, mode, { expirationTtl: QUEUE_TTL })
    return mode
  }

  return null
}

/**
 * Get the current queue state for a mode.
 */
export async function getQueueState(kv: KVNamespace, mode: GameMode): Promise<QueueState> {
  const raw = await kv.get(queueKey(mode), 'json') as QueueEntry[] | StoredQueueState | null

  if (Array.isArray(raw)) {
    return {
      mode,
      entries: normalizeQueueEntries(raw),
      targetSize: defaultQueueTargetSize(mode),
    }
  }

  const parsed = raw ?? null
  const entries = normalizeQueueEntries(parsed?.entries)
  return {
    mode,
    entries,
    targetSize: normalizeQueueTargetSize(mode, parsed?.targetSize),
  }
}

/**
 * Replace queue entries for a mode and sync player mappings.
 */
export async function setQueueEntries(
  kv: KVNamespace,
  mode: GameMode,
  entries: QueueEntry[],
): Promise<void> {
  const state = await getQueueState(kv, mode)
  const normalized = normalizeQueueEntries(entries)
  if (!sameQueueEntries(state.entries, normalized)) {
    await persistQueueState(kv, mode, normalized, state.targetSize)
  }

  const prevIds = new Set(state.entries.map(entry => entry.playerId))
  const nextIds = new Set(normalized.map(entry => entry.playerId))
  await Promise.all(
    state.entries
      .filter(entry => !nextIds.has(entry.playerId))
      .map(entry => kv.delete(playerQueueKey(entry.playerId))),
  )

  await Promise.all(
    normalized
      .filter(entry => !prevIds.has(entry.playerId))
      .map(entry => kv.put(playerQueueKey(entry.playerId), mode, { expirationTtl: QUEUE_TTL })),
  )
}

/**
 * Add a player to a queue. Returns error if they're already queued.
 */
export async function addToQueue(
  kv: KVNamespace,
  mode: GameMode,
  entry: QueueEntry,
): Promise<{ error?: string }> {
  // Check if player is already in any queue
  const existing = await getPlayerQueueMode(kv, entry.playerId)
  if (existing) {
    return { error: `You're already in the **${existing.toUpperCase()}** queue. Leave first with \`/match leave\`.` }
  }

  const state = await getQueueState(kv, mode)
  if (state.entries.length >= MAX_QUEUE_ENTRIES) {
    return { error: `The **${mode.toUpperCase()}** queue is full right now.` }
  }

  await setQueueEntries(kv, mode, [...state.entries, entry])
  return {}
}

/**
 * Move all queue entries and player mappings from one mode to another.
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

  const movedIds = new Set(movedEntries.map(entry => entry.playerId))
  await Promise.all(
    toState.entries
      .filter(entry => !movedIds.has(entry.playerId))
      .map(entry => kv.delete(playerQueueKey(entry.playerId))),
  )

  await Promise.all(
    movedEntries.map(entry => kv.put(playerQueueKey(entry.playerId), toMode, { expirationTtl: QUEUE_TTL })),
  )

  return {
    mode: toMode,
    entries: movedEntries,
    targetSize: toState.targetSize,
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
    await kv.delete(playerQueueKey(playerId))
    return null
  }

  await setQueueEntries(kv, mode, remaining)

  return mode
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
): Promise<void> {
  const state = await getQueueState(kv, mode)
  const playerSet = new Set(playerIds)
  const remaining = state.entries.filter(entry => !playerSet.has(entry.playerId))
  await setQueueEntries(kv, mode, remaining)
}

/**
 * Remove stale entries older than the given timeout.
 * Returns removed entries for notification.
 */
export async function pruneStaleEntries(
  kv: KVNamespace,
  timeoutMs: number = 30 * 60 * 1000, // 30 minutes
): Promise<{ mode: GameMode, entry: QueueEntry }[]> {
  const now = Date.now()
  const removed: { mode: GameMode, entry: QueueEntry }[] = []

  for (const mode of GAME_MODES) {
    const state = await getQueueState(kv, mode)
    const stale = state.entries.filter(entry => now - entry.joinedAt > timeoutMs)
    const remaining = state.entries.filter(entry => now - entry.joinedAt <= timeoutMs)

    if (stale.length > 0) {
      await setQueueEntries(kv, mode, remaining)
      for (const entry of stale) {
        removed.push({ mode, entry })
      }
    }
  }

  return removed
}

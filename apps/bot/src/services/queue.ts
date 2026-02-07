import type { GameMode, QueueEntry, QueueState } from '@civup/game'
import { defaultPlayerCount, GAME_MODES } from '@civup/game'

const QUEUE_KEY_PREFIX = 'queue:'
const PLAYER_QUEUE_KEY = 'player-queue:'
const QUEUE_TTL = 60 * 60 // 1 hour KV TTL

function queueKey(mode: GameMode): string {
  return `${QUEUE_KEY_PREFIX}${mode}`
}

function playerQueueKey(playerId: string): string {
  return `${PLAYER_QUEUE_KEY}${playerId}`
}

/**
 * Get the current queue state for a mode.
 */
export async function getQueueState(kv: KVNamespace, mode: GameMode): Promise<QueueState> {
  const data = await kv.get(queueKey(mode), 'json') as QueueEntry[] | null
  return {
    mode,
    entries: data ?? [],
    targetSize: defaultPlayerCount(mode),
  }
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
  const existing = await kv.get(playerQueueKey(entry.playerId))
  if (existing) {
    return { error: `You're already in the **${existing.toUpperCase()}** queue. Leave first with \`/lfg leave\`.` }
  }

  // Get current queue
  const state = await getQueueState(kv, mode)
  const entries = [...state.entries, entry]

  // Save updated queue and player mapping
  await kv.put(queueKey(mode), JSON.stringify(entries), { expirationTtl: QUEUE_TTL })
  await kv.put(playerQueueKey(entry.playerId), mode, { expirationTtl: QUEUE_TTL })

  return {}
}

/**
 * Remove a player from whatever queue they're in.
 * Returns the mode they were removed from, or null if not queued.
 */
export async function removeFromQueue(
  kv: KVNamespace,
  playerId: string,
): Promise<GameMode | null> {
  const mode = await kv.get(playerQueueKey(playerId)) as GameMode | null
  if (!mode)
    return null

  // Remove from queue
  const state = await getQueueState(kv, mode)
  const entries = state.entries.filter(e => e.playerId !== playerId)
  await kv.put(queueKey(mode), JSON.stringify(entries), { expirationTtl: QUEUE_TTL })

  // Remove player mapping
  await kv.delete(playerQueueKey(playerId))

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
  const remaining = state.entries.filter(e => !playerIds.includes(e.playerId))
  await kv.put(queueKey(mode), JSON.stringify(remaining), { expirationTtl: QUEUE_TTL })

  // Remove player mappings
  await Promise.all(
    playerIds.map(id => kv.delete(playerQueueKey(id))),
  )
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
    const stale = state.entries.filter(e => now - e.joinedAt > timeoutMs)
    const remaining = state.entries.filter(e => now - e.joinedAt <= timeoutMs)

    if (stale.length > 0) {
      await kv.put(queueKey(mode), JSON.stringify(remaining), { expirationTtl: QUEUE_TTL })
      for (const entry of stale) {
        await kv.delete(playerQueueKey(entry.playerId))
        removed.push({ mode, entry })
      }
    }
  }

  return removed
}

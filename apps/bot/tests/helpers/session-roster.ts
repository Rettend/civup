import type { GameMode, QueueEntry } from '@civup/game'

const rosterEntriesByKv = new WeakMap<KVNamespace, Map<GameMode, QueueEntry[]>>()

export async function seedRosterEntry(
  kv: KVNamespace,
  mode: GameMode,
  entry: QueueEntry,
): Promise<void> {
  const modeEntries = getModeEntries(kv)
  const entries = modeEntries.get(mode) ?? []
  modeEntries.set(mode, [...entries.filter(candidate => candidate.playerId !== entry.playerId), entry])
}

export async function setSeededRosterEntries(
  kv: KVNamespace,
  mode: GameMode,
  entries: QueueEntry[],
): Promise<void> {
  getModeEntries(kv).set(mode, [...entries])
}

export function getSeededRosterEntries(kv: KVNamespace, mode: GameMode): QueueEntry[] {
  return [...(getModeEntries(kv).get(mode) ?? [])]
}

function getModeEntries(kv: KVNamespace): Map<GameMode, QueueEntry[]> {
  let modeEntries = rosterEntriesByKv.get(kv)
  if (!modeEntries) {
    modeEntries = new Map()
    rosterEntriesByKv.set(kv, modeEntries)
  }
  return modeEntries
}

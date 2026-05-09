export interface RankedMigrationLock {
  lockedAt: number
  reason: string | null
  owner: string | null
}

interface StoredRankedMigrationLock {
  lockedAt?: unknown
  reason?: unknown
  owner?: unknown
}

export const RANKED_MIGRATION_LOCK_KEY = 'ranked:migration-lock'
export const RANKED_MIGRATION_LOCK_MESSAGE = 'Ranked reporting is temporarily paused while ranked ratings are being migrated. Try again in a few minutes.'

export async function getRankedMigrationLock(kv: KVNamespace): Promise<RankedMigrationLock | null> {
  const raw = await kv.get(RANKED_MIGRATION_LOCK_KEY, 'json') as StoredRankedMigrationLock | null
  if (!raw || typeof raw !== 'object') return null

  const lockedAt = typeof raw.lockedAt === 'number' && Number.isFinite(raw.lockedAt)
    ? Math.round(raw.lockedAt)
    : 0
  return {
    lockedAt,
    reason: typeof raw.reason === 'string' && raw.reason.trim().length > 0 ? raw.reason.trim() : null,
    owner: typeof raw.owner === 'string' && raw.owner.trim().length > 0 ? raw.owner.trim() : null,
  }
}

export async function setRankedMigrationLock(
  kv: KVNamespace,
  input: { reason?: string | null, owner?: string | null, lockedAt?: number } = {},
): Promise<RankedMigrationLock> {
  const lock: RankedMigrationLock = {
    lockedAt: input.lockedAt ?? Date.now(),
    reason: input.reason?.trim() || null,
    owner: input.owner?.trim() || null,
  }
  await kv.put(RANKED_MIGRATION_LOCK_KEY, JSON.stringify(lock))
  return lock
}

export async function clearRankedMigrationLock(kv: KVNamespace): Promise<void> {
  await kv.delete(RANKED_MIGRATION_LOCK_KEY)
}

export async function getRankedMigrationLockError(kv: KVNamespace): Promise<string | null> {
  return await getRankedMigrationLock(kv) ? RANKED_MIGRATION_LOCK_MESSAGE : null
}

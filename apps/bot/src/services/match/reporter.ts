import type { MatchReporterIdentity } from './types.ts'

const MATCH_REPORTER_TTL_SECONDS = 180 * 24 * 60 * 60

export async function storeMatchReporterIdentity(
  kv: KVNamespace,
  matchId: string,
  reporter: MatchReporterIdentity,
): Promise<void> {
  const normalized = normalizeMatchReporterIdentity(reporter)
  if (!normalized) return

  await kv.put(matchReporterKey(matchId), JSON.stringify(normalized), {
    expirationTtl: MATCH_REPORTER_TTL_SECONDS,
  })
}

export async function loadMatchReporterIdentity(
  kv: KVNamespace,
  matchId: string,
): Promise<MatchReporterIdentity | null> {
  const stored = await kv.get(matchReporterKey(matchId), 'json')
  return normalizeMatchReporterIdentity(stored)
}

function matchReporterKey(matchId: string): string {
  return `match:reporter:${matchId}`
}

function normalizeMatchReporterIdentity(value: unknown): MatchReporterIdentity | null {
  if (!value || typeof value !== 'object') return null

  const reporter = value as {
    userId?: unknown
    displayName?: unknown
    avatarUrl?: unknown
  }
  const userId = typeof reporter.userId === 'string' && reporter.userId.trim().length > 0
    ? reporter.userId.trim()
    : null
  if (!userId) return null

  const displayName = typeof reporter.displayName === 'string' && reporter.displayName.trim().length > 0
    ? reporter.displayName.trim()
    : null
  const avatarUrl = typeof reporter.avatarUrl === 'string' && reporter.avatarUrl.trim().length > 0
    ? reporter.avatarUrl.trim()
    : null

  return {
    userId,
    displayName,
    avatarUrl,
  }
}

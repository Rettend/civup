import type { Database } from '@civup/db'
import { matchMessageMappings } from '@civup/db'
import { asc, eq } from 'drizzle-orm'

const MATCH_MESSAGE_TTL_MS = 180 * 24 * 60 * 60 * 1000

export async function storeMatchMessageMapping(
  db: Database,
  messageId: string,
  matchId: string,
): Promise<void> {
  const now = Date.now()
  const expiresAt = now + MATCH_MESSAGE_TTL_MS

  const [existing] = await db
    .select({
      matchId: matchMessageMappings.matchId,
      expiresAt: matchMessageMappings.expiresAt,
    })
    .from(matchMessageMappings)
    .where(eq(matchMessageMappings.messageId, messageId))
    .limit(1)

  if (existing?.matchId === matchId && existing.expiresAt > now) return

  if (existing) {
    await db
      .update(matchMessageMappings)
      .set({
        matchId,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      })
      .where(eq(matchMessageMappings.messageId, messageId))
    return
  }

  await db.insert(matchMessageMappings).values({
    messageId,
    matchId,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  })
}

export async function getMatchIdForMessage(
  db: Database,
  messageId: string,
): Promise<string | null> {
  const now = Date.now()
  const [row] = await db
    .select({
      matchId: matchMessageMappings.matchId,
      expiresAt: matchMessageMappings.expiresAt,
    })
    .from(matchMessageMappings)
    .where(eq(matchMessageMappings.messageId, messageId))
    .limit(1)

  if (!row) return null
  if (row.expiresAt > now) return row.matchId

  await db.delete(matchMessageMappings).where(eq(matchMessageMappings.messageId, messageId))
  return null
}

export async function clearMatchMessageMapping(
  db: Database,
  messageId: string,
): Promise<void> {
  await db.delete(matchMessageMappings).where(eq(matchMessageMappings.messageId, messageId))
}

export async function listMatchMessageIds(
  db: Database,
  matchId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      messageId: matchMessageMappings.messageId,
    })
    .from(matchMessageMappings)
    .where(eq(matchMessageMappings.matchId, matchId))
    .orderBy(asc(matchMessageMappings.createdAt), asc(matchMessageMappings.messageId))

  return rows.map(row => row.messageId)
}

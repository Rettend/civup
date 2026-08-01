import type { Database } from '@civup/db'
import { players } from '@civup/db'
import { api, ApiError, buildDiscordAvatarUrl } from '@civup/utils'
import { inArray, sql } from 'drizzle-orm'

const PROFILE_LOOKUP_CHUNK_SIZE = 100

interface DiscordUserResponse {
  id: string
  username: string
  global_name: string | null
  avatar: string | null
}

interface PlayerProfileInput {
  playerId: string
  displayName: string
  avatarUrl: string | null
}

export async function fetchDiscordPlayerProfile(token: string, playerId: string): Promise<PlayerProfileInput | null> {
  try {
    const data = await api.get<Partial<DiscordUserResponse>>(`https://discord.com/api/v10/users/${playerId}`, {
      headers: { Authorization: `Bot ${token}` },
    })

    if (typeof data.id !== 'string') return null

    const displayName = (typeof data.global_name === 'string' && data.global_name.trim().length > 0)
      ? data.global_name
      : (typeof data.username === 'string' && data.username.trim().length > 0)
          ? data.username
          : data.id

    return {
      playerId: data.id,
      displayName,
      avatarUrl: buildDiscordAvatarUrl(data.id, data.avatar ?? null),
    }
  }
  catch (err: unknown) {
    console.error(`Failed to fetch Discord user ${playerId}: ${err instanceof ApiError ? err.status : err}`)
    return null
  }
}

export async function upsertPlayerProfile(db: Database, profile: PlayerProfileInput): Promise<void> {
  await upsertPlayerProfiles(db, [profile])
}

export async function upsertPlayerProfiles(db: Database, profiles: PlayerProfileInput[]): Promise<void> {
  if (profiles.length === 0) return

  const now = Date.now()
  await db
    .insert(players)
    .values(profiles.map(profile => ({
      id: profile.playerId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      createdAt: now,
    })))
    .onConflictDoUpdate({
      target: players.id,
      set: {
        displayName: sql<string>`excluded.display_name`,
        avatarUrl: sql<string | null>`excluded.avatar_url`,
      },
      where: sql`${players.displayName} is not excluded.display_name or ${players.avatarUrl} is not excluded.avatar_url`,
    })
}

/** Read stored display profiles in chunks that remain well below D1 parameter limits. */
export async function getStoredPlayerProfiles(
  db: Database,
  playerIds: readonly string[],
): Promise<Map<string, PlayerProfileInput>> {
  const ids = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const profiles = new Map<string, PlayerProfileInput>()

  for (let index = 0; index < ids.length; index += PROFILE_LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + PROFILE_LOOKUP_CHUNK_SIZE)
    if (chunk.length === 0) continue
    const rows = await db
      .select({ playerId: players.id, displayName: players.displayName, avatarUrl: players.avatarUrl })
      .from(players)
      .where(inArray(players.id, chunk))
    for (const row of rows) profiles.set(row.playerId, row)
  }

  return profiles
}

export async function syncPlayerProfileFromDiscord(
  db: Database,
  token: string,
  playerId: string,
): Promise<void> {
  const profile = await fetchDiscordPlayerProfile(token, playerId)
  if (!profile) return
  await upsertPlayerProfile(db, profile)
}

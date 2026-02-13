import type { Database } from '@civup/db'
import { players } from '@civup/db'
import { api, buildDiscordAvatarUrl } from '@civup/utils'

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
  catch (err: any) {
    console.error(`Failed to fetch Discord user ${playerId}: ${err.status ?? err}`)
    return null
  }
}

export async function upsertPlayerProfile(db: Database, profile: PlayerProfileInput): Promise<void> {
  const now = Date.now()
  await db
    .insert(players)
    .values({
      id: profile.playerId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: players.id,
      set: {
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      },
    })
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

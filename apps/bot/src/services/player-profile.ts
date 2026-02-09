import type { Database } from '@civup/db'
import { players } from '@civup/db'

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

export function buildDiscordAvatarUrl(userId: string, avatarHash: string | null | undefined): string {
  if (avatarHash) {
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png'
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`
  }

  try {
    const index = Number((BigInt(userId) >> 22n) % 6n)
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`
  }
  catch {
    return 'https://cdn.discordapp.com/embed/avatars/0.png'
  }
}

export async function fetchDiscordPlayerProfile(token: string, playerId: string): Promise<PlayerProfileInput | null> {
  const response = await fetch(`https://discord.com/api/v10/users/${playerId}`, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  })

  if (!response.ok) {
    console.error(`Failed to fetch Discord user ${playerId}: ${response.status}`)
    return null
  }

  const data = await response.json() as Partial<DiscordUserResponse>
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

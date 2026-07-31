import type { SourceGuildIdentity } from '@civup/game'
import { fetchGuild } from './index.ts'

const GUILD_METADATA_KEY_PREFIX = 'discord:guild-metadata:'
const GUILD_METADATA_TTL_SECONDS = 24 * 60 * 60

export async function getKnownGuildIdentity(
  kv: KVNamespace,
  token: string | undefined,
  guildId: string | null | undefined,
): Promise<SourceGuildIdentity | undefined> {
  if (!guildId || !/^\d{17,20}$/.test(guildId)) return undefined
  const key = `${GUILD_METADATA_KEY_PREFIX}${guildId}`
  const cached = normalizeGuildIdentity(await kv.get(key, 'json'))
  if (cached) return cached
  if (!token) return { id: guildId }

  try {
    const guild = await fetchGuild(token, guildId)
    const identity: SourceGuildIdentity = {
      id: guildId,
      ...(typeof guild.name === 'string' && guild.name.trim() ? { name: guild.name.trim() } : {}),
      ...(guild.icon ? { iconUrl: guildIconUrl(guildId, guild.icon) } : {}),
    }
    await kv.put(key, JSON.stringify(identity), { expirationTtl: GUILD_METADATA_TTL_SECONDS })
    return identity
  }
  catch (error) {
    console.error('[discord] failed to cache guild display metadata', { guildId }, error)
    return { id: guildId }
  }
}

export async function getKnownGuildIdentities(
  kv: KVNamespace,
  token: string | undefined,
  guildIds: readonly string[],
): Promise<SourceGuildIdentity[]> {
  const identities = await Promise.all([...new Set(guildIds)].map(guildId => getKnownGuildIdentity(kv, token, guildId)))
  return identities.filter((identity): identity is SourceGuildIdentity => identity != null)
}

function normalizeGuildIdentity(value: unknown): SourceGuildIdentity | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SourceGuildIdentity>
  if (typeof candidate.id !== 'string' || !/^\d{17,20}$/.test(candidate.id)) return null
  return {
    id: candidate.id,
    ...(typeof candidate.name === 'string' && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
    ...(typeof candidate.iconUrl === 'string' && candidate.iconUrl.startsWith('https://') ? { iconUrl: candidate.iconUrl } : {}),
  }
}

function guildIconUrl(guildId: string, iconHash: string): string {
  const ext = iconHash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${ext}?size=64`
}

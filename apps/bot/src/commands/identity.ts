import { buildDiscordAvatarUrl } from '@civup/utils'

interface InteractionUser {
  id?: string
  username?: string
  global_name?: string | null
  avatar?: string | null
}

interface InteractionMember {
  nick?: string | null
  avatar?: string | null
  user?: InteractionUser
}

interface ResolvedInteractionData {
  resolved?: {
    users?: Record<string, InteractionUser>
    members?: Record<string, InteractionMember>
  }
}

export interface CommandIdentity {
  userId: string
  displayName: string
  avatarUrl: string
}

export interface InteractionIdentityContext {
  interaction: {
    guild_id?: string | null
    member?: InteractionMember
    user?: InteractionUser
    data?: unknown
  }
}

export function getIdentity(c: InteractionIdentityContext): CommandIdentity | null {
  const member = c.interaction.member
  const user = member?.user ?? c.interaction.user
  const userId = user?.id
  if (!userId) return null

  return {
    userId,
    displayName: resolveDisplayName(member?.nick, user.global_name, user.username, userId),
    avatarUrl: resolveAvatarUrl(c.interaction.guild_id, userId, member?.avatar, user.avatar),
  }
}

export function getIdentityByUserId(c: InteractionIdentityContext, userId: string): CommandIdentity | null {
  const self = getIdentity(c)
  if (self?.userId === userId) return self

  const resolved = (c.interaction.data as ResolvedInteractionData | undefined)?.resolved
  const user = resolved?.users?.[userId]
  if (!user) return null

  const member = resolved?.members?.[userId]
  return {
    userId,
    displayName: resolveDisplayName(member?.nick, user.global_name, user.username, user.id ?? userId),
    avatarUrl: resolveAvatarUrl(c.interaction.guild_id, userId, member?.avatar, user.avatar),
  }
}

function resolveDisplayName(nick: string | null | undefined, globalName: string | null | undefined, username: string | null | undefined, fallback: string): string {
  return normalizeName(nick) ?? normalizeName(globalName) ?? normalizeName(username) ?? fallback
}

function normalizeName(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

function resolveAvatarUrl(guildId: string | null | undefined, userId: string, memberAvatarHash: string | null | undefined, userAvatarHash: string | null | undefined): string {
  if (guildId && memberAvatarHash) return buildDiscordGuildMemberAvatarUrl(guildId, userId, memberAvatarHash)
  return buildDiscordAvatarUrl(userId, userAvatarHash ?? null)
}

function buildDiscordGuildMemberAvatarUrl(guildId: string, userId: string, avatarHash: string): string {
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png'
  return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${avatarHash}.${ext}?size=128`
}

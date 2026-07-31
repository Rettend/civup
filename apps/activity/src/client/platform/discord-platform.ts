import type { ActivityIdentity } from '@civup/utils'
import { buildDiscordAvatarUrl } from '@civup/utils'
import { configureClientPlatform } from './runtime'

export async function bootstrapDiscordPlatform(): Promise<{
  identity: ActivityIdentity
  channelId: string | null
}> {
  configureClientPlatform('discord-embedded', 'token')
  const { discordSdk, setupDiscordSdk } = await import('../discord')
  const auth = await setupDiscordSdk()
  return {
    identity: {
      userId: auth.user.id,
      displayName: auth.user.global_name ?? auth.user.username ?? null,
      avatarUrl: buildDiscordAvatarUrl(auth.user.id, auth.user.avatar),
    },
    channelId: discordSdk.channelId,
  }
}

import type { ApprovedDiscordGuildEnvironment } from '@civup/utils'
import { resolveApprovedDiscordGuildConfiguration } from '@civup/utils'

interface DiscordInteractionEnvelope {
  type?: number
  guild_id?: string | null
}

const DISCORD_AUTOCOMPLETE_INTERACTION_TYPE = 4
const DISCORD_AUTOCOMPLETE_RESULT_TYPE = 8
const DISCORD_CHANNEL_MESSAGE_WITH_SOURCE = 4
const DISCORD_EPHEMERAL_MESSAGE_FLAG = 1 << 6

export function rejectDisallowedDiscordGuildInteraction(
  interaction: DiscordInteractionEnvelope,
  env: ApprovedDiscordGuildEnvironment,
): Response | null {
  const config = resolveApprovedDiscordGuildConfiguration(env)
  if (config.ok && typeof interaction.guild_id === 'string' && config.guildIds.includes(interaction.guild_id)) return null

  if (interaction.type === DISCORD_AUTOCOMPLETE_INTERACTION_TYPE) {
    return Response.json({ type: DISCORD_AUTOCOMPLETE_RESULT_TYPE, data: { choices: [] } }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  return Response.json({
    type: DISCORD_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: DISCORD_EPHEMERAL_MESSAGE_FLAG,
      content: config.ok
        ? 'This bot is only available in an approved Discord server.'
        : 'Approved Discord server configuration is invalid.',
    },
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

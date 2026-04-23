import type { DiscordMessagePayload } from '../discord/index.ts'
import { createChannelMessage } from '../discord/index.ts'
import { getSystemChannel } from '../system/channels.ts'

type GeneralCommandResponse = string | DiscordMessagePayload

interface GeneralCommandResponseContext {
  env: {
    KV: KVNamespace
    DISCORD_TOKEN: string
  }
  interaction: {
    guild_id?: string
    channel?: { id?: string }
    channel_id?: string
  }
  followup: (data?: any) => Promise<unknown>
}

export async function sendGeneralCommandResponse(
  c: GeneralCommandResponseContext,
  payload: GeneralCommandResponse,
  options?: {
    createMessage?: typeof createChannelMessage
  },
): Promise<void> {
  const commandsChannelId = await getSystemChannel(c.env.KV, 'commands')
  const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
  if (!c.interaction.guild_id || !commandsChannelId || !interactionChannelId || interactionChannelId === commandsChannelId) {
    await c.followup(payload)
    return
  }

  try {
    await (options?.createMessage ?? createChannelMessage)(
      c.env.DISCORD_TOKEN,
      commandsChannelId,
      normalizeGeneralCommandPayload(payload),
    )
  }
  catch (error) {
    console.error(`Failed to post redirected command output to ${commandsChannelId}:`, error)
    await c.followup(payload)
    return
  }

  await c.followup({
    content: `Posted in <#${commandsChannelId}>.`,
    allowed_mentions: { parse: [] },
  })
}

export function normalizeGeneralCommandPayload(payload: GeneralCommandResponse): DiscordMessagePayload {
  if (typeof payload === 'string') {
    return {
      content: payload,
      allowed_mentions: { parse: [] },
    }
  }

  return {
    ...payload,
    allowed_mentions: payload.allowed_mentions ?? { parse: [] },
  }
}

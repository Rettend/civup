import type { DiscordMessagePayload } from '../discord/index.ts'
import { createChannelMessage } from '../discord/index.ts'
import { sendTransientEphemeralResponse } from './ephemeral.ts'
import { getSystemChannel } from '../system/channels.ts'

type GeneralCommandResponse = string | DiscordMessagePayload | null

interface GeneralCommandDeferredContext {
  executionCtx: {
    waitUntil: (promise: Promise<unknown>) => void
  }
  env: {
    KV: KVNamespace
    DISCORD_TOKEN: string
    [key: string]: any
  }
  interaction: {
    guild_id?: string
    channel?: { id?: string }
    channel_id?: string
  }
  followup: (data?: any) => Promise<unknown>
}

interface GeneralCommandResponseContext extends GeneralCommandDeferredContext {
  resDefer: (callback: (c: GeneralCommandDeferredContext) => Promise<void>) => Response | Promise<Response>
  flags: (value: 'EPHEMERAL') => {
    resDefer: (callback: (c: GeneralCommandDeferredContext) => Promise<void>) => Response | Promise<Response>
  }
}

export async function resDeferGeneralCommandResponse(
  c: GeneralCommandResponseContext,
  buildPayload: (c: GeneralCommandDeferredContext) => Promise<GeneralCommandResponse>,
  options?: {
    createMessage?: typeof createChannelMessage
    redirect?: boolean
  },
): Promise<Response> {
  const commandsChannelId = await getSystemChannel(c.env.KV, 'commands')
  const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
  const shouldRedirect = options?.redirect !== false
    && !!c.interaction.guild_id
    && !!commandsChannelId
    && !!interactionChannelId
    && interactionChannelId !== commandsChannelId

  const responder = shouldRedirect ? c.flags('EPHEMERAL') : c
  return await responder.resDefer(async (deferred) => {
    const payload = await buildPayload(deferred)
    if (payload == null) return
    if (!shouldRedirect || !commandsChannelId) {
      await deferred.followup(payload)
      return
    }

    try {
      await (options?.createMessage ?? createChannelMessage)(
        deferred.env.DISCORD_TOKEN,
        commandsChannelId,
        normalizeGeneralCommandPayload(payload),
      )
    }
    catch (error) {
      console.error(`Failed to post redirected command output to ${commandsChannelId}:`, error)
      await sendTransientEphemeralResponse(deferred, `Failed to post in <#${commandsChannelId}>.`, 'error')
      return
    }

    await sendTransientEphemeralResponse(deferred, `Posted in <#${commandsChannelId}>.`, 'info')
  }) as Response
}

export function normalizeGeneralCommandPayload(payload: string | DiscordMessagePayload): DiscordMessagePayload {
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

import type { AdminComponentContext } from './types.ts'
import { Button } from 'discord-hono'
import { createChannelMessage } from '../../services/discord.ts'
import {
  clearDeferredEphemeralResponse,
  sendTransientEphemeralResponse as sendRawTransientEphemeralResponse,
  SHOW_EPHEMERAL_RESPONSE_BUTTON_ID,
} from '../../services/ephemeral-response.ts'
import { factory } from '../../setup.ts'

export const component_admin_show_response = factory.component(
  new Button(SHOW_EPHEMERAL_RESPONSE_BUTTON_ID, 'Show', 'Secondary'),
  (c) => {
    return c.update().resDefer(async (c: AdminComponentContext) => {
      const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
      const sourceMessage = (c.interaction as {
        message?: {
          content?: unknown
          embeds?: unknown
        }
      }).message

      if (!channelId || !sourceMessage) {
        await sendRawTransientEphemeralResponse(c, 'Could not read the original response to share.', 'error', { showButton: false })
        return
      }

      const content = typeof sourceMessage.content === 'string' ? sourceMessage.content : null
      const embeds = Array.isArray(sourceMessage.embeds) ? sourceMessage.embeds : []
      if (!content && embeds.length === 0) {
        await sendRawTransientEphemeralResponse(c, 'There is nothing to share for this response.', 'error', { showButton: false })
        return
      }

      try {
        await createChannelMessage(c.env.DISCORD_TOKEN, channelId, { content, embeds })
      }
      catch (error) {
        console.error('Failed to share admin response publicly:', error)
        await sendRawTransientEphemeralResponse(c, 'Failed to share this response publicly. Please try again.', 'error', { showButton: false })
        return
      }

      await clearDeferredEphemeralResponse(c)
    })
  },
)

import { createDb } from '@civup/db'
import { Command } from 'discord-hono'
import { createChannelMessage } from '../services/discord/index.ts'
import { getMatchIdForMessage } from '../services/match/message.ts'
import { clearDeferredEphemeralResponse, sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { factory } from '../setup.ts'

export const command_match_id = factory.command(
  new Command('Match ID').type(3),
  (c) => {
    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const channelId = c.interaction.channel?.id ?? c.interaction.channel_id
      const targetMessageId = (c.interaction.data as { target_id?: string } | undefined)?.target_id
      if (!targetMessageId) {
        await sendTransientEphemeralResponse(c, 'Could not read the selected message.', 'error')
        return
      }

      const db = createDb(c.env.DB)
      const matchId = await getMatchIdForMessage(db, targetMessageId)

      if (!matchId) {
        await sendTransientEphemeralResponse(
          c,
          'No stored match ID for this one.',
          'error',
        )
        return
      }

      if (!channelId) {
        await sendTransientEphemeralResponse(c, `Match ID: \`${matchId}\``, 'info')
        return
      }

      try {
        await createChannelMessage(c.env.DISCORD_TOKEN, channelId, {
          content: `Match ID: \`${matchId}\``,
          allowed_mentions: { parse: [] },
        })
      }
      catch (error) {
        console.error('Failed to post match ID publicly:', error)
        await sendTransientEphemeralResponse(c, 'Failed to post the match ID in this channel. Please try again.', 'error')
        return
      }

      await clearDeferredEphemeralResponse(c)
    })
  },
)

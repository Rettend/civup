import { Command } from 'discord-hono'
import { sendTransientEphemeralResponse } from '../services/ephemeral-response.ts'
import { getMatchIdForMessage } from '../services/match-message.ts'
import { factory } from '../setup.ts'

export const command_match_id = factory.command(
  new Command('Match ID').type(3),
  (c) => {
    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const targetMessageId = (c.interaction.data as { target_id?: string } | undefined)?.target_id
      if (!targetMessageId) {
        await sendTransientEphemeralResponse(c, 'Could not read the selected message.', 'error')
        return
      }

      const matchId = await getMatchIdForMessage(c.env.KV, targetMessageId)
      if (!matchId) {
        await sendTransientEphemeralResponse(
          c,
          'No stored match ID for this message. Try a CivUp result/draft message from the last 180 days.',
          'error',
        )
        return
      }

      await sendTransientEphemeralResponse(c, `Match ID: \`${matchId}\``, 'info')
    })
  },
)

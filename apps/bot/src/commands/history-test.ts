import { Button, Command } from 'discord-hono'
import { createInteractionFollowupMessage } from '../services/discord/index.ts'
import { playerHistoryAlignmentTestEmbeds } from '../embeds/player-history.ts'
import { factory } from '../setup.ts'

const DISCORD_EPHEMERAL_MESSAGE_FLAG = 1 << 6
const HISTORY_TEST_REFRESH_COMPONENT_ID = 'historytest-refresh'

export const command_historytest = factory.command(
  new Command('historytest', 'Dev-only history alignment test embed'),
  (c) => {
    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const [firstEmbed, ...additionalEmbeds] = playerHistoryAlignmentTestEmbeds()
      if (!firstEmbed) return

      await c.followup({
        embeds: [firstEmbed],
        components: historyTestRefreshComponents(0),
        allowed_mentions: { parse: [] },
      })

      for (let index = 0; index < additionalEmbeds.length; index += 1) {
        const embed = additionalEmbeds[index]!
        await createInteractionFollowupMessage({
          applicationId: c.env.DISCORD_APPLICATION_ID,
          interactionToken: c.interaction.token,
          payload: {
            embeds: [embed],
            components: historyTestRefreshComponents(index + 1),
            flags: DISCORD_EPHEMERAL_MESSAGE_FLAG,
            allowed_mentions: { parse: [] },
          },
        })
      }
    })
  },
)

export const component_historytest_refresh = factory.component(
  new Button(HISTORY_TEST_REFRESH_COMPONENT_ID, 'Refresh', 'Secondary'),
  (c) => {
    const index = Number.parseInt(c.var.custom_id ?? '', 10)
    const embeds = playerHistoryAlignmentTestEmbeds()
    const embed = Number.isSafeInteger(index) ? embeds[index] : null
    if (!embed) return c.flags('EPHEMERAL').res('This history alignment sample is no longer available.')

    return c.update().res({
      embeds: [embed],
      components: historyTestRefreshComponents(index),
      allowed_mentions: { parse: [] },
    })
  },
)

function historyTestRefreshComponents(index: number) {
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 2,
      label: 'Refresh',
      custom_id: `${HISTORY_TEST_REFRESH_COMPONENT_ID};${index}`,
    }],
  }]
}

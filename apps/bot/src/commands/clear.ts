import { Command, Option } from 'discord-hono'
import { sendTransientEphemeralResponse } from '../services/ephemeral-response.ts'
import { factory } from '../setup.ts'

interface Var {
  count?: string
}

export const command_clear = factory.command<Var>(
  new Command('clear', 'Delete messages in the current channel').options(
    new Option('count', 'Number of messages to delete (1-100)')
      .required(),
  ),
  async (c) => {
    const permissions = BigInt(c.interaction.member?.permissions ?? '0')
    const MANAGE_MESSAGES = 1n << 13n

    if ((permissions & MANAGE_MESSAGES) === 0n) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'You need Manage Messages permission to use this command.', 'error')
      })
    }

    const count = Number.parseInt(c.var.count ?? '0', 10)

    if (Number.isNaN(count) || count < 1 || count > 100) {
      return c.flags('EPHEMERAL').resDefer(async (c) => {
        await sendTransientEphemeralResponse(c, 'Please provide a number between 1 and 100.', 'error')
      })
    }

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const channelId = c.interaction.channel?.id
      if (!channelId) {
        await sendTransientEphemeralResponse(c, 'Could not identify the channel.', 'error')
        return
      }

      try {
        const response = await c.rest('GET', '/channels/{channel.id}/messages', [channelId, { limit: count }])
        const body = await response.json()

        if (!Array.isArray(body)) {
          await sendTransientEphemeralResponse(c, 'Failed to fetch messages.', 'error')
          return
        }

        const messages = body as Array<{ id: string }>

        if (messages.length === 0) {
          await sendTransientEphemeralResponse(c, 'No messages found to delete.', 'error')
          return
        }

        const messageIds = messages.map(m => m.id)

        await c.rest('POST', '/channels/{channel.id}/messages/bulk-delete', [channelId], {
          messages: messageIds,
        })

        await sendTransientEphemeralResponse(c, `Successfully deleted ${messages.length} message${messages.length === 1 ? '' : 's'}.`, 'success')
      }
      catch (error) {
        console.error('Error clearing messages:', error)
        await sendTransientEphemeralResponse(c, 'Failed to delete messages. Make sure the messages are not older than 14 days.', 'error')
      }
    })
  },
)

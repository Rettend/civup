import { Command, Option } from 'discord-hono'
import { factory } from '../setup.ts'

interface Var {
  count?: string
}

const CLEAR_CONFIRM_AUTO_DELETE_MS = 5000

export const command_clear = factory.command<Var>(
  new Command('clear', 'Delete messages in the current channel').options(
    new Option('count', 'Number of messages to delete (1-100)')
      .required(),
  ),
  async (c) => {
    const permissions = BigInt(c.interaction.member?.permissions ?? '0')
    const MANAGE_MESSAGES = 1n << 13n

    if ((permissions & MANAGE_MESSAGES) === 0n) {
      return c.flags('EPHEMERAL').res('You need Manage Messages permission to use this command.')
    }

    const count = Number.parseInt(c.var.count ?? '0', 10)

    if (Number.isNaN(count) || count < 1 || count > 100) {
      return c.flags('EPHEMERAL').res('Please provide a number between 1 and 100.')
    }

    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const channelId = c.interaction.channel?.id
      if (!channelId) {
        await c.followup('Could not identify the channel.')
        return
      }

      try {
        const response = await c.rest('GET', '/channels/{channel.id}/messages', [channelId, { limit: count }])
        const body = await response.json()

        if (!Array.isArray(body)) {
          await c.followup('Failed to fetch messages.')
          return
        }

        const messages = body as Array<{ id: string }>

        if (messages.length === 0) {
          await c.followup('No messages found to delete.')
          return
        }

        const messageIds = messages.map(m => m.id)

        await c.rest('POST', '/channels/{channel.id}/messages/bulk-delete', [channelId], {
          messages: messageIds,
        })

        await c.followup(`Successfully deleted ${messages.length} message${messages.length === 1 ? '' : 's'}.`)

        c.executionCtx.waitUntil((async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, CLEAR_CONFIRM_AUTO_DELETE_MS))
            await c.followup()
          }
          catch (error) {
            console.error('Failed to auto-delete clear confirmation message:', error)
          }
        })())
      }
      catch (error) {
        console.error('Error clearing messages:', error)
        await c.followup('Failed to delete messages. Make sure the messages are not older than 14 days.')
      }
    })
  },
)

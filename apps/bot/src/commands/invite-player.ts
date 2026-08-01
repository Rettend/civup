import { createDb } from '@civup/db'
import { getApprovedDiscordGuildIds } from '@civup/utils'
import { Command } from 'discord-hono'
import { buildBrowserSessionUrl, resolveBrowserAccessConfig } from '../services/activity/browser-access.ts'
import { createChannelMessage, createDmChannel } from '../services/discord/index.ts'
import { sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { getOpenSessionLobbyProjectionForPlayer } from '../services/session/index.ts'
import { factory } from '../setup.ts'
import { getIdentity } from './match/shared.ts'

export const command_invite_player = factory.command(
  new Command('Invite Player').type(2),
  (c) => {
    return c.flags('EPHEMERAL').resDefer(async (c) => {
      const inviter = getIdentity(c)
      const targetUserId = (c.interaction.data as { target_id?: string } | undefined)?.target_id
      if (!inviter || !targetUserId) {
        await sendTransientEphemeralResponse(c, 'Could not identify the inviter or selected player.', 'error')
        return
      }

      const db = createDb(c.env.DB)
      const lobby = await getOpenSessionLobbyProjectionForPlayer(db, inviter.userId, { guildIds: getApprovedDiscordGuildIds(c.env) })
      if (!lobby) {
        await sendTransientEphemeralResponse(c, 'You need to be in an open lobby before inviting someone.', 'error')
        return
      }

      const guildId = lobby.guildId
      if (!guildId) {
        await sendTransientEphemeralResponse(c, 'Could not build a link to your lobby.', 'error')
        return
      }

      const lobbyLink = `https://discord.com/channels/${guildId}/${lobby.channelId}/${lobby.messageId}`
      const browserConfig = await resolveBrowserAccessConfig(c.env, guildId)
      const primaryLink = browserConfig ? buildBrowserSessionUrl(browserConfig, lobby.id) : lobbyLink
      const messageLink = browserConfig ? `\nDiscord message: ${lobbyLink}` : ''
      try {
        const dm = await createDmChannel(c.env.DISCORD_TOKEN, targetUserId)
        await createChannelMessage(c.env.DISCORD_TOKEN, dm.id, {
          content: `${inviter.displayName} invited you to a draft: ${primaryLink}${messageLink}`,
          allowed_mentions: { parse: [] },
        })
      }
      catch (error) {
        console.error('Failed to send lobby invite DM:', error)
        await sendTransientEphemeralResponse(c, 'Failed to DM that player. They may have DMs disabled.', 'error')
        return
      }

      await sendTransientEphemeralResponse(c, `<@${targetUserId}> has been invited to your lobby.`, 'success')
    })
  },
)

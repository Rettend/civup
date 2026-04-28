import type { AdminCommandContext } from './types.ts'
import { createDb } from '@civup/db'
import { editOriginalInteractionResponseWithFile } from '../../services/discord/index.ts'
import { buildPlayerDataExport } from '../../services/export/player-data.ts'
import { sendTransientEphemeralResponse } from './shared.ts'

const DISCORD_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024

export function handleExport(c: AdminCommandContext) {
  const guildId = c.interaction.guild_id
  if (!guildId) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, 'This command can only be used in a server.', 'error')
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    try {
      const interactionToken = getInteractionToken(c)
      if (!interactionToken) {
        await sendTransientEphemeralResponse(c, 'Discord did not provide an interaction token for the export.', 'error')
        return
      }

      const exportFile = await buildPlayerDataExport(createDb(c.env.DB))
      if (exportFile.data.byteLength > DISCORD_ATTACHMENT_LIMIT_BYTES) {
        await sendTransientEphemeralResponse(c, `Export is ${formatBytes(exportFile.data.byteLength)}, which is too large for Discord attachment upload.`, 'error')
        return
      }

      await editOriginalInteractionResponseWithFile({
        applicationId: c.env.DISCORD_APPLICATION_ID,
        interactionToken,
        filename: exportFile.filename,
        contentType: exportFile.contentType,
        data: exportFile.data,
      })
    }
    catch (error) {
      console.error('Failed to export player data:', error)
      await sendTransientEphemeralResponse(c, 'Failed to export player data.', 'error')
    }
  })
}

function getInteractionToken(c: AdminCommandContext): string | null {
  const token = c.interaction?.token
  return typeof token === 'string' && token.length > 0 ? token : null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}

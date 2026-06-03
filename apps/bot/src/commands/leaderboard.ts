import type { LeaderboardMode } from '@civup/game'
import type { Database } from '@civup/db'
import type { LeaderboardSnapshotRow } from '../services/leaderboard/snapshot.ts'
import { createDb } from '@civup/db'
import { LEADERBOARD_MODE_CHOICES, parseLeaderboardMode } from '@civup/game'
import { getLeaderboardMinGames } from '@civup/rating'
import { Command, Option } from 'discord-hono'
import { createChannelMessageWithFile, createInteractionFollowupMessageWithFile, editOriginalInteractionResponseWithFile } from '../services/discord/index.ts'
import { loadAvatarDataUris } from '../services/image/avatar.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { buildPlayerLeaderboardImageDataBatch, renderPlayerLeaderboardPng } from '../services/leaderboard/image.ts'
import { getStoredLeaderboardModeSnapshot, getStoredLeaderboardModeSnapshots } from '../services/leaderboard/snapshot.ts'
import { sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { factory } from '../setup.ts'

interface Var {
  mode?: string
}

interface LeaderboardCommandImage {
  mode: LeaderboardMode
  filename: string
  data: Uint8Array
}

type LeaderboardCommandResult = { content: string } | { images: LeaderboardCommandImage[] }

const LEADERBOARD_COMMAND_MODES = ['duel', 'duo', 'squad', 'ffa'] as const satisfies readonly LeaderboardMode[]

export const command_leaderboard = factory.command<Var>(
  new Command('leaderboard', 'Show the top players').options(
    new Option('mode', 'Leaderboard track')
      .choices(...LEADERBOARD_MODE_CHOICES),
  ),
  async (c) => {
    const requestedMode = c.var.mode ? parseLeaderboardMode(c.var.mode) : null
    const kv = getKvStore(c.env)
    const commandsChannelId = await getSystemChannel(kv, 'commands')
    const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const shouldRedirect = !!c.interaction.guild_id
      && !!commandsChannelId
      && !!interactionChannelId
      && interactionChannelId !== commandsChannelId
    const responder = shouldRedirect ? c.flags('EPHEMERAL') : c

    return responder.resDefer(async (c) => {
      const result = await buildLeaderboardCommandImages(createDb(c.env.DB), kv, requestedMode)

      if ('content' in result) {
        await c.followup({ content: result.content, allowed_mentions: { parse: [] } })
        return
      }

      if (shouldRedirect && commandsChannelId) {
        try {
          for (const image of result.images) {
            await createChannelMessageWithFile({
              token: c.env.DISCORD_TOKEN,
              channelId: commandsChannelId,
              filename: image.filename,
              contentType: 'image/png',
              data: image.data,
            })
          }
        }
        catch (error) {
          console.error(`Failed to post redirected leaderboard output to ${commandsChannelId}:`, error)
          await sendTransientEphemeralResponse(c, `Failed to post in <#${commandsChannelId}>.`, 'error')
          return
        }

        await sendTransientEphemeralResponse(c, `Posted in <#${commandsChannelId}>.`, 'info')
        return
      }

      const [firstImage, ...additionalImages] = result.images
      if (!firstImage) return
      await editOriginalInteractionResponseWithFile({
        applicationId: c.env.DISCORD_APPLICATION_ID,
        interactionToken: c.interaction.token,
        filename: firstImage.filename,
        contentType: 'image/png',
        data: firstImage.data,
      })

      for (const image of additionalImages) {
        await createInteractionFollowupMessageWithFile({
          applicationId: c.env.DISCORD_APPLICATION_ID,
          interactionToken: c.interaction.token,
          filename: image.filename,
          contentType: 'image/png',
          data: image.data,
        })
      }
    })
  },
)

export async function buildLeaderboardCommandImages(
  db: Database,
  kv: KVNamespace,
  requestedMode: LeaderboardMode | null,
): Promise<LeaderboardCommandResult> {
  if (requestedMode) {
    const snapshot = await getStoredLeaderboardModeSnapshot(kv, requestedMode)
    if (!snapshot) return { content: 'Leaderboard snapshot is not available yet. Ask a moderator to run a leaderboard refresh.' }
    return { images: await buildLeaderboardCommandImagesForModes(db, [{ mode: requestedMode, rows: snapshot.rows }]) }
  }

  const snapshots = await getStoredLeaderboardModeSnapshots(kv, LEADERBOARD_COMMAND_MODES)
  if (snapshots.size === 0) {
    return { content: 'Leaderboard snapshot is not available yet. Ask a moderator to run a leaderboard refresh.' }
  }

  const modes = LEADERBOARD_COMMAND_MODES.flatMap((mode) => {
    const snapshot = snapshots.get(mode)
    if (!snapshot || !snapshot.rows.some(row => row.gamesPlayed >= getLeaderboardMinGames(mode))) return []
    return [mode]
  })

  if (modes.length === 0) {
    return { content: 'No players with enough games to rank yet.' }
  }

  return { images: await buildLeaderboardCommandImagesForModes(db, modes.map(mode => ({ mode, rows: snapshots.get(mode)!.rows }))) }
}

async function buildLeaderboardCommandImagesForModes(
  db: Database,
  inputs: readonly { mode: LeaderboardMode, rows: readonly LeaderboardSnapshotRow[] }[],
): Promise<LeaderboardCommandImage[]> {
  const imageData = await buildPlayerLeaderboardImageDataBatch(db, inputs)
  const avatarData = await loadAvatarDataUris(imageData.flatMap(data => data.rows))
  const images: LeaderboardCommandImage[] = []

  for (const data of imageData) {
    images.push({
      mode: data.mode,
      filename: `leaderboard-${data.mode}.png`,
      data: await renderPlayerLeaderboardPng(data, { avatarData }),
    })
  }

  return images
}

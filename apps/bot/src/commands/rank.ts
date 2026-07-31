import type { Database } from '@civup/db'
import type { RankGraphScope } from '../services/player/rank-graph.ts'
import type { StatsContext } from '../services/stats/context.ts'
import { createDb } from '@civup/db'
import { Command, Option } from 'discord-hono'
import { getIdentityByUserId } from './identity.ts'
import { createChannelMessageWithFile, editOriginalInteractionResponseWithFile } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { buildRankGraphImageData, parseRankGraphScope, renderRankGraphPng } from '../services/player/rank-graph.ts'
import { upsertPlayerProfile } from '../services/player/profile.ts'
import { sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { factory } from '../setup.ts'
import { createStatsContext } from '../services/stats/context.ts'

interface Var {
  player?: string
  mode?: string
  games?: string
}

interface RankCommandImage {
  filename: string
  data: Uint8Array
}

type RankCommandResult = { content: string } | { image: RankCommandImage }

export const RANK_GRAPH_MODE_CHOICES = [
  { name: 'Overall', value: 'overall' },
  { name: 'Duel', value: 'duel' },
  { name: 'Duo', value: 'duo' },
  { name: 'Squad', value: 'squad' },
  { name: 'FFA', value: 'ffa' },
] as const

export const RANK_GRAPH_GAME_CHOICES = [
  { name: 'Last 20', value: '20' },
  { name: 'Last 50', value: '50' },
  { name: 'Last 100', value: '100' },
  { name: 'Last 200', value: '200' },
] as const

const DEFAULT_RANK_GRAPH_GAMES = 20

export const command_rank = factory.command<Var>(
  new Command('rank', 'View ranked rating history').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Rating track').choices(...RANK_GRAPH_MODE_CHOICES),
    new Option('games', 'X-axis window').choices(...RANK_GRAPH_GAME_CHOICES),
  ),
  async (c) => {
    const guildId = c.interaction.guild_id
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const scope = parseRankGraphScope(c.var.mode) ?? 'overall'
    const gameLimit = parseRankGraphGameLimit(c.var.games)
    const isDefaultSelfLookup = !c.var.player && !c.var.mode && !c.var.games

    if (!guildId) return c.res('This command can only be used in a server.')
    if (!targetId) return c.res('Could not identify the player.')
    if (c.var.mode && !parseRankGraphScope(c.var.mode)) return c.res('Pick a rank mode.')
    if (c.var.games && gameLimit == null) return c.res('Pick a game window.')

    const kv = getKvStore(c.env)
    const commandsChannelId = await getSystemChannel(kv, 'commands', { guildId, legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
    const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const shouldRedirect = !isDefaultSelfLookup
      && !!commandsChannelId
      && !!interactionChannelId
      && interactionChannelId !== commandsChannelId
    const responder = isDefaultSelfLookup || shouldRedirect ? c.flags('EPHEMERAL') : c

    return responder.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const identity = getIdentityByUserId(c, targetId)
      if (identity) {
        await upsertPlayerProfile(db, {
          playerId: identity.userId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        })
      }

      const result = await buildRankCommandImage(db, kv, createStatsContext(guildId, c.env.ALLOWED_DISCORD_GUILD_ID ?? ''), targetId, {
        scope,
        gameLimit: gameLimit ?? DEFAULT_RANK_GRAPH_GAMES,
      })
      if ('content' in result) {
        await c.followup({ content: result.content, allowed_mentions: { parse: [] } })
        return
      }

      if (shouldRedirect && commandsChannelId) {
        try {
          await createChannelMessageWithFile({
            token: c.env.DISCORD_TOKEN,
            channelId: commandsChannelId,
            filename: result.image.filename,
            contentType: 'image/png',
            data: result.image.data,
          })
        }
        catch (error) {
          console.error(`Failed to post redirected rank graph output to ${commandsChannelId}:`, error)
          await sendTransientEphemeralResponse(c, `Failed to post in <#${commandsChannelId}>.`, 'error')
          return
        }

        await sendTransientEphemeralResponse(c, `Posted in <#${commandsChannelId}>.`, 'info')
        return
      }

      await editOriginalInteractionResponseWithFile({
        applicationId: c.env.DISCORD_APPLICATION_ID,
        interactionToken: c.interaction.token,
        filename: result.image.filename,
        contentType: 'image/png',
        data: result.image.data,
      })
    })
  },
)

export async function buildRankCommandImage(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  playerId: string,
  options: {
    scope: RankGraphScope
    gameLimit: number
  },
): Promise<RankCommandResult> {
  const data = await buildRankGraphImageData(db, kv, statsContext, playerId, options)
  if (data.player.points.length === 0) {
    return { content: 'No ranked games found for this view.' }
  }

  return {
    image: {
      filename: `rank-${data.scope}-${data.gameLimit}.png`,
      data: await renderRankGraphPng(data),
    },
  }
}

function parseRankGraphGameLimit(value: string | null | undefined): number | null {
  if (value == null || value.trim().length === 0) return DEFAULT_RANK_GRAPH_GAMES
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) return null
  const rounded = Math.round(normalized)
  return RANK_GRAPH_GAME_CHOICES.some(choice => choice.value === String(rounded)) ? rounded : null
}

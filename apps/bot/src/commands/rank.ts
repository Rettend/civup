import type { RankGraphScope } from '../services/player/rank-graph.ts'
import type { SeasonSelection } from '../services/season/selection.ts'
import type { Database } from '@civup/db'
import { Autocomplete, Command, Option } from 'discord-hono'
import { createDb } from '@civup/db'
import { createChannelMessageWithFile, editOriginalInteractionResponseWithFile } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { upsertPlayerProfile } from '../services/player/profile.ts'
import { buildRankGraphImageData, parseRankGraphScope, renderRankGraphPng } from '../services/player/rank-graph.ts'
import { getDivisionRankPolicy, previewSavedDivisionRanks } from '../services/ranked/division-rank-runtime.ts'
import { getAssignedRankRoleId } from '../services/ranked/roles.ts'
import { sendTransientEphemeralResponse } from '../services/response/ephemeral.ts'
import {
  parseSeasonSelection,
  resolveSeasonSelection,
  seasonAutocompleteChoices,
} from '../services/season/selection.ts'
import { getSystemChannel } from '../services/system/channels.ts'
import { factory } from '../setup.ts'
import { getIdentityByUserId } from './identity.ts'

interface Var {
  player?: string
  mode?: string
  games?: string
  season?: string
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

export const command_rank = factory.autocomplete<Var>(
  new Command('rank', 'View ranked rating history').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Rating track').choices(...RANK_GRAPH_MODE_CHOICES),
    new Option('games', 'X-axis window').choices(...RANK_GRAPH_GAME_CHOICES),
    new Option('season', 'Choose a season').autocomplete(),
  ),
  async c => {
    const input = typeof c.focused?.value === 'string' ? c.focused.value : ''
    return c.resAutocomplete(
      new Autocomplete(input).choices(...(await seasonAutocompleteChoices(createDb(c.env.DB), input, false))),
    )
  },
  async c => {
    const guildId = c.interaction.guild_id
    const targetId = c.var.player ?? c.interaction.member?.user?.id ?? c.interaction.user?.id
    const scope = parseRankGraphScope(c.var.mode) ?? 'overall'
    const gameLimit = parseRankGraphGameLimit(c.var.games)
    const isDefaultSelfLookup = !c.var.player && !c.var.mode && !c.var.games && !c.var.season
    let season: SeasonSelection
    try {
      season = parseSeasonSelection(c.var.season, false)
    } catch (error) {
      return c.res(error instanceof Error ? error.message : 'Choose a season.')
    }

    if (!guildId) return c.res('This command can only be used in a server.')
    if (!targetId) return c.res('Could not identify the player.')
    if (c.var.mode && !parseRankGraphScope(c.var.mode)) return c.res('Pick a rank mode.')
    if (c.var.games && gameLimit == null) return c.res('Pick a game window.')

    const kv = getKvStore(c.env)
    const commandsChannelId = await getSystemChannel(kv, 'commands')
    const interactionChannelId = c.interaction.channel?.id ?? c.interaction.channel_id ?? null
    const shouldRedirect =
      !isDefaultSelfLookup &&
      !!commandsChannelId &&
      !!interactionChannelId &&
      interactionChannelId !== commandsChannelId
    const responder = isDefaultSelfLookup || shouldRedirect ? c.flags('EPHEMERAL') : c

    return responder.resDefer(async c => {
      const db = createDb(c.env.DB)
      const identity = getIdentityByUserId(c, targetId)
      if (identity) {
        await upsertPlayerProfile(db, {
          playerId: identity.userId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        })
      }

      const result = await buildRankCommandImage(db, kv, guildId, targetId, {
        scope,
        gameLimit: gameLimit ?? DEFAULT_RANK_GRAPH_GAMES,
        season,
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
        } catch (error) {
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
  guildId: string,
  playerId: string,
  options: {
    scope: RankGraphScope
    gameLimit: number
    season?: SeasonSelection
  },
): Promise<RankCommandResult> {
  if (options.scope === 'overall') {
    const policy = await getDivisionRankPolicy(db, guildId)
    if (policy?.phase === 'active') {
      const { season } = await resolveSeasonSelection(db, options.season ?? 'current')
      if (season?.id === policy.seasonId) {
        const preview = await previewSavedDivisionRanks(db, kv, guildId, [playerId])
        const assignment = preview.playerPreviews[0]?.assignment
        const roleId = assignment ? getAssignedRankRoleId(preview.config, assignment) : preview.config.unrankedRoleId
        return { content: `<@${playerId}> - ${roleId ? `<@&${roleId}>` : 'Unranked'}` }
      }
    }
  }
  let data
  try {
    data = await buildRankGraphImageData(db, kv, guildId, playerId, options)
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'Could not load rating history.' }
  }
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

import type { Database } from '@civup/db'
import type { DiscordMessagePayload } from '../services/discord/index.ts'
import type { PlayerHistoryModeFilter } from '../embeds/player-history.ts'
import { createDb } from '@civup/db'
import { GAME_MODE_CHOICES, parseGameMode } from '@civup/game'
import { Command, Option } from 'discord-hono'
import { playerHistoryPageEmbed } from '../embeds/player-history.ts'
import { paginationComponents } from '../services/response/pagination.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { upsertPlayerProfiles } from '../services/player/profile.ts'
import { factory } from '../setup.ts'
import { getIdentityByUserId } from './identity.ts'

const HISTORY_PAGINATION_NAMESPACE = 'history'

interface Var {
  player?: string
  mode?: string
}

export const command_history = factory.command<Var>(
  new Command('history', 'Show recent match history').options(
    new Option('player', 'Player to look up (defaults to you)', 'User'),
    new Option('mode', 'Filter by game mode').choices(...GAME_MODE_CHOICES),
  ),
  (c) => {
    const targetId = c.var.player
      ?? c.interaction.member?.user?.id
      ?? c.interaction.user?.id
    const mode = (parseGameMode(c.var.mode) ?? 'all') as PlayerHistoryModeFilter
    const isDefaultSelfLookup = !c.var.player && !c.var.mode

    if (!targetId) return c.res('Could not identify the player.')

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const identity = getIdentityByUserId(c, targetId)
      if (identity) {
        await upsertPlayerProfiles(db, [{
          playerId: identity.userId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
        }])
      }
      return buildPlayerHistoryCommandPayload(db, targetId, mode)
    }, {
      ephemeral: isDefaultSelfLookup,
    })
  },
)

export async function buildPlayerHistoryCommandPayload(
  db: Database,
  playerId: string,
  mode: PlayerHistoryModeFilter,
  options: {
    pageIndex?: number
  } = {},
): Promise<DiscordMessagePayload> {
  const page = await playerHistoryPageEmbed(db, playerId, mode, { pageIndex: options.pageIndex })
  return {
    embeds: [page.embed],
    components: paginationComponents({
      namespace: HISTORY_PAGINATION_NAMESPACE,
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      args: [playerId, mode],
    }),
    allowed_mentions: { parse: [] },
  }
}

export function isPlayerHistoryPaginationNamespace(value: string): boolean {
  return value === HISTORY_PAGINATION_NAMESPACE
}

export function parsePlayerHistoryMode(value: string | undefined): PlayerHistoryModeFilter | null {
  if (value === 'all') return 'all'
  return parseGameMode(value)
}

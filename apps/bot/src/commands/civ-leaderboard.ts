import type { Database } from '@civup/db'
import type { DiscordMessagePayload } from '../services/discord/index.ts'
import type { CivLeaderboardBoard } from '../embeds/civ-leaderboard.ts'
import type { CivLeaderboardModeScope } from '../services/leaderboard/civ-snapshot.ts'
import type { StatsContext } from '../services/stats/context.ts'
import { createDb } from '@civup/db'
import { Command, Option } from 'discord-hono'
import { civLeaderboardPageEmbed, parseCivLeaderboardBoard } from '../embeds/civ-leaderboard.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { CIV_LEADERBOARD_MODE_SCOPES, getStoredCivLeaderboardSnapshot, isCivLeaderboardStatsInitialized, rebuildCivLeaderboardSnapshot } from '../services/leaderboard/civ-snapshot.ts'
import { paginationComponents } from '../services/response/pagination.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { resolveStatsContext } from '../services/stats/context.ts'
import { factory } from '../setup.ts'

const CIV_LEADERBOARD_UNAVAILABLE_MESSAGE = 'Civ leaderboard snapshot is not available yet.'
const CIV_LEADERBOARD_UNINITIALIZED_MESSAGE = 'Civ leaderboard history is not initialized yet.'
const CIV_LEADERBOARD_PAGINATION_NAMESPACE = 'civleaderboard'

const CIV_LEADERBOARD_MODE_CHOICES = [
  { name: 'Picked', value: 'picked' },
  { name: 'Win Rate', value: 'winrate' },
  { name: 'Banned', value: 'banned' },
] as const

const CIV_LEADERBOARD_SCOPE_CHOICES = [
  { name: 'All', value: 'all' },
  { name: 'Duel', value: 'duel' },
  { name: 'Duo', value: 'duo' },
  { name: 'Squad', value: 'squad' },
] as const

const CIV_LEADERBOARD_SCOPE_TITLES: Record<CivLeaderboardModeScope, string | undefined> = {
  all: undefined,
  duel: 'Duel',
  duo: 'Duo',
  squad: 'Squad',
}

interface Var {
  mode?: string
  scope?: string
}

export const command_civleaderboard = factory.command<Var>(
  new Command('civleaderboard', 'Show leader pick, win rate, and ban stats').options(
    new Option('mode', 'Civ leaderboard view').required().choices(...CIV_LEADERBOARD_MODE_CHOICES),
    new Option('scope', 'Civ leaderboard scope').choices(...CIV_LEADERBOARD_SCOPE_CHOICES),
  ),
  (c) => {
    const board = parseCivLeaderboardBoard(c.var.mode)
    if (!board) return c.res('Pick a civ leaderboard mode.')
    const modeScope = parseCivLeaderboardModeScope(c.var.scope) ?? 'all'

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      return buildCivLeaderboardCommandPayload(db, kv, board, resolveStatsContext(c.interaction.guild_id, c.env), { modeScope })
    })
  },
)

export async function buildCivLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  board: CivLeaderboardBoard | null,
  statsContext: StatsContext,
  options: {
    pageIndex?: number
    modeScope?: CivLeaderboardModeScope
  } = {},
): Promise<DiscordMessagePayload> {
  const modeScope = options.modeScope ?? 'all'
  const snapshot = await getOrRebuildCivLeaderboardSnapshot(db, kv, statsContext, modeScope)
  if (!snapshot?.historyInitialized) return unavailablePayload(CIV_LEADERBOARD_UNINITIALIZED_MESSAGE)
  if (!board) return unavailablePayload('Pick a civ leaderboard mode.')

  const page = civLeaderboardPageEmbed(board, snapshot, { pageIndex: options.pageIndex, titlePrefix: CIV_LEADERBOARD_SCOPE_TITLES[modeScope] })
  return {
    embeds: [page.embed],
    components: paginationComponents({
      namespace: CIV_LEADERBOARD_PAGINATION_NAMESPACE,
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      args: modeScope === 'all' ? [board] : [board, modeScope],
    }),
    allowed_mentions: { parse: [] },
  }
}

export function parseCivLeaderboardModeScope(value: string | undefined): CivLeaderboardModeScope | null {
  return CIV_LEADERBOARD_MODE_SCOPES.includes(value as CivLeaderboardModeScope) ? value as CivLeaderboardModeScope : null
}

export function isCivLeaderboardPaginationNamespace(value: string): boolean {
  return value === CIV_LEADERBOARD_PAGINATION_NAMESPACE
}

function unavailablePayload(content = CIV_LEADERBOARD_UNAVAILABLE_MESSAGE): DiscordMessagePayload {
  return {
    content,
    embeds: [],
    components: [],
    allowed_mentions: { parse: [] },
  }
}

async function getOrRebuildCivLeaderboardSnapshot(db: Database, kv: KVNamespace, statsContext: StatsContext, modeScope: CivLeaderboardModeScope) {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv, statsContext, modeScope)
  if (snapshot?.historyInitialized) return snapshot
  if (!await isCivLeaderboardStatsInitialized(db, statsContext)) return snapshot
  return rebuildCivLeaderboardSnapshot(db, kv, statsContext, Date.now(), modeScope)
}

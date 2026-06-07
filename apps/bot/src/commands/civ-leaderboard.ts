import type { Database } from '@civup/db'
import type { DiscordMessagePayload } from '../services/discord/index.ts'
import type { CivLeaderboardBoard } from '../embeds/civ-leaderboard.ts'
import { createDb } from '@civup/db'
import { Command, Option } from 'discord-hono'
import { civLeaderboardPageEmbed, parseCivLeaderboardBoard } from '../embeds/civ-leaderboard.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { getStoredCivLeaderboardSnapshot, isCivLeaderboardStatsInitialized, rebuildCivLeaderboardSnapshot } from '../services/leaderboard/civ-snapshot.ts'
import { paginationComponents } from '../services/response/pagination.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { factory } from '../setup.ts'

const CIV_LEADERBOARD_UNAVAILABLE_MESSAGE = 'Civ leaderboard snapshot is not available yet.'
const CIV_LEADERBOARD_UNINITIALIZED_MESSAGE = 'Civ leaderboard history is not initialized yet.'
const CIV_LEADERBOARD_PAGINATION_NAMESPACE = 'civleaderboard'

const CIV_LEADERBOARD_MODE_CHOICES = [
  { name: 'Picked', value: 'picked' },
  { name: 'Win Rate', value: 'winrate' },
  { name: 'Banned', value: 'banned' },
] as const

interface Var {
  mode?: string
}

export const command_civleaderboard = factory.command<Var>(
  new Command('civleaderboard', 'Show leader pick, win rate, and ban stats').options(
    new Option('mode', 'Civ leaderboard view').required().choices(...CIV_LEADERBOARD_MODE_CHOICES),
  ),
  (c) => {
    const board = parseCivLeaderboardBoard(c.var.mode)
    if (!board) return c.res('Pick a civ leaderboard mode.')

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      return buildCivLeaderboardCommandPayload(db, kv, board)
    })
  },
)

export async function buildCivLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  board: CivLeaderboardBoard | null,
  options: {
    pageIndex?: number
  } = {},
): Promise<DiscordMessagePayload> {
  const snapshot = await getOrRebuildCivLeaderboardSnapshot(db, kv)
  if (!snapshot?.historyInitialized) return unavailablePayload(CIV_LEADERBOARD_UNINITIALIZED_MESSAGE)
  if (!board) return unavailablePayload('Pick a civ leaderboard mode.')

  const page = civLeaderboardPageEmbed(board, snapshot, { pageIndex: options.pageIndex })
  return {
    embeds: [page.embed],
    components: paginationComponents({
      namespace: CIV_LEADERBOARD_PAGINATION_NAMESPACE,
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      args: [board],
    }),
    allowed_mentions: { parse: [] },
  }
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

async function getOrRebuildCivLeaderboardSnapshot(db: Database, kv: KVNamespace) {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv)
  if (snapshot?.historyInitialized) return snapshot
  if (!await isCivLeaderboardStatsInitialized(db)) return snapshot
  return rebuildCivLeaderboardSnapshot(db, kv)
}

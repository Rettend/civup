import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { Embed } from 'discord-hono'
import { createDb } from '@civup/db'
import { LEADERBOARD_MODE_CHOICES, LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { getLeaderboardMinGames } from '@civup/rating'
import { Command, Option } from 'discord-hono'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { ensureLeaderboardModeSnapshot, ensureLeaderboardModeSnapshots } from '../services/leaderboard/snapshot.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { factory } from '../setup.ts'

interface Var {
  mode?: string
}

export const command_leaderboard = factory.command<Var>(
  new Command('leaderboard', 'Show the top players').options(
    new Option('mode', 'Leaderboard track')
      .choices(...LEADERBOARD_MODE_CHOICES),
  ),
  (c) => {
    const requestedMode = c.var.mode ? parseLeaderboardMode(c.var.mode) : null

    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      return await buildLeaderboardCommandPayload(db, kv, requestedMode)
    })
  },
)

export async function buildLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  requestedMode: LeaderboardMode | null,
): Promise<{ embeds?: Embed[], content?: string }> {
  if (requestedMode) {
    const snapshot = await ensureLeaderboardModeSnapshot(db, kv, requestedMode)
    return { embeds: [leaderboardEmbed(requestedMode, snapshot.rows)] }
  }

  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, LEADERBOARD_MODES)
  const embeds = LEADERBOARD_MODES.flatMap((mode) => {
    const snapshot = snapshots.get(mode)
    if (!snapshot || !snapshot.rows.some(row => row.gamesPlayed >= getLeaderboardMinGames(mode))) return []
    return [leaderboardEmbed(mode, snapshot.rows)]
  })

  if (embeds.length === 0) {
    return { content: 'No players with enough games to rank yet.' }
  }

  return { embeds }
}

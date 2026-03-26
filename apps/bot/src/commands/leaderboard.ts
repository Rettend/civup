import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import { createDb } from '@civup/db'
import { LEADERBOARD_MODE_CHOICES, LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { buildLeaderboard } from '@civup/rating'
import { Command, Option } from 'discord-hono'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { ensureLeaderboardModeSnapshot, ensureLeaderboardModeSnapshots } from '../services/leaderboard/snapshot.ts'
import { createStateStore } from '../services/state/store.ts'
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

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const kv = createStateStore(c.env)
      const payload = await buildLeaderboardCommandPayload(db, kv, requestedMode)
      await c.followup(payload)
    })
  },
)

export async function buildLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  requestedMode: LeaderboardMode | null,
): Promise<{ embeds?: ReturnType<typeof leaderboardEmbed>[], content?: string }> {
  if (requestedMode) {
    const snapshot = await ensureLeaderboardModeSnapshot(db, kv, requestedMode)
    return { embeds: [leaderboardEmbed(requestedMode, snapshot.rows)] }
  }

  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, LEADERBOARD_MODES)
  const embeds = LEADERBOARD_MODES.flatMap((mode) => {
    const snapshot = snapshots.get(mode)
    if (!snapshot || buildLeaderboard([...snapshot.rows]).length === 0) return []
    return [leaderboardEmbed(mode, snapshot.rows)]
  })

  if (embeds.length === 0) {
    return { content: 'No players with enough games to rank yet.' }
  }

  return { embeds }
}

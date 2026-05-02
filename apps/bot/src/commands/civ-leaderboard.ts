import type { Database } from '@civup/db'
import type { Embed } from 'discord-hono'
import { createDb } from '@civup/db'
import { Command } from 'discord-hono'
import { civLeaderboardEmbedGroups, civLeaderboardEmbeds } from '../embeds/civ-leaderboard.ts'
import type { DiscordMessagePayload } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { ensureCivLeaderboardSnapshot } from '../services/leaderboard/civ-snapshot.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { factory } from '../setup.ts'

export const command_civleaderboard = factory.command(
  new Command('civleaderboard', 'Show the top leaders'),
  (c) => {
    return resDeferGeneralCommandResponse(c, async (c) => {
      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      return await buildCivLeaderboardCommandPayloads(db, kv)
    })
  },
)

export async function buildCivLeaderboardCommandPayloads(
  db: Database,
  kv: KVNamespace,
): Promise<DiscordMessagePayload[]> {
  const snapshot = await ensureCivLeaderboardSnapshot(db, kv)
  return civLeaderboardEmbedGroups(snapshot).map(embeds => ({ embeds }))
}

export async function buildCivLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
): Promise<{ embeds?: Embed[], content?: string }> {
  const snapshot = await ensureCivLeaderboardSnapshot(db, kv)
  return { embeds: civLeaderboardEmbeds(snapshot) }
}

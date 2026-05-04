import type { Embed } from 'discord-hono'
import { Command } from 'discord-hono'
import { civLeaderboardEmbedGroups, civLeaderboardEmbeds } from '../embeds/civ-leaderboard.ts'
import type { DiscordMessagePayload } from '../services/discord/index.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { getStoredCivLeaderboardSnapshot } from '../services/leaderboard/civ-snapshot.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { factory } from '../setup.ts'

export const command_civleaderboard = factory.command(
  new Command('civleaderboard', 'Show the top leaders'),
  (c) => {
    return resDeferGeneralCommandResponse(c, async (c) => {
      const kv = getKvStore(c.env)
      return await buildCivLeaderboardCommandPayloads(kv)
    })
  },
)

export async function buildCivLeaderboardCommandPayloads(
  kv: KVNamespace,
): Promise<DiscordMessagePayload[]> {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv)
  if (!snapshot) return [{ content: 'Civ leaderboard snapshot is not available yet. Ask a moderator to run the civ leaderboard backfill or refresh.' }]
  return civLeaderboardEmbedGroups(snapshot).map(embeds => ({ embeds }))
}

export async function buildCivLeaderboardCommandPayload(
  kv: KVNamespace,
): Promise<{ embeds?: Embed[], content?: string }> {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv)
  if (!snapshot) return { content: 'Civ leaderboard snapshot is not available yet. Ask a moderator to run the civ leaderboard backfill or refresh.' }
  return { embeds: civLeaderboardEmbeds(snapshot) }
}

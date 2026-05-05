import type { Embed } from 'discord-hono'
import type { DiscordMessagePayload } from '../services/discord/index.ts'
import { Command } from 'discord-hono'
import { civLeaderboardEmbedGroups, civLeaderboardEmbeds } from '../embeds/civ-leaderboard.ts'
import { getKvStore } from '../services/kv/batch.ts'
import { getStoredCivLeaderboardSnapshot } from '../services/leaderboard/civ-snapshot.ts'
import { resDeferGeneralCommandResponse } from '../services/response/general.ts'
import { factory } from '../setup.ts'

const CIV_LEADERBOARD_UNAVAILABLE_MESSAGE = 'Civ leaderboard snapshot is not available yet. Run the PPL civ leaderboard backfill script first.'

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
  if (!snapshot?.historyInitialized) return [{ content: CIV_LEADERBOARD_UNAVAILABLE_MESSAGE }]
  return civLeaderboardEmbedGroups(snapshot).map(embeds => ({ embeds }))
}

export async function buildCivLeaderboardCommandPayload(
  kv: KVNamespace,
): Promise<{ embeds?: Embed[], content?: string }> {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv)
  if (!snapshot?.historyInitialized) return { content: CIV_LEADERBOARD_UNAVAILABLE_MESSAGE }
  return { embeds: civLeaderboardEmbeds(snapshot) }
}

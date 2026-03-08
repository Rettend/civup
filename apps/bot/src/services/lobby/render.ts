import type { QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import { maxPlayerCount } from '@civup/game'
import { lobbyComponents, lobbyOpenEmbed } from '../../embeds/match.ts'
import { getConfiguredRankedRoleId, getRankedRoleConfig } from '../ranked/roles.ts'

export async function buildOpenLobbyRenderPayload(
  kv: KVNamespace,
  lobby: LobbyState,
  entries: (QueueEntry | null)[],
): Promise<{ embeds: [ReturnType<typeof lobbyOpenEmbed>], components: ReturnType<typeof lobbyComponents> }> {
  const minRoleId = await resolveLobbyMinRoleId(kv, lobby)

  return {
    embeds: [lobbyOpenEmbed(lobby.mode, entries, maxPlayerCount(lobby.mode), minRoleId)],
    components: lobbyComponents(lobby.mode, lobby.id),
  }
}

async function resolveLobbyMinRoleId(kv: KVNamespace, lobby: LobbyState): Promise<string | null> {
  if (!lobby.guildId || !lobby.minRole) return null
  const config = await getRankedRoleConfig(kv, lobby.guildId)
  return getConfiguredRankedRoleId(config, lobby.minRole)
}

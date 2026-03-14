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
  const { minRoleId, maxRoleId } = await resolveLobbyRankRoleIds(kv, lobby)

  return {
    embeds: [lobbyOpenEmbed(lobby.mode, entries, maxPlayerCount(lobby.mode), minRoleId, maxRoleId)],
    components: lobbyComponents(lobby.mode, lobby.id),
  }
}

async function resolveLobbyRankRoleIds(
  kv: KVNamespace,
  lobby: LobbyState,
): Promise<{ minRoleId: string | null, maxRoleId: string | null }> {
  if (!lobby.guildId || (!lobby.minRole && !lobby.maxRole)) {
    return { minRoleId: null, maxRoleId: null }
  }

  const config = await getRankedRoleConfig(kv, lobby.guildId)
  return {
    minRoleId: lobby.minRole ? getConfiguredRankedRoleId(config, lobby.minRole) : null,
    maxRoleId: lobby.maxRole ? getConfiguredRankedRoleId(config, lobby.maxRole) : null,
  }
}

import type { LobbyState } from './lobby.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from './discord.ts'
import { setLobbyMessage } from './lobby.ts'

interface LobbyRenderPayload {
  embeds: unknown[]
  components?: unknown
}

/**
 * Update the tracked lobby message. If it was deleted, recreate it and rebind KV message ID.
 */
export async function upsertLobbyMessage(
  kv: KVNamespace,
  token: string,
  lobby: LobbyState,
  payload: LobbyRenderPayload,
): Promise<LobbyState> {
  try {
    await editChannelMessage(token, lobby.channelId, lobby.messageId, {
      content: null,
      embeds: payload.embeds,
      components: payload.components,
    })
    return lobby
  }
  catch (error) {
    if (!isDiscordApiError(error, 404)) throw error

    const created = await createChannelMessage(token, lobby.channelId, {
      embeds: payload.embeds,
      components: payload.components,
    })

    const updated = await setLobbyMessage(kv, lobby.mode, lobby.channelId, created.id)
    return updated ?? {
      ...lobby,
      messageId: created.id,
      updatedAt: Date.now(),
    }
  }
}

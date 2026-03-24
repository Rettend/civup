import type { LobbyState } from './types.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import { setLobbyMessage } from './mutations.ts'

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
      allowed_mentions: { parse: [] },
    })
    return lobby
  }
  catch (error) {
    if (!isDiscordApiError(error, 404)) throw error

    const created = await createChannelMessage(token, lobby.channelId, {
      embeds: payload.embeds,
      components: payload.components,
      allowed_mentions: { parse: [] },
    })

    const updated = await setLobbyMessage(kv, lobby.id, lobby.channelId, created.id)
    return updated ?? {
      ...lobby,
      messageId: created.id,
      updatedAt: Date.now(),
    }
  }
}

/** Create a fresh message for the lobby and rebind the stored message ID. */
export async function repostLobbyMessage(
  kv: KVNamespace,
  token: string,
  lobby: LobbyState,
  payload: LobbyRenderPayload,
): Promise<{ lobby: LobbyState, previousMessageId: string }> {
  const previousMessageId = lobby.messageId
  const created = await createChannelMessage(token, lobby.channelId, {
    content: null,
    embeds: payload.embeds,
    components: payload.components,
    allowed_mentions: { parse: [] },
  })

  const updated = await setLobbyMessage(kv, lobby.id, lobby.channelId, created.id)
  return {
    previousMessageId,
    lobby: updated ?? {
      ...lobby,
      messageId: created.id,
      updatedAt: Date.now(),
    },
  }
}

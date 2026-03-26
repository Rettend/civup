import type { LobbyState } from './types.ts'
import { createChannelMessage, editChannelMessage, isDiscordApiError } from '../discord/index.ts'
import { setLobbyMessage } from './mutations.ts'
import { getLobbyById } from './store.ts'

interface LobbyRenderPayload {
  embeds: unknown[]
  components?: unknown
}

export function canApplyQueuedLobbyMessageUpdate(
  expectedLobby: Pick<LobbyState, 'id' | 'revision' | 'status' | 'messageId'>,
  currentLobby: Pick<LobbyState, 'id' | 'revision' | 'status' | 'messageId'> | null,
): currentLobby is Pick<LobbyState, 'id' | 'revision' | 'status' | 'messageId'> {
  if (!currentLobby) return false
  return currentLobby.id === expectedLobby.id
    && currentLobby.revision === expectedLobby.revision
    && currentLobby.status === expectedLobby.status
    && currentLobby.messageId === expectedLobby.messageId
}

export async function getCurrentLobbyForQueuedMessageUpdate(
  kv: KVNamespace,
  expectedLobby: Pick<LobbyState, 'id' | 'revision' | 'status' | 'messageId'>,
): Promise<LobbyState | null> {
  const currentLobby = await getLobbyById(kv, expectedLobby.id)
  return canApplyQueuedLobbyMessageUpdate(expectedLobby, currentLobby) ? currentLobby : null
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

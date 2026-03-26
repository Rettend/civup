import { afterEach, describe, expect, test } from 'bun:test'
import { canApplyQueuedLobbyMessageUpdate, createLobby, getLobbyById, repostLobbyMessage, setLobbyStatus } from '../../src/services/lobby/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('lobby message rebinding', () => {
  test('reposts the lobby message and stores the new message ID', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      expect(url).toContain('/channels/channel-1/messages')
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ id: 'message-2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const reposted = await repostLobbyMessage(kv, 'token', lobby, {
      embeds: [{ title: 'Lobby' }],
      components: [],
    })

    expect(reposted.previousMessageId).toBe('message-1')
    expect(reposted.lobby.messageId).toBe('message-2')
    await expect(getLobbyById(kv, lobby.id)).resolves.toMatchObject({ messageId: 'message-2' })
  })

  test('skips stale queued lobby message updates after status changes', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const draftingLobby = await setLobbyStatus(kv, lobby.id, 'drafting', lobby)
    expect(draftingLobby).not.toBeNull()
    const scrubbedLobby = await setLobbyStatus(kv, lobby.id, 'scrubbed', draftingLobby!)
    expect(scrubbedLobby).not.toBeNull()

    expect(canApplyQueuedLobbyMessageUpdate(draftingLobby!, scrubbedLobby)).toBe(false)
  })

  test('allows queued lobby message updates when revision and status still match', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const currentLobby = await getLobbyById(kv, lobby.id)
    expect(canApplyQueuedLobbyMessageUpdate(lobby, currentLobby)).toBe(true)
  })
})

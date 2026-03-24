import { describe, expect, test } from 'bun:test'
import { clearLobbyById, createLobby, getLobbyBumpCooldownRemainingMs, markLobbyBumped } from '../../src/services/lobby/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('lobby bump cooldown', () => {
  test('tracks the remaining cooldown per lobby', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await expect(getLobbyBumpCooldownRemainingMs(kv, lobby.id, { now: 10_000 })).resolves.toBe(0)

    await markLobbyBumped(kv, lobby.id, { now: 10_000 })

    await expect(getLobbyBumpCooldownRemainingMs(kv, lobby.id, { now: 10_001 })).resolves.toBe(59_999)
    await expect(getLobbyBumpCooldownRemainingMs(kv, lobby.id, { now: 70_000 })).resolves.toBe(0)
  })

  test('clears stored cooldown state when the lobby is cleared', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await markLobbyBumped(kv, lobby.id, { now: 10_000 })
    await clearLobbyById(kv, lobby.id, lobby)

    await expect(getLobbyBumpCooldownRemainingMs(kv, lobby.id, { now: 10_001 })).resolves.toBe(0)
  })
})

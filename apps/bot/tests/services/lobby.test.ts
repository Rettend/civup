import { describe, expect, test } from 'bun:test'
import { createLobby, getLobbyByChannel, setLobbySlots, setLobbyStatus } from '../../src/services/lobby.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('lobby service KV write behavior', () => {
  test('setLobbySlots skips KV writes when slots are unchanged', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    resetOperations()
    const result = await setLobbySlots(kv, 'ffa', [...lobby.slots])

    expect(result).not.toBeNull()
    expect(result?.updatedAt).toBe(lobby.updatedAt)
    expect(operations).toHaveLength(0)
  })

  test('setLobbySlots writes when slots change', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const nextSlots = [...lobby.slots]
    nextSlots[1] = 'player-2'

    resetOperations()
    const result = await setLobbySlots(kv, 'ffa', nextSlots)

    expect(result).not.toBeNull()
    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    expect(putKeys).toContain('lobby:mode:ffa')
  })

  test('setLobbySlots bumps revision when slots change', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const nextSlots = [...lobby.slots]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, 'ffa', nextSlots)

    expect(updated).not.toBeNull()
    expect(updated?.revision).toBe(lobby.revision + 1)
  })

  test('setLobbyStatus blocks invalid transition chain', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()
    await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    resetOperations()
    const updated = await setLobbyStatus(kv, 'ffa', 'completed')

    expect(updated).toBeNull()
    expect(operations).toHaveLength(0)
  })

  test('getLobbyByChannel resolves mapped lobby', async () => {
    const { kv } = createTrackedKv()
    const created = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const byChannel = await getLobbyByChannel(kv, 'channel-1')
    expect(byChannel).not.toBeNull()
    expect(byChannel?.mode).toBe(created.mode)
    expect(byChannel?.hostId).toBe(created.hostId)
  })
})

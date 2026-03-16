import { describe, expect, test } from 'bun:test'
import { createLobby, getLobbyByChannel, getLobbyById, setLobbyMaxRole, setLobbyMemberPlayerIds, setLobbyMinRole, setLobbySlots, setLobbyStatus } from '../../src/services/lobby/index.ts'
import { lobbySnapshotKey } from '../../src/services/lobby/live-snapshot.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
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
    const result = await setLobbySlots(kv, lobby.id, [...lobby.slots])

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
    const result = await setLobbySlots(kv, lobby.id, nextSlots)

    expect(result).not.toBeNull()
    const putKeys = operations.filter(op => op.type === 'put').map(op => op.key)
    expect(putKeys).toContain(`lobby:mode:ffa:${lobby.id}`)
  })

  test('setLobbySlots rewrites the mode index value when revision changes', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    expect(await kv.get(`lobby:mode:ffa:${lobby.id}`)).toBe(String(lobby.revision))

    const nextSlots = [...lobby.slots]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots)

    expect(updated).not.toBeNull()
    expect(await kv.get(`lobby:mode:ffa:${lobby.id}`)).toBe(String(updated?.revision))
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
    const updated = await setLobbySlots(kv, lobby.id, nextSlots)

    expect(updated).not.toBeNull()
    expect(updated?.revision).toBe(lobby.revision + 1)
  })

  test('setLobbyStatus blocks invalid transition chain', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    resetOperations()
    const updated = await setLobbyStatus(kv, lobby.id, 'completed')

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

  test('setLobbyMinRole persists the configured gate', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setLobbyMinRole(kv, lobby.id, 'tier3')
    const stored = await getLobbyById(kv, lobby.id)

    expect(stored?.minRole).toBe('tier3')
    expect(stored?.guildId).toBe('guild-1')
  })

  test('setLobbyMaxRole persists the configured cap', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: 'ffa',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setLobbyMaxRole(kv, lobby.id, 'tier2')
    const stored = await getLobbyById(kv, lobby.id)

    expect(stored?.maxRole).toBe('tier2')
    expect(stored?.guildId).toBe('guild-1')
  })

  test('publishes live snapshots for open lobby changes', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, 'ffa', {
      playerId: 'player-2',
      displayName: 'Player 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host-1', 'player-2'], lobby)
    const nextSlots = [...(withMembers?.slots ?? lobby.slots)]
    nextSlots[1] = 'player-2'
    const updated = await setLobbySlots(kv, lobby.id, nextSlots, withMembers ?? lobby)

    expect(updated).not.toBeNull()
    const snapshot = await kv.get(lobbySnapshotKey(lobby.id), 'json') as {
      revision?: unknown
      entries?: Array<{ playerId?: unknown, displayName?: unknown } | null>
    } | null

    expect(snapshot?.revision).toBe(updated?.revision)
    expect(snapshot?.entries?.[0]).toEqual({ playerId: 'host-1', displayName: 'Host', avatarUrl: null, partyIds: [] })
    expect(snapshot?.entries?.[1]).toEqual({ playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, partyIds: [] })
  })

  test('removes live snapshots when a lobby stops being open', async () => {
    const { kv } = createTrackedKv()

    await addToQueue(kv, 'ffa', {
      playerId: 'host-1',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const lobby = await createLobby(kv, {
      mode: 'ffa',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    expect(await kv.get(lobbySnapshotKey(lobby.id), 'json')).not.toBeNull()

    await setLobbyStatus(kv, lobby.id, 'drafting')

    expect(await kv.get(lobbySnapshotKey(lobby.id), 'json')).toBeNull()
  })
})

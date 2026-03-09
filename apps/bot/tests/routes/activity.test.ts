import { afterEach, describe, expect, test } from 'bun:test'
import { resolveLobbyJoinEligibility } from '../../src/routes/activity.ts'
import { buildOpenLobbySnapshot } from '../../src/routes/lobby/snapshot.ts'
import { createLobby, getLobbyById, setLobbyMinRole } from '../../src/services/lobby/index.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('activity lobby join eligibility', () => {
  test('returns the first empty slot when the viewer can join', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    const snapshot = await buildOpenLobbySnapshot(kv, '2v2', lobby)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-2', lobby, snapshot)

    expect(eligibility).toEqual({
      canJoin: true,
      blockedReason: null,
      pendingSlot: 1,
    })
  })

  test('blocks pending ghost joins when the viewer misses the minimum rank', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })

    await setLobbyMinRole(kv, lobby.id, 'tier2')
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: '11111111111111111',
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const storedLobby = await getLobbyById(kv, lobby.id)
    expect(storedLobby).not.toBeNull()

    const gatedLobby = await buildOpenLobbySnapshot(kv, '2v2', storedLobby!)
    const eligibility = await resolveLobbyJoinEligibility('token', kv, 'player-2', storedLobby!, gatedLobby)

    expect(eligibility.canJoin).toBe(false)
    expect(eligibility.pendingSlot).toBeNull()
    expect(eligibility.blockedReason).toContain('requires at least')
  })
})

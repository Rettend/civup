import { afterEach, describe, expect, test } from 'bun:test'
import { joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import { createLobby, setLobbyMaxRole, setLobbyMinRole } from '../../src/services/lobby/index.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch
const TITAN_ROLE_ID = '99999999999999999'
const GLADIATOR_ROLE_ID = '11111111111111111'

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('joinLobbyAndMaybeStartMatch', () => {
  test('keeps matchmaking min rank as a /match join gate', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await setLobbyMinRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'pleb',
      displayName: 'Pleb',
      avatarUrl: '',
    }])

    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('requires at least')
  })

  test('allows direct lobby joins to bypass matchmaking min rank', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await setLobbyMinRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
        playerId: 'pleb',
        displayName: 'Pleb',
        avatarUrl: '',
      }], {
        preferredLobbyId: lobby.id,
        skipMatchmakingRankGate: true,
      })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.stage).toBe('open')
    expect(result.lobby.memberPlayerIds).toContain('pleb')
  })

  test('keeps matchmaking max rank as a /match join gate', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await setLobbyMaxRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier1: TITAN_ROLE_ID,
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [TITAN_ROLE_ID] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'titan',
      displayName: 'Titan',
      avatarUrl: '',
    }])

    expect('error' in result).toBe(true)
    if (!('error' in result)) return
    expect(result.error).toContain('allows up to')
  })

  test('allows direct lobby joins to bypass matchmaking max rank', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '2v2',
      guildId: 'guild-1',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host',
      displayName: 'Host',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await setLobbyMaxRole(kv, lobby.id, 'tier2', lobby)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier1: TITAN_ROLE_ID,
      tier2: GLADIATOR_ROLE_ID,
    })

    globalThis.fetch = (async () => new Response(JSON.stringify({ roles: [TITAN_ROLE_ID] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const result = await joinLobbyAndMaybeStartMatch({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
    }, '2v2', [{
      playerId: 'titan',
      displayName: 'Titan',
      avatarUrl: '',
    }], {
      preferredLobbyId: lobby.id,
      skipMatchmakingRankGate: true,
    })

    expect('stage' in result).toBe(true)
    if (!('stage' in result)) return
    expect(result.stage).toBe('open')
    expect(result.lobby.memberPlayerIds).toContain('titan')
  })
})

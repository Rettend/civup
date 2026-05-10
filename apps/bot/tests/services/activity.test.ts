import type { QueueEntry } from '@civup/game'
import { allLeaderIds } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import {
  buildDraftRuntimeConfig,
  getChannelForMatch,
  getLobbyForUser,
  getMatchForUser,
} from '../../src/services/activity/index.ts'
import { createLobby, getExistingTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const baseFfaEntries: QueueEntry[] = Array.from({ length: 4 }, (_, index) => ({
  playerId: `p${index + 1}`,
  displayName: `P${index + 1}`,
  joinedAt: index,
}))

describe('activity canonical lookup behavior', () => {
  test('getMatchForUser resolves from canonical live lobby membership', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await startTestSessionDraft(kv, lobby.id, lobby)

    const runtime = getExistingTestLobbyRuntime(kv)
    await expect(getMatchForUser(runtime.db, 'user-1')).resolves.toBe(lobby.id)
  })

  test('getChannelForMatch resolves from canonical same-id lobby', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await startTestSessionDraft(kv, lobby.id, lobby)

    const runtime = getExistingTestLobbyRuntime(kv)
    await expect(getChannelForMatch(runtime.db, lobby.id)).resolves.toBe('channel-1')
  })

  test('getLobbyForUser resolves from canonical open lobby membership', async () => {
    const { kv } = createTrackedKv()

    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })

    await setLobbyMemberPlayerIds(kv, currentLobby.id, ['host-1', 'player-1'], currentLobby)

    const runtime = getExistingTestLobbyRuntime(kv)
    await expect(getLobbyForUser(runtime.db, 'player-1')).resolves.toBe(currentLobby.id)
  })
})

describe('draft runtime config', () => {
  test('uses seat-order FFA by default', async () => {
    const result = buildDraftRuntimeConfig('ffa', baseFfaEntries, { matchId: 'session-ffa-default', hostId: 'p1' })

    expect(result.config.formatId).toBe('default-ffa')
    expect(result.formatId).toBe('default-ffa')
    expect(result.seats.map(seat => seat.team)).toEqual([0, 0, 1, 1])
  })

  test('leaves FFA seats unpaired when Permanent Ally is disabled', async () => {
    const result = buildDraftRuntimeConfig('ffa', baseFfaEntries, {
      matchId: 'session-ffa-no-pa',
      hostId: 'p1',
      permanentAlly: false,
    })

    expect(result.config.formatId).toBe('default-ffa')
    expect(result.seats.every(seat => seat.team == null)).toBe(true)
  })

  test('uses simultaneous FFA when requested', async () => {
    const result = buildDraftRuntimeConfig('ffa', baseFfaEntries, {
      matchId: 'session-ffa-simultaneous',
      hostId: 'p1',
      simultaneousPick: true,
    })

    expect(result.config.formatId).toBe('default-ffa-simultaneous')
    expect(result.formatId).toBe('default-ffa-simultaneous')
  })

  test('forwards random draft outside Red Death rooms', async () => {
    const result = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-random',
      hostId: 'p1',
      randomDraft: true,
    })

    expect(result.config.formatId).toBe('default-1v1')
    expect(result.config.randomDraft).toBe(true)
    expect(result.formatId).toBe('default-1v1')
  })

  test('forwards duplicate leaders for base-game random drafts', async () => {
    const result = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-random-duplicate',
      hostId: 'p1',
      randomDraft: true,
      duplicateFactions: true,
    })

    expect(result.config.formatId).toBe('default-1v1')
    expect(result.config.randomDraft).toBe(true)
    expect(result.config.duplicateFactions).toBe(true)
    expect(result.formatId).toBe('default-1v1')
  })

  test('forwards duplicate leaders for standard draft rooms too', async () => {
    const result = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-standard-duplicate',
      hostId: 'p1',
      duplicateFactions: true,
    })

    expect(result.config.formatId).toBe('default-1v1')
    expect(result.config.duplicateFactions).toBe(true)
    expect(result.formatId).toBe('default-1v1')
  })

  test('hidden drafts use the full leader pool and suppress random draft', async () => {
    const result = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-hidden',
      hostId: 'p1',
      hiddenDraft: true,
      randomDraft: true,
    })

    expect(result.config.hiddenDraft).toBe(true)
    expect(result.config.randomDraft).toBe(false)
    expect(result.config.civPool).toEqual(allLeaderIds)
  })

  test('uses draft-format pick order for team draft seats', async () => {
    const result = buildDraftRuntimeConfig('2v2', baseFfaEntries, {
      matchId: 'session-team-order',
      hostId: 'p1',
    })

    expect(result.seats.map(seat => seat.playerId)).toEqual(['p1', 'p3', 'p2', 'p4'])
    expect(result.seats.map(seat => seat.team)).toEqual([0, 1, 0, 1])
    expect(result.config.randomDraft).toBe(false)
  })

  test('forces duplicate factions for Red Death 6v6 rooms', async () => {
    const entries: QueueEntry[] = Array.from({ length: 12 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `P${index + 1}`,
      joinedAt: index,
    }))

    const result = buildDraftRuntimeConfig('6v6', entries, {
      matchId: 'session-red-death',
      hostId: 'p1',
      redDeath: true,
      duplicateFactions: false,
    })

    expect(result.config.formatId).toBe('red-death-6v6')
    expect(result.config.duplicateFactions).toBe(true)
    expect(result.formatId).toBe('red-death-6v6')
  })

  test('uses a visible-ban format for supported modes when blind bans are disabled', async () => {
    const entries = baseFfaEntries.map((entry, index) => ({
      ...entry,
      playerId: `team-player-${index + 1}`,
      displayName: `Team Player ${index + 1}`,
    }))

    const result = buildDraftRuntimeConfig('1v1', entries.slice(0, 2), {
      matchId: 'session-visible-ban',
      hostId: 'team-player-1',
      blindBans: false,
    })

    expect(result.config.formatId).toBe('default-1v1-visible-bans')
    expect(result.formatId).toBe('default-1v1-visible-bans')
  })

  test('falls back to the default format when visible bans are unsupported for the seat count', async () => {
    const entries: QueueEntry[] = Array.from({ length: 8 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `P${index + 1}`,
      joinedAt: index,
    }))

    const result = buildDraftRuntimeConfig('2v2', entries, {
      matchId: 'session-visible-fallback',
      hostId: 'p1',
      blindBans: false,
    })

    expect(result.config.formatId).toBe('default-2v2')
    expect(result.formatId).toBe('default-2v2')
  })
})

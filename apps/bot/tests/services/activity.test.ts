import type { AppliedCivLobbySettings, QueueEntry } from '@civup/game'
import { allFactionIds, allLeaderIds, cloneOfficialAppliedSettings, getDefaultLeaderPoolSize, getLeaderIds } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildActivityOverviewOptionsFromSessionRecord, buildLobbySnapshotFromSessionRecord } from '../../src/services/activity/session-state.ts'
import type { LobbyState } from '../../src/services/lobby/types.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import {
  buildDraftRuntimeConfig,
  getChannelForMatch,
  getLobbyForUser,
  getMatchForUser,
} from '../../src/services/activity/index.ts'
import { buildOpenSessionRecordFromLobby } from '../../src/session-runtime/session-record.ts'
import { createLobby, getExistingTestLobbyRuntime, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const baseFfaEntries: QueueEntry[] = Array.from({ length: 4 }, (_, index) => ({
  playerId: `p${index + 1}`,
  displayName: `P${index + 1}`,
  joinedAt: index,
}))

function gameSettingsWithExclusions(leaderIds: string[]): AppliedCivLobbySettings {
  const settings = cloneOfficialAppliedSettings()
  settings.profile.base.autoBannedLeaderIds = [...leaderIds]
  settings.preset = { kind: 'custom', id: null, name: 'Automatic exclusions', revision: null }
  return settings
}

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
    expect(result.seats.every(seat => seat.team == null)).toBe(true)
    expect(result.config.permanentAlly).toBe(true)
  })

  test('leaves FFA seats unteamed when Permanent Ally is disabled', async () => {
    const result = buildDraftRuntimeConfig('ffa', baseFfaEntries, {
      matchId: 'session-ffa-no-pa',
      hostId: 'p1',
      permanentAlly: false,
    })

    expect(result.config.formatId).toBe('default-ffa')
    expect(result.seats.every(seat => seat.team == null)).toBe(true)
    expect(result.config.permanentAlly).toBe(false)
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

  test('applies automatic leader exclusions to standard, random, and hidden drafts', () => {
    const excludedLeaderIds = getLeaderIds('live').slice(0, 2)
    const gameSettings = gameSettingsWithExclusions(excludedLeaderIds)
    const common = { hostId: 'p1', gameSettings }
    const standard = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), { ...common, matchId: 'session-excluded-standard' })
    const random = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), { ...common, matchId: 'session-excluded-random', randomDraft: true })
    const hidden = buildDraftRuntimeConfig('1v1', baseFfaEntries.slice(0, 2), { ...common, matchId: 'session-excluded-hidden', hiddenDraft: true })

    for (const result of [standard, random, hidden]) {
      expect(result.config.civPool.some(id => excludedLeaderIds.includes(id))).toBe(false)
      expect(result.config.gameSettings).toEqual(gameSettings)
    }
    expect(hidden.config.civPool).toHaveLength(getLeaderIds('live').length - excludedLeaderIds.length)
  })

  test('shrinks a default pool to the eligible roster without hiding invalid explicit sizes', () => {
    const entries: QueueEntry[] = Array.from({ length: 10 }, (_, index) => ({
      playerId: `ffa-${index + 1}`,
      displayName: `FFA ${index + 1}`,
      joinedAt: index,
    }))
    const excludedLeaderIds = getLeaderIds('live').slice(0, 32)
    const eligibleCount = getLeaderIds('live').length - excludedLeaderIds.length
    const options = {
      matchId: 'session-excluded-default',
      hostId: 'ffa-1',
      gameSettings: gameSettingsWithExclusions(excludedLeaderIds),
    }

    const result = buildDraftRuntimeConfig('ffa', entries, options)
    expect(result.config.civPool).toHaveLength(Math.min(getDefaultLeaderPoolSize('ffa', entries.length), eligibleCount))
    expect(() => buildDraftRuntimeConfig('ffa', entries, { ...options, matchId: 'session-excluded-explicit', leaderPoolSize: eligibleCount + 1 })).toThrow('eligible leaders remain')
  })

  test('keeps automatic leader exclusions out of Red Death and CivBlitz pools', () => {
    const gameSettings = gameSettingsWithExclusions(getLeaderIds('live').slice(0, 2))
    const redDeath = buildDraftRuntimeConfig('2v2', baseFfaEntries, {
      matchId: 'session-excluded-red-death',
      hostId: 'p1',
      redDeath: true,
      gameSettings,
    })
    const civBlitz = buildDraftRuntimeConfig('2v2', baseFfaEntries, {
      matchId: 'session-excluded-civblitz',
      hostId: 'p1',
      civBlitz: true,
      gameSettings,
    })
    const civBlitzWithoutSettings = buildDraftRuntimeConfig('2v2', baseFfaEntries, {
      matchId: 'session-civblitz-control',
      hostId: 'p1',
      civBlitz: true,
    })

    expect(redDeath.config.civPool).toEqual(allFactionIds)
    expect(civBlitz.config.civPool).toEqual(civBlitzWithoutSettings.config.civPool)
  })

  test('uses draft-format pick order for team draft seats', async () => {
    const result = buildDraftRuntimeConfig('2v2', baseFfaEntries, {
      matchId: 'session-team-order',
      hostId: 'p1',
      bansPerTeam: 5,
    })

    expect(result.seats.map(seat => seat.playerId)).toEqual(['p1', 'p3', 'p2', 'p4'])
    expect(result.seats.map(seat => seat.team)).toEqual([0, 1, 0, 1])
    expect(result.config.bansPerTeam).toBe(5)
    expect(result.config.randomDraft).toBe(false)
  })

  test('uses rank-adjusted default leader pools', async () => {
    const rank1Teamers = buildDraftRuntimeConfig('2v2', baseFfaEntries, {
      matchId: 'session-rank1-teamers',
      hostId: 'p1',
      leaderPoolRankTier: 'tier1',
    })
    const ffaEntries = Array.from({ length: 8 }, (_, index) => ({
      playerId: `ffa-${index + 1}`,
      displayName: `FFA ${index + 1}`,
      joinedAt: index,
    }))
    const rank5Ffa = buildDraftRuntimeConfig('ffa', ffaEntries, {
      matchId: 'session-rank5-ffa',
      hostId: 'ffa-1',
      leaderPoolRankTier: 'tier5',
    })

    expect(rank1Teamers.config.civPool).toHaveLength(32)
    expect(rank5Ffa.config.civPool).toHaveLength(52)
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

describe('lobby activity snapshots', () => {
  test('serializes CivBlitz on activity overview options', () => {
    const lobby: LobbyState = {
      id: 'civblitz-lobby',
      mode: '2v2',
      status: 'open',
      guildId: 'guild-1',
      hostId: 'p1',
      channelId: 'channel-1',
      messageId: 'message-1',
      matchId: null,
      steamLobbyLink: null,
      minRole: null,
      maxRole: null,
      lastArrange: null,
      lastActivityAt: 1,
      memberPlayerIds: ['p1'],
      slots: ['p1', null, null, null],
      draftConfig: {
        banTimerSeconds: null,
        pickTimerSeconds: null,
        leaderPoolSize: null,
        leaderDataVersion: 'live',
        mapVoteEnabled: false,
        blindBans: true,
        blindPicks: false,
        simultaneousPick: false,
        permanentAlly: false,
        redDeath: false,
        dealOptionsSize: null,
        civBlitz: true,
        civBlitzOptionCount: 4,
        civBlitzExcludeBbgExpanded: true,
        randomDraft: false,
        hiddenDraft: false,
        duplicateFactions: false,
        closed: false,
      },
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    }

    const [option] = buildActivityOverviewOptionsFromSessionRecord(buildOpenSessionRecordFromLobby(lobby, [{ playerId: 'p1', displayName: 'P1', joinedAt: 1 }]))

    expect(option?.redDeath).toBe(false)
    expect(option?.civBlitz).toBe(true)
  })

  test('serializes average lobby rank and rank-adjusted default leader pool', async () => {
    const { kv } = createTrackedKv()
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier1: '11111111111111111',
      tier2: '12222222222222222',
      tier3: '13333333333333333',
      tier4: '14444444444444444',
      tier5: '15555555555555555',
    })
    const queueEntries = Array.from({ length: 4 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `P${index + 1}`,
      joinedAt: index,
    }))
    const lobby: LobbyState = {
      id: 'ranked-lobby',
      mode: '2v2',
      status: 'open',
      guildId: 'guild-1',
      hostId: 'p1',
      channelId: 'channel-1',
      messageId: 'message-1',
      matchId: null,
      steamLobbyLink: null,
      minRole: null,
      maxRole: null,
      lastArrange: null,
      lastActivityAt: 1,
      memberPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      slots: ['p1', 'p2', 'p3', 'p4'],
      draftConfig: {
        banTimerSeconds: null,
        pickTimerSeconds: null,
        leaderPoolSize: null,
        leaderDataVersion: 'live',
        mapVoteEnabled: false,
        blindBans: true,
        simultaneousPick: false,
        permanentAlly: true,
        redDeath: false,
        dealOptionsSize: null,
        randomDraft: false,
        hiddenDraft: false,
        duplicateFactions: false,
        closed: false,
      },
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    }

    const snapshot = await buildLobbySnapshotFromSessionRecord(
      kv,
      buildOpenSessionRecordFromLobby(lobby, queueEntries),
      null,
      {
        byPlayerId: {
          p1: { tier: 'tier1', sourceMode: null },
          p2: { tier: 'tier2', sourceMode: null },
          p3: { tier: 'tier3', sourceMode: null },
        },
      },
    )

    expect(snapshot.lobbyRank).toEqual({
      tier: 'tier3',
      leaderPoolSize: 36,
    })

  })

  test('uses rank5 leader pool defaults when rank assignments are missing', async () => {
    const { kv } = createTrackedKv()
    const queueEntries = Array.from({ length: 4 }, (_, index) => ({
      playerId: `u${index + 1}`,
      displayName: `U${index + 1}`,
      joinedAt: index,
    }))
    const lobby: LobbyState = {
      id: 'unranked-lobby',
      mode: '2v2',
      status: 'open',
      guildId: 'guild-1',
      hostId: 'u1',
      channelId: 'channel-1',
      messageId: 'message-1',
      matchId: null,
      steamLobbyLink: null,
      minRole: null,
      maxRole: null,
      lastArrange: null,
      lastActivityAt: 1,
      memberPlayerIds: ['u1', 'u2', 'u3', 'u4'],
      slots: ['u1', 'u2', 'u3', 'u4'],
      draftConfig: {
        banTimerSeconds: null,
        pickTimerSeconds: null,
        leaderPoolSize: null,
        leaderDataVersion: 'live',
        mapVoteEnabled: false,
        blindBans: true,
        simultaneousPick: false,
        permanentAlly: true,
        redDeath: false,
        dealOptionsSize: null,
        randomDraft: false,
        hiddenDraft: false,
        duplicateFactions: false,
        closed: false,
      },
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
    }

    const snapshot = await buildLobbySnapshotFromSessionRecord(
      kv,
      buildOpenSessionRecordFromLobby(lobby, queueEntries),
      null,
      { byPlayerId: {} },
    )

    expect(snapshot.lobbyRank).toEqual({
      tier: 'tier5',
      leaderPoolSize: 40,
    })
  })
})

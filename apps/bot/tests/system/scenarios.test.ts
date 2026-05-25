import type { GameMode, ResolvedMapVoteResult } from '@civup/game'
import type { TestSessionNamespace } from '../helpers/session-runtime.ts'
import { matches } from '@civup/db'
import { formatMapVoteResultLabel, swapSeatPicks } from '@civup/game'
import { verifySessionAccessToken } from '@civup/utils'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setSystemChannel } from '../../src/services/system/channels.ts'
import { createTournament, createTournamentMatchLink, importTournamentPlayersCsv } from '../../src/services/tournament/index.ts'
import { getSessionRecord, runSessionTerminalLifecycleCommand } from '../../src/session-runtime/session-do-client.ts'
import { createFakeSessionWebSocket } from '../helpers/session-runtime.ts'
import { countDiscordChannelRequests as countDiscordMessageUpdates, expectDraftAndLobbyState, expectQueuePlayers } from './helpers/assertions.ts'
import { createSystemWorld } from './helpers/world.ts'

const worlds: Array<Awaited<ReturnType<typeof createSystemWorld>>> = []

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

const NOISY_SYSTEM_SCENARIO_LOG_PREFIXES = [
  '[draft-lifecycle] received',
  '[draft-room] transition',
  '[idempotency] activity report request deduplicated',
  '[idempotency] duplicate lobby start request',
  '[session-do] ignoring stale draft completion',
  '[session-do] ignoring stale draft cancellation',
  '[session-do] reported Discord sync retry scheduled',
]

const CORE_MODE_CASES = [
  { mode: '1v1', playerCount: 2 },
  { mode: '2v2', playerCount: 4 },
  { mode: '3v3', playerCount: 6 },
  { mode: 'ffa', playerCount: 8 },
] as const satisfies readonly { mode: GameMode, playerCount: number }[]

const MAP_VOTE_RESULT: ResolvedMapVoteResult = {
  mapType: 'standard',
  mapScript: 'lakes',
  winningSeatCount: 2,
  seed: 'system-test-seed',
  mapTypeWinner: 'standard',
  mapScriptWinner: 'lakes',
  mapTypeRounds: [],
  mapScriptRounds: [],
  resolvedRandomMapType: null,
  resolvedRandomMapScript: null,
}

beforeAll(() => {
  console.log = (...args: unknown[]) => {
    if (!isNoisySystemScenarioLog(args)) originalConsole.log(...args)
  }
  console.warn = (...args: unknown[]) => {
    if (!isNoisySystemScenarioLog(args)) originalConsole.warn(...args)
  }
  console.error = (...args: unknown[]) => {
    if (!isNoisySystemScenarioLog(args)) originalConsole.error(...args)
  }
})

afterAll(() => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
})

afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

function isNoisySystemScenarioLog(args: unknown[]): boolean {
  const message = typeof args[0] === 'string' ? args[0] : ''
  if (NOISY_SYSTEM_SCENARIO_LOG_PREFIXES.some(prefix => message.startsWith(prefix))) return true
  return message.startsWith('Failed to post archive result for match') && args.some(isInjectedMessageCreateFailure)
}

function isInjectedMessageCreateFailure(value: unknown): boolean {
  if (value instanceof Error && value.message.includes('Injected message create failure')) return true
  if (!value || typeof value !== 'object') return false
  const detail = (value as { detail?: unknown }).detail
  return typeof detail === 'string' && detail.includes('Injected message create failure')
}

describe('system scenarios', () => {
  for (const { mode, playerCount } of CORE_MODE_CASES) {
    test(`core ${mode} lifecycle completes, reports, and archives cleanly`, async () => {
      const world = await createTrackedWorld()
      const result = await runReportedLifecycle(world, {
        mode,
        players: createPlayers(playerCount),
      })

      if (mode === 'ffa') {
        expect(result.activeParticipants.every(participant => participant.team == null)).toBe(true)
        expect(result.reportedParticipants.every(participant => participant.team == null)).toBe(true)
        expectAdjacentPairPlacements(result.reportedParticipants, result.activeParticipants.map(participant => participant.playerId))
      }
      else {
        expectTeamPlacements(result.reportedParticipants, new Map([[0, 1], [1, 2]]))
      }

      if (mode === '1v1') {
        expect(parseDraftData(result.reportedMatch)?.reportedById).toBe('p1')
      }
    })
  }

  test('variant matrix covers simultaneous FFA, red death deal options, random draft, duplicate factions, and map vote propagation', async () => {
    const simultaneousWorld = await createTrackedWorld()
    const simultaneous = await runReportedLifecycle(simultaneousWorld, {
      mode: 'ffa',
      players: createPlayers(8, 'sim'),
      config: { simultaneousPick: true },
      placements: participants => buildOrderedMentions([...participants].reverse()),
    })
    expect(findDraftRuntimeConfig(simultaneousWorld, simultaneous.matchId)?.formatId).toBe('default-ffa-simultaneous')
    expect(parseDraftData(simultaneous.reportedMatch)?.state).toMatchObject({ formatId: 'default-ffa-simultaneous' })
    expect(simultaneous.reportedParticipants.every(participant => participant.team == null)).toBe(true)
    expectAdjacentPairPlacements(simultaneous.reportedParticipants, [...simultaneous.activeParticipants].reverse().map(participant => participant.playerId))

    const redDeathWorld = await createTrackedWorld()
    const redDeath = await runReportedLifecycle(redDeathWorld, {
      mode: '3v3',
      players: createPlayers(6, 'rd'),
      config: { redDeath: true, dealOptionsSize: 3 },
    })
    const redDeathConfig = findDraftRuntimeConfig(redDeathWorld, redDeath.matchId)
    expect(redDeathConfig?.dealOptionsSize).toBe(3)
    expect(parseDraftData(redDeath.reportedMatch)?.redDeath).toBe(true)
    expect(redDeath.reportedParticipants.every(participant => participant.civId != null)).toBe(true)

    const randomWorld = await createTrackedWorld()
    const randomDraft = await runReportedLifecycle(randomWorld, {
      mode: '1v1',
      players: createPlayers(2, 'rnd'),
      config: { randomDraft: true },
    })
    const randomConfig = findDraftRuntimeConfig(randomWorld, randomDraft.matchId)
    expect(randomConfig?.randomDraft).toBe(true)
    expect(randomDraft.reportedParticipants.every(participant => participant.civId != null)).toBe(true)

    const duplicateWorld = await createTrackedWorld()
    const duplicate = await runReportedLifecycle(duplicateWorld, {
      mode: '1v1',
      players: createPlayers(2, 'dup'),
      config: { duplicateFactions: true },
    })
    const duplicateCivs = [...new Set(duplicate.reportedParticipants.map(participant => participant.civId))]
    expect(findDraftRuntimeConfig(duplicateWorld, duplicate.matchId)?.duplicateFactions).toBe(true)
    expect(duplicate.reportedParticipants.every(participant => participant.civId != null)).toBe(true)
    expect(duplicateCivs).toHaveLength(1)

    const mapVoteWorld = await createTrackedWorld()
    const mapVote = await runReportedLifecycle(mapVoteWorld, {
      mode: '2v2',
      players: createPlayers(4, 'map'),
      config: { mapVoteEnabled: true },
      completeDraftOptions: { mapVoteResult: MAP_VOTE_RESULT },
    })
    const mapVotePayloads = (await Promise.all(
      (await mapVoteWorld.match.getMessageIds(mapVote.matchId)).map(async messageId => mapVoteWorld.discord.message(messageId)?.payload ?? null),
    )).filter((payload): payload is Record<string, unknown> => payload != null && typeof payload === 'object')

    expect(findDraftRuntimeConfig(mapVoteWorld, mapVote.matchId)?.mapVoteEnabled).toBe(true)
    expect(parseDraftData(mapVote.reportedMatch)?.mapVoteResult).toEqual(MAP_VOTE_RESULT)
    expect(mapVotePayloads.some(payload => payloadHasEmbedField(payload, 'Map', formatMapVoteResultLabel(MAP_VOTE_RESULT.mapType, MAP_VOTE_RESULT.mapScript)))).toBe(true)
  })

  test('starting a valid 1v1 lobby creates exactly one draft runtime and one drafting match', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: createPlayers(2),
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const persistedMatches = await world.db.select().from(matches)

    expect(started.ok).toBe(true)
    expect(started.matchId).toBe(lobby.id)
    expect(world.party.rooms()).toHaveLength(1)
    expect(world.party.rooms()[0]?.config.matchId).toBe(started.matchId)
    expect(persistedMatches).toHaveLength(1)
    expect(persistedMatches[0]).toMatchObject({ id: started.matchId, status: 'drafting', gameMode: '1v1' })
    expect((await world.lobby.getById(lobby.id))?.matchId).toBe(started.matchId)
  })

  test('hibernated selected draft sockets resume from attachments after DO wakeup', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: createPlayers(2),
    })
    const configured = await world.lobby.config('1v1', {
      hostId: 'p1',
      lobbyId: lobby.id,
      redDeath: true,
      dealOptionsSize: 2,
    })
    expect(configured.status).toBe(200)

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const namespace = getTestSessionNamespace(world)
    const hostSocket = createFakeSessionWebSocket(draftSocketAttachment('conn-p1', started.matchId, 'p1'))
    const opponentSocket = createFakeSessionWebSocket(draftSocketAttachment('conn-p2', started.matchId, 'p2'))

    namespace.__replaceWebSockets(started.matchId, [hostSocket.connection, opponentSocket.connection])
    const wokenRoom = namespace.__evictRoom(started.matchId)
    await wokenRoom.webSocketMessage(hostSocket.connection, JSON.stringify({ type: 'start' }))

    const hostUpdate = lastMessageOfType(hostSocket.messages, 'update')
    const opponentUpdate = lastMessageOfType(opponentSocket.messages, 'update')
    const match = await world.match.get(started.matchId)

    expect(match?.status).toBe('drafting')
    expect(hostUpdate).toMatchObject({ type: 'update', state: { status: 'active' } })
    expect(opponentUpdate).toMatchObject({ type: 'update', state: { status: 'active' } })
    expect(hostUpdate?.state.dealtCivIds).toHaveLength(2)
    expect(opponentUpdate?.state.dealtCivIds).toBeNull()
    expect(opponentUpdate?.state.availableCivIds).toEqual([])
    expect(hostSocket.closed).toBeNull()
    expect(opponentSocket.closed).toBeNull()
  })

  test('starting a valid 2v2 lobby keeps the expected seat and team order', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players: createPlayers(4),
    })

    const started = await world.lobby.start('2v2', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(findDraftRuntimeConfig(world, started.matchId)?.seats).toEqual([
      expect.objectContaining({ playerId: 'p1', team: 0 }),
      expect.objectContaining({ playerId: 'p3', team: 1 }),
      expect.objectContaining({ playerId: 'p2', team: 0 }),
      expect.objectContaining({ playerId: 'p4', team: 1 }),
    ])
  })

  test('starting FFA in seat-order mode chooses the default FFA format', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: 'ffa',
      players: createPlayers(8),
    })

    const started = await world.lobby.start('ffa', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(findDraftRuntimeConfig(world, started.matchId)?.formatId).toBe('default-ffa')
  })

  test('duplicate host start requests are idempotent', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: createPlayers(2),
    })

    const first = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    const duplicate = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const persistedMatches = await world.db.select().from(matches)

    expect(duplicate).toMatchObject({ ok: true, matchId: first.matchId, idempotent: true })
    expect(world.party.rooms()).toHaveLength(1)
    expect(persistedMatches).toHaveLength(1)
    expect(persistedMatches[0]?.id).toBe(first.matchId)
  })

  test('concurrent lobby starts settle to one live match for the lobby', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: createPlayers(2),
    })

    const [first, second] = await Promise.all([
      world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id }),
      world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id }),
    ])
    await world.flushBackgroundTasks()

    const finalLobby = await world.lobby.getById(lobby.id)
    const liveMatches = (await world.db.select().from(matches)).filter(match => match.status === 'drafting' || match.status === 'active')

    expect(new Set([first.matchId, second.matchId])).toEqual(new Set([finalLobby?.matchId]))
    expect(world.party.rooms()).toHaveLength(1)
    expect(liveMatches).toHaveLength(1)
    expect(liveMatches[0]?.id).toBe(finalLobby?.matchId)
  })

  test('FFA ordered participant reporting respects the submitted real placement order', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: 'ffa',
      players: createPlayers(8, 'ffa-order'),
    })
    const configured = await world.lobby.config('ffa', {
      hostId: 'ffa-order1',
      lobbyId: lobby.id,
      permanentAlly: false,
    })
    expect(configured.status).toBe(200)
    await world.flushBackgroundTasks()
    expect((await world.lobby.getById(lobby.id))?.draftConfig.permanentAlly).toBe(false)
    expect((await getSessionRecord(world.env.SessionDO, lobby.id))?.config.permanentAlly).toBe(false)

    const started = await world.lobby.start('ffa', { hostId: 'ffa-order1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await getSessionRecord(world.env.SessionDO, lobby.id))?.config.permanentAlly).toBe(false)
    expect(findDraftRuntimeConfig(world, started.matchId)?.seats.some(seat => seat.team != null)).toBe(false)
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    expect(parseDraftData(await world.match.get(started.matchId))?.permanentAlly).toBe(false)
    const participants = await world.match.getParticipants(started.matchId)
    expect(participants.every(participant => participant.team == null)).toBe(true)
    const orderedIds = [
      participants[3]!.playerId,
      participants[0]!.playerId,
      participants[6]!.playerId,
      participants[1]!.playerId,
      participants[7]!.playerId,
      participants[2]!.playerId,
      participants[5]!.playerId,
      participants[4]!.playerId,
    ]

    expect((await world.match.report(started.matchId, {
      reporterId: 'ffa-order1',
      placements: buildOrderedMentions(orderedIds.map(playerId => ({ playerId }))),
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    const reportedMatch = await world.match.get(started.matchId)
    const reportedParticipants = await world.match.getParticipants(started.matchId)
    expect(reportedMatch?.status).toBe('completed')
    expectOrderedPlacements(reportedParticipants, orderedIds)
  })

  test('expanded 2v2 reporting accepts ordered team results from real participant mentions', async () => {
    const world = await createTrackedWorld()
    const result = await runReportedLifecycle(world, {
      mode: '2v2',
      players: createPlayers(8, 'team'),
      config: { targetSize: 8 },
      placements: (participants) => {
        const teams = groupParticipantsByTeam(participants)
        const thirdTeamPlayer = teams.get(2)?.[0]?.playerId
        const firstTeamPlayer = teams.get(0)?.[0]?.playerId
        if (!thirdTeamPlayer || !firstTeamPlayer) throw new Error('Expected 4 teams in expanded 2v2 scenario')
        return `<@${thirdTeamPlayer}>, <@${firstTeamPlayer}>`
      },
    })

    const placementsByTeam = placementsByTeamIndex(result.reportedParticipants)
    expect(placementsByTeam.get(2)).toBe(1)
    expect(placementsByTeam.get(0)).toBe(2)
    expect(new Set([placementsByTeam.get(1), placementsByTeam.get(3)])).toEqual(new Set([3, 4]))
  })

  test('complete -> swap -> finalized activates once and only refreshes projections afterward', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '2v2',
      players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    })

    const started = await world.lobby.start('2v2', { hostId: 'p1' })
    await world.flushBackgroundTasks()

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    const beforeFinalized = new Map((await world.match.getParticipants(started.matchId)).map(participant => [participant.playerId, participant.civId]))
    const bansBeforeFinalized = await world.match.getBans(started.matchId)
    const firstPatchCount = countDiscordMessageUpdates(world, 'PATCH')
    const firstPostCount = countDiscordMessageUpdates(world, 'POST')

    expect((await world.party.replayDraftComplete(started.matchId)).status).toBe(200)
    const replayPatchCount = countDiscordMessageUpdates(world, 'PATCH')
    const replayPostCount = countDiscordMessageUpdates(world, 'POST')

    expect((await world.party.completeDraft(started.matchId, {
      finalized: true,
      transformState: (state) => {
        const swappedPicks = swapSeatPicks(state, 0, 2)
        if ('error' in swappedPicks) throw new Error(swappedPicks.error)
        return { ...state, picks: swappedPicks }
      },
    })).status).toBe(200)
    const finalizedPatchCount = countDiscordMessageUpdates(world, 'PATCH')
    const finalizedPostCount = countDiscordMessageUpdates(world, 'POST')
    const messageIds = await world.match.getMessageIds(started.matchId)
    const afterFinalized = new Map((await world.match.getParticipants(started.matchId)).map(participant => [participant.playerId, participant.civId]))
    const bansAfterFinalized = await world.match.getBans(started.matchId)

    expect(replayPatchCount).toBe(firstPatchCount)
    expect(replayPostCount).toBe(firstPostCount)
    expect(finalizedPatchCount).toBe(firstPatchCount + 1)
    expect(finalizedPostCount).toBe(firstPostCount)
    expect(messageIds).toEqual([expect.any(String)])
    expect((await world.match.get(started.matchId))?.status).toBe('active')
    expect(bansAfterFinalized).toEqual(bansBeforeFinalized)
    expect(afterFinalized.get('p1')).toBe(beforeFinalized.get('p2'))
    expect(afterFinalized.get('p2')).toBe(beforeFinalized.get('p1'))
    expect(afterFinalized.get('p3')).toBe(beforeFinalized.get('p3'))
    expect(afterFinalized.get('p4')).toBe(beforeFinalized.get('p4'))
  })

  test('terminal cancellation during swap cancels the active match and clears the lobby', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    })

    const started = await world.lobby.start('2v2', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const completionPayload = world.party.draftComplete(started.matchId)
    expect((await world.party.replayDraftComplete(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()
    expect((await world.match.get(started.matchId))?.status).toBe('active')
    expect((await world.lobby.getById(lobby.id))?.status).toBe('active')

    const cancelled = await world.party.cancelDraft(started.matchId, {
      reason: 'scrub',
      state: completionPayload.state,
    })
    await world.flushBackgroundTasks()

    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toEqual({ ok: true })
    expect((await world.match.get(started.matchId))?.status).toBe('cancelled')
    expect(await world.lobby.getById(lobby.id)).toBeNull()
  })

  test('activity scrub result embed names the scrubber', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host', displayName: 'Host Player' }, { id: 'potato', displayName: 'Potato' }],
      hostId: 'host',
    })

    const started = await world.lobby.start('1v1', { hostId: 'host', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const scrubbed = await world.match.scrub(started.matchId, {
      userId: 'host',
      displayName: 'Host Player',
      avatarUrl: 'https://cdn.discordapp.com/avatars/host/avatar.png',
    })
    expect(scrubbed.status).toBe(200)

    const message = world.discord.message(lobby.messageId)
    const payload = message?.payload as { embeds?: Array<{ title?: string, footer?: { text?: string, icon_url?: string }, fields?: Array<{ name: string, value: string, inline: boolean }> }> } | null | undefined
    const embed = payload?.embeds?.[0]
    expect(embed?.title).toContain('MATCH SCRUBBED')
    expect(embed?.fields?.some(field => field.name === 'Note')).toBe(false)
    expect(embed?.footer).toEqual({
      text: 'Host Player',
      icon_url: 'https://cdn.discordapp.com/avatars/host/avatar.png',
    })
  })

  test('deferred completion payloads keep the draft live until delivered, then apply activation and finalization', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
      channelId: 'channel-dropped-complete',
    })

    const started = await world.lobby.start('2v2', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    world.party.draftComplete(started.matchId)
    world.party.draftComplete(started.matchId, {
      finalized: true,
      transformState: (state) => {
        const swappedPicks = swapSeatPicks(state, 0, 2)
        if ('error' in swappedPicks) throw new Error(swappedPicks.error)
        return { ...state, picks: swappedPicks }
      },
    })
    const requestsBeforeReplay = world.discord.requests().length

    await expectDraftAndLobbyState(world, {
      mode: '2v2',
      lobbyId: lobby.id,
      matchId: started.matchId,
      lobbyStatus: 'drafting',
      matchStatus: 'drafting',
      queuePlayerIds: [],
    })

    expect((await world.party.replayDraftComplete(started.matchId, { index: 0 })).status).toBe(200)
    await world.flushBackgroundTasks()

    const beforeFinalized = new Map((await world.match.getParticipants(started.matchId)).map(participant => [participant.playerId, participant.civId]))
    const requestsAfterActivation = world.discord.requests().length

    await expectDraftAndLobbyState(world, {
      mode: '2v2',
      lobbyId: lobby.id,
      matchId: started.matchId,
      lobbyStatus: 'active',
      matchStatus: 'active',
      queuePlayerIds: [],
    })
    expect([...beforeFinalized.values()].every(civId => civId != null)).toBe(true)
    expect(requestsAfterActivation).toBeGreaterThan(requestsBeforeReplay)

    expect((await world.party.replayDraftComplete(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const afterFinalized = new Map((await world.match.getParticipants(started.matchId)).map(participant => [participant.playerId, participant.civId]))

    expect(afterFinalized.get('p1')).toBe(beforeFinalized.get('p2'))
    expect(afterFinalized.get('p2')).toBe(beforeFinalized.get('p1'))
    expect(afterFinalized.get('p3')).toBe(beforeFinalized.get('p3'))
    expect(afterFinalized.get('p4')).toBe(beforeFinalized.get('p4'))
    expect(world.discord.requests().length).toBeGreaterThan(requestsAfterActivation)
  })

  test('draft completion recreates a deleted tracked lobby message during activation', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })
    const staleMessageId = lobby.messageId

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    await world.discord.deleteCurrentLobbyMessage(lobby.id)
    const requestsBeforeComplete = world.discord.requests().length

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const activeLobby = await world.lobby.getById(lobby.id)
    const reboundMessage = await world.discord.currentLobbyMessage(lobby.id)
    const messageIds = await world.match.getMessageIds(started.matchId)
    const completeRequests = world.discord.requests().slice(requestsBeforeComplete)

    expect(activeLobby?.status).toBe('active')
    expect(activeLobby?.messageId).not.toBe(staleMessageId)
    expect(reboundMessage?.id).toBe(activeLobby?.messageId)
    expect(world.discord.message(staleMessageId)).toBeNull()
    expect(messageIds).toContain(activeLobby?.messageId)
    expect(completeRequests.some(request => request.method === 'PATCH' && request.url.includes(staleMessageId))).toBe(true)
    expect(completeRequests.some(request => request.method === 'POST' && request.url.includes(`/channels/${lobby.channelId}/messages`))).toBe(true)
  })

  test('timeout draft reopens lobby with the frozen roster', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1' })
    await world.flushBackgroundTasks()

    expect((await world.party.timeoutDraft(started.matchId)).status).toBe(200)

    const reopenedLobby = await world.lobby.get('1v1')
    expect(reopenedLobby?.status).toBe('open')
    expect(reopenedLobby?.hostId).toBe('p1')
    expect(reopenedLobby?.memberPlayerIds).toEqual(['p1', 'p2'])
    await expectQueuePlayers(world, '1v1', ['p1', 'p2'])
    expect((await world.match.get(started.matchId))?.status).toBe('cancelled')
  })

  test('pre-start cancel route clears live lobby state and leaves the mode ready for a fresh lobby', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-pre-start-cancel',
    })

    const cancelled = await world.lobby.cancel('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toEqual({ ok: true })
    expect(await world.lobby.get('1v1')).toBeNull()
    expect(await world.lobby.getById(lobby.id)).toBeNull()
    await expectQueuePlayers(world, '1v1', [])
    expect(await world.inspect.currentHostedLobby('p1')).toBeNull()
    expect(await world.inspect.lobbyMapping('p1')).toBeNull()
    expect(await world.inspect.lobbyMapping('p2')).toBeNull()
    expect(world.discord.requests().some(request => request.method === 'PATCH' && request.url.includes(lobby.messageId))).toBe(true)

    const freshLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-pre-start-cancel-fresh',
    })
    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: freshLobby.id })
    await world.flushBackgroundTasks()

    expect(started.ok).toBe(true)
    expect((await world.lobby.getById(freshLobby.id))?.status).toBe('drafting')
    await expectQueuePlayers(world, '1v1', [])
  })

  test('open lobby membership is removed on successful draft start', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players: createPlayers(4),
    })

    await world.lobby.start('2v2', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    await expectQueuePlayers(world, '2v2', [])
  })

  test('scrubbed draft closes and clears the terminal lobby state', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1' })
    await world.flushBackgroundTasks()

    expect((await world.party.cancelDraft(started.matchId, { reason: 'scrub' })).status).toBe(200)

    expect(await world.lobby.get('1v1')).toBeNull()
    expect((await world.match.get(started.matchId))?.status).toBe('cancelled')
    expect(world.discord.requests().some(request => request.method === 'PATCH' && request.url.includes('seed-message-p1-1v1'))).toBe(true)
  })

  test('join after report clears stale live residue and joins a fresh lobby cleanly', async () => {
    const world = await createTrackedWorld()
    const initialLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: initialLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)

    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect(await world.inspect.lobbyByMatch(started.matchId)).toBeNull()
    expect(await world.inspect.lobbiesForPlayer('p1')).toEqual([])

    const freshLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p3' }],
      hostId: 'p3',
    })

    const joinResponse = await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(200)
    expect((await world.lobby.getById(freshLobby.id))?.memberPlayerIds).toEqual(['p3', 'p1'])
    expect((await world.lobby.getById(freshLobby.id))?.slots).toEqual(['p3', 'p1'])
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.lobbyMapping('p1')).toBe(freshLobby.id)
    const launch = await world.activity.launch({ channelId: freshLobby.channelId, userId: 'p1' })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: freshLobby.id,
          isMember: true,
        },
      },
    })
  })

  test('activity launch ignores slotted-only residue and still offers the real join target', async () => {
    const world = await createTrackedWorld()
    const sourceLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'source-host' }],
      hostId: 'source-host',
      channelId: 'channel-source',
    })
    const targetLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'target-host' }],
      hostId: 'target-host',
      channelId: 'channel-target',
    })

    await world.corrupt.openLobbyResidue(sourceLobby.id, {
      memberPlayerIds: ['source-host'],
      slots: ['source-host', null],
    })

    const launch = await world.activity.launch({ channelId: targetLobby.channelId, userId: 'p1' })

    expect(launch.status).toBe(200)
    expect(launch.body).toMatchObject({
      selection: null,
      options: [
        expect.objectContaining({ id: targetLobby.id, kind: 'lobby' }),
      ],
    })
    expect(await world.inspect.lobbiesForPlayer('p1')).toEqual([])
    expect((await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: targetLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })).status).toBe(200)
    await world.flushBackgroundTasks()
    expect(await world.inspect.lobbyMapping('p1')).toBe(targetLobby.id)
  })

  test('current-lobby route resolves the real open lobby from canonical membership', async () => {
    const world = await createTrackedWorld()
    const realLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }, { id: 'p1' }],
      hostId: 'host',
      channelId: 'channel-real',
    })

    const currentLobby = await world.activity.currentLobby({ userId: 'p1' })

    expect(currentLobby.status).toBe(200)
    expect(currentLobby.body).toMatchObject({ id: realLobby.id })
  })

  test('initial open-lobby launch render is coherent for the host and an unrelated spectator in the same channel', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }, { id: 'p1' }],
      hostId: 'host',
      channelId: 'channel-open-render',
    })

    const [hostLaunch, spectatorLaunch] = await Promise.all([
      world.activity.launch({ channelId: lobby.channelId, userId: 'host' }),
      world.activity.launch({ channelId: lobby.channelId, userId: 'spectator' }),
    ])

    expect(hostLaunch.status).toBe(200)
    expect(hostLaunch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: lobby.id,
          isHost: true,
          isMember: true,
        },
      },
      options: [
        expect.objectContaining({
          id: lobby.id,
          kind: 'lobby',
          isHost: true,
          isMember: true,
        }),
      ],
    })

    expect(spectatorLaunch.status).toBe(200)
    expect(spectatorLaunch.body).toMatchObject({
      selection: null,
      options: [
        expect.objectContaining({
          id: lobby.id,
          kind: 'lobby',
          isHost: false,
          isMember: false,
        }),
      ],
    })
  })

  test('activity launch recovers a canonical lobby when its own channel index is missing and poisoned elsewhere', async () => {
    const world = await createTrackedWorld()
    const canonicalLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }],
      hostId: 'host',
      channelId: 'channel-canonical',
    })
    const otherLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'other-host' }],
      hostId: 'other-host',
      channelId: 'channel-other',
    })

    await world.corrupt.lobbyChannel(canonicalLobby.id, otherLobby.channelId)

    const [canonicalLaunch, otherLaunch] = await Promise.all([
      world.activity.launch({ channelId: canonicalLobby.channelId, userId: 'spectator' }),
      world.activity.launch({ channelId: otherLobby.channelId, userId: 'spectator' }),
    ])

    expect(canonicalLaunch.status).toBe(200)
    expect(canonicalLaunch.body).toMatchObject({
      selection: null,
      options: [
        expect.objectContaining({ id: canonicalLobby.id, kind: 'lobby' }),
      ],
    })
    expect(otherLaunch.status).toBe(200)
    expect(otherLaunch.body).toMatchObject({
      options: [
        expect.objectContaining({ id: otherLobby.id, kind: 'lobby' }),
      ],
    })
    expect((otherLaunch.body as { options?: Array<{ id: string }> }).options?.some(option => option.id === canonicalLobby.id)).toBe(false)

    const joinResponse = await world.lobby.place('1v1', {
      userId: 'spectator',
      lobbyId: canonicalLobby.id,
      targetSlot: 1,
      displayName: 'spectator',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(200)
    expect(await world.inspect.lobbyMapping('spectator')).toBe(canonicalLobby.id)
  })

  test('match lookup derives from canonical live match state', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-match-repair',
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const currentMatch = await world.activity.currentMatch({ userId: 'p1' })

    expect(currentMatch.status).toBe(200)
    expect(currentMatch.body).toEqual({ matchId: started.matchId })
  })

  test('match lookup derives current match after the same session restarts from a cancelled draft', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-poisoned-current-match',
    })

    const oldMatch = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.timeoutDraft(oldMatch.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const reopenedLobby = await world.lobby.getById(lobby.id)
    expect((await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: reopenedLobby!.id,
      targetSlot: 0,
      displayName: 'p1',
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    const liveMatch = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: reopenedLobby!.id })
    await world.flushBackgroundTasks()

    expect(liveMatch.matchId).toBe(oldMatch.matchId)

    const currentMatch = await world.activity.currentMatch({ userId: 'p2' })
    const launch = await world.activity.launch({ channelId: lobby.channelId, userId: 'p2' })

    expect(currentMatch.status).toBe(200)
    expect(currentMatch.body).toEqual({ matchId: liveMatch.matchId })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: liveMatch.matchId,
      },
    })
  })

  test('host lookup repairs a stale lobby-host mapping to the canonical lobby', async () => {
    const world = await createTrackedWorld()
    const realLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }, { id: 'p2' }],
      hostId: 'host',
    })
    const otherLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'other-host' }],
      hostId: 'other-host',
      channelId: 'channel-other-host',
    })

    await world.corrupt.lobbyHost('host', otherLobby.id)

    const repairedLobby = await world.inspect.currentHostedLobby('host')

    expect(repairedLobby?.id).toBe(realLobby.id)
    expect(await world.inspect.currentHostedLobby('host')).toMatchObject({ id: realLobby.id })
  })

  test('spectator live-session targeting returns a valid session token', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players: createPlayers(4, 'spec'),
      channelId: 'channel-spectator',
    })

    const started = await world.lobby.start('2v2', { hostId: 'spec1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const target = await world.activity.targetMatch({
      channelId: lobby.channelId,
      userId: 'spectator-1',
      matchId: started.matchId,
    })

    expect(target.status).toBe(200)
    expect(target.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'match',
          matchId: started.matchId,
        },
      },
    })

    const sessionAccessToken = (target.body as { snapshot?: { selection?: { sessionAccessToken?: string | null } | null } }).snapshot?.selection?.sessionAccessToken ?? null
    expect(sessionAccessToken).not.toBeNull()
    await expect(verifySessionAccessToken('secret', sessionAccessToken, {
      sessionId: started.matchId,
      userId: 'spectator-1',
    })).resolves.not.toBeNull()
    await expect(verifySessionAccessToken('secret', sessionAccessToken, {
      sessionId: started.matchId,
      userId: 'wrong-user',
    })).resolves.toBeNull()
    await expect(verifySessionAccessToken('secret', sessionAccessToken, {
      sessionId: 'wrong-session',
      userId: 'spectator-1',
    })).resolves.toBeNull()
  })

  test('spectator retargeting persists the latest selected follow target', async () => {
    const world = await createTrackedWorld()
    const firstLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host-a' }],
      hostId: 'host-a',
      channelId: 'channel-retarget',
    })
    const secondLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host-b' }],
      hostId: 'host-b',
      channelId: 'channel-retarget',
    })

    await world.activity.targetLobby({
      channelId: firstLobby.channelId,
      userId: 'spectator',
      lobbyId: firstLobby.id,
    })
    const selected = await world.activity.targetLobby({
      channelId: secondLobby.channelId,
      userId: 'spectator',
      lobbyId: secondLobby.id,
    })

    const launch = await world.activity.launch({ channelId: firstLobby.channelId, userId: 'spectator' })

    expect(selected.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'lobby',
          option: {
            id: secondLobby.id,
            isHost: false,
            isMember: false,
          },
        },
      },
    })
    expect(launch.status).toBe(200)
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: secondLobby.id,
          isHost: false,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: firstLobby.id, kind: 'lobby' }),
        expect.objectContaining({ id: secondLobby.id, kind: 'lobby' }),
      ]),
    })
  })

  test('spectator-selected open lobby exposes the correct live match while another open lobby still exists in-channel', async () => {
    const world = await createTrackedWorld()
    const targetLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host-a' }, { id: 'p1' }],
      hostId: 'host-a',
      channelId: 'channel-shared-start',
    })
    const otherLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host-b' }],
      hostId: 'host-b',
      channelId: 'channel-shared-start',
    })

    const selectedLobby = await world.activity.targetLobby({
      channelId: targetLobby.channelId,
      userId: 'spectator',
      lobbyId: targetLobby.id,
    })
    expect(selectedLobby.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'lobby',
          option: { id: targetLobby.id },
        },
      },
    })

    const started = await world.lobby.start('1v1', { hostId: 'host-a', lobbyId: targetLobby.id })
    await world.flushBackgroundTasks()

    const launch = await world.activity.launch({ channelId: targetLobby.channelId, userId: 'spectator' })
    const selectedMatch = await world.activity.targetMatch({
      channelId: targetLobby.channelId,
      userId: 'spectator',
      matchId: started.matchId,
    })

    expect(launch.status).toBe(200)
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: started.matchId,
        option: {
          id: started.matchId,
          lobbyId: targetLobby.id,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: started.matchId, kind: 'match', lobbyId: targetLobby.id }),
        expect.objectContaining({ id: otherLobby.id, kind: 'lobby' }),
      ]),
    })
    expect(selectedMatch.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'match',
          matchId: started.matchId,
          option: {
            id: started.matchId,
            lobbyId: targetLobby.id,
            isMember: false,
          },
        },
      },
    })

    expect((await world.party.cancelDraft(started.matchId, { reason: 'revert' })).status).toBe(200)
    await world.flushBackgroundTasks()

    const revertedLaunch = await world.activity.launch({ channelId: targetLobby.channelId, userId: 'spectator' })
    expect(revertedLaunch.status).toBe(200)
    expect(revertedLaunch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: targetLobby.id,
          isMember: false,
        },
      },
    })
  })

  test('participant launch after start respects an explicit spectator follow target', async () => {
    const world = await createTrackedWorld()
    const liveLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-live-selection',
    })
    const staleOpenLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'other-host' }],
      hostId: 'other-host',
      channelId: 'channel-live-selection',
    })

    await world.activity.targetLobby({
      channelId: liveLobby.channelId,
      userId: 'p1',
      lobbyId: staleOpenLobby.id,
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: liveLobby.id })
    await world.flushBackgroundTasks()

    const launch = await world.activity.launch({ channelId: liveLobby.channelId, userId: 'p1' })

    expect(launch.status).toBe(200)
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: staleOpenLobby.id,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: started.matchId, kind: 'match', lobbyId: liveLobby.id, isMember: true }),
      ]),
    })
  })

  test('revert cancel lifecycle sync restores the original roster and lobby targeting', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(4, 'revert')
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      channelId: 'channel-revert',
    })

    const started = await world.lobby.start('2v2', { hostId: 'revert1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect((await world.party.cancelDraft(started.matchId, { reason: 'revert' })).status).toBe(200)
    await world.flushBackgroundTasks()

    const reopenedLobby = await world.lobby.getById(lobby.id)
    const p2Launch = await world.activity.launch({ channelId: lobby.channelId, userId: 'revert2' })

    expect(reopenedLobby?.status).toBe('open')
    expect(reopenedLobby?.matchId).toBeNull()
    expect(reopenedLobby?.memberPlayerIds).toEqual(players.map(player => player.id))
    expect(reopenedLobby?.slots).toEqual(players.map(player => player.id))
    await expectQueuePlayers(world, '2v2', players.map(player => player.id))
    expect(await world.inspect.matchMapping('revert1')).toBeNull()
    expect(await world.inspect.lobbyMapping('revert1')).toBe(lobby.id)
    expect(await world.inspect.lobbyMapping('revert2')).toBe(lobby.id)
    expect(p2Launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: lobby.id,
          isMember: true,
        },
      },
    })
  })

  test('repeat draft resumes a reverted lobby with the same players', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(2, 'repeat-resume')
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      channelId: 'channel-repeat-resume',
    })

    const started = await world.lobby.start('1v1', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.cancelDraft(started.matchId, { reason: 'revert' })).status).toBe(200)
    await world.flushBackgroundTasks()

    const launch = await world.activity.launch({ channelId: lobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: lobby.id,
          repeatDraft: {
            kind: 'resume',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('1v1', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('resume')
    expect(repeated.matchId).toBe(started.matchId)
    expect((await world.match.get(repeated.matchId))?.status).toBe('drafting')
    expect((await world.lobby.getById(lobby.id))?.status).toBe('drafting')
  })

  test('repeat draft resumes a timed-out lobby with the same players', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(2, 'repeat-timeout')
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      channelId: 'channel-repeat-timeout',
    })

    const started = await world.lobby.start('1v1', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.timeoutDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const launch = await world.activity.launch({ channelId: lobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: lobby.id,
          repeatDraft: {
            kind: 'resume',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('1v1', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('resume')
    expect(repeated.matchId).toBe(started.matchId)
    expect((await world.match.get(repeated.matchId))?.status).toBe('drafting')
    expect((await world.lobby.getById(lobby.id))?.status).toBe('drafting')
  })

  test('repeat draft copies a completed draft into a new matching lobby', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(2, 'repeat-complete')
    const firstLobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      channelId: 'channel-repeat-complete',
    })
    const started = await world.lobby.start('1v1', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const sourceParticipants = await world.match.getParticipants(started.matchId)
    const secondLobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      channelId: firstLobby.channelId,
    })

    await world.activity.targetLobby({ channelId: secondLobby.channelId, userId: players[0]!.id, lobbyId: secondLobby.id })
    const launch = await world.activity.launch({ channelId: secondLobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: secondLobby.id,
          repeatDraft: {
            kind: 'complete',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('1v1', { hostId: players[0]!.id, lobbyId: secondLobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('complete')
    expect(repeated.matchId).toBe(secondLobby.id)
    const repeatedMatch = await world.match.get(repeated.matchId)
    expect(repeatedMatch?.status).toBe('active')
    const repeatedDraftData = JSON.parse(repeatedMatch?.draftData ?? '{}') as { mapVoteResult?: unknown }
    expect(repeatedDraftData.mapVoteResult).toBeNull()

    const civByPlayer = new Map(sourceParticipants.map(participant => [participant.playerId, participant.civId]))
    const repeatedParticipants = await world.match.getParticipants(repeated.matchId)
    expect(repeatedParticipants.map(participant => [participant.playerId, participant.civId])).toEqual(
      players.map(player => [player.id, civByPlayer.get(player.id)]),
    )
  })

  test('repeat draft keeps player leaders when same-team seats are reordered', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(4, 'repeat-team-order')
    const firstLobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: players.map(player => player.id),
      channelId: 'channel-repeat-team-order',
    })
    const started = await world.lobby.start('2v2', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const sourceParticipants = await world.match.getParticipants(started.matchId)
    const secondLobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: [players[1]!.id, players[0]!.id, players[3]!.id, players[2]!.id],
      channelId: firstLobby.channelId,
    })

    await world.activity.targetLobby({ channelId: secondLobby.channelId, userId: players[0]!.id, lobbyId: secondLobby.id })
    const launch = await world.activity.launch({ channelId: secondLobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: secondLobby.id,
          repeatDraft: {
            kind: 'complete',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('2v2', { hostId: players[0]!.id, lobbyId: secondLobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('complete')
    const civByPlayer = new Map(sourceParticipants.map(participant => [participant.playerId, participant.civId]))
    const repeatedParticipants = await world.match.getParticipants(repeated.matchId)
    const repeatedCivByPlayer = new Map(repeatedParticipants.map(participant => [participant.playerId, participant.civId]))
    for (const player of players) expect(repeatedCivByPlayer.get(player.id)).toBe(civByPlayer.get(player.id))
    expect(new Map(repeatedParticipants.map(participant => [participant.playerId, participant.team]))).toEqual(new Map([
      [players[0]!.id, 0],
      [players[1]!.id, 0],
      [players[2]!.id, 1],
      [players[3]!.id, 1],
    ]))
  })

  test('repeat draft keeps player leaders when teams swap sides', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(4, 'repeat-team-swap')
    const firstLobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: players.map(player => player.id),
      channelId: 'channel-repeat-team-swap',
    })
    const started = await world.lobby.start('2v2', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const sourceParticipants = await world.match.getParticipants(started.matchId)
    const secondLobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: [players[2]!.id, players[3]!.id, players[0]!.id, players[1]!.id],
      channelId: firstLobby.channelId,
    })

    await world.activity.targetLobby({ channelId: secondLobby.channelId, userId: players[0]!.id, lobbyId: secondLobby.id })
    const launch = await world.activity.launch({ channelId: secondLobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: secondLobby.id,
          repeatDraft: {
            kind: 'complete',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('2v2', { hostId: players[0]!.id, lobbyId: secondLobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('complete')
    const civByPlayer = new Map(sourceParticipants.map(participant => [participant.playerId, participant.civId]))
    const repeatedParticipants = await world.match.getParticipants(repeated.matchId)
    const repeatedCivByPlayer = new Map(repeatedParticipants.map(participant => [participant.playerId, participant.civId]))
    for (const player of players) expect(repeatedCivByPlayer.get(player.id)).toBe(civByPlayer.get(player.id))
    expect(new Map(repeatedParticipants.map(participant => [participant.playerId, participant.team]))).toEqual(new Map([
      [players[2]!.id, 0],
      [players[3]!.id, 0],
      [players[0]!.id, 1],
      [players[1]!.id, 1],
    ]))
  })

  test('repeat draft keeps player leaders when 1v1 seats are reordered', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(2, 'repeat-duel-order')
    const firstLobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      channelId: 'channel-repeat-duel-order',
    })
    const started = await world.lobby.start('1v1', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const sourceParticipants = await world.match.getParticipants(started.matchId)
    const secondLobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      slots: [players[1]!.id, players[0]!.id],
      channelId: firstLobby.channelId,
    })

    await world.activity.targetLobby({ channelId: secondLobby.channelId, userId: players[0]!.id, lobbyId: secondLobby.id })
    const launch = await world.activity.launch({ channelId: secondLobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: secondLobby.id,
          repeatDraft: {
            kind: 'complete',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('1v1', { hostId: players[0]!.id, lobbyId: secondLobby.id })
    await world.flushBackgroundTasks()

    const civByPlayer = new Map(sourceParticipants.map(participant => [participant.playerId, participant.civId]))
    const repeatedParticipants = await world.match.getParticipants(repeated.matchId)
    const repeatedCivByPlayer = new Map(repeatedParticipants.map(participant => [participant.playerId, participant.civId]))
    for (const player of players) expect(repeatedCivByPlayer.get(player.id)).toBe(civByPlayer.get(player.id))
  })

  test('repeat draft resumes a reverted team draft after same-team seats are reordered', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(4, 'repeat-resume-order')
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: players.map(player => player.id),
      channelId: 'channel-repeat-resume-order',
    })

    const started = await world.lobby.start('2v2', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.cancelDraft(started.matchId, { reason: 'revert' })).status).toBe(200)
    await world.flushBackgroundTasks()

    expect((await world.lobby.place('2v2', { userId: players[0]!.id, lobbyId: lobby.id, playerId: players[1]!.id, targetSlot: 0 })).status).toBe(200)
    expect((await world.lobby.place('2v2', { userId: players[0]!.id, lobbyId: lobby.id, playerId: players[3]!.id, targetSlot: 2 })).status).toBe(200)

    const launch = await world.activity.launch({ channelId: lobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: lobby.id,
          repeatDraft: {
            kind: 'resume',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('2v2', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('resume')
    expect(repeated.matchId).toBe(started.matchId)
    expect((await world.match.get(repeated.matchId))?.status).toBe('drafting')
  })

  test('repeat draft resumes a reverted team draft after teams swap sides', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(4, 'repeat-resume-swap')
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: players.map(player => player.id),
      channelId: 'channel-repeat-resume-swap',
    })

    const started = await world.lobby.start('2v2', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.cancelDraft(started.matchId, { reason: 'revert' })).status).toBe(200)
    await world.flushBackgroundTasks()

    expect((await world.lobby.place('2v2', { userId: players[0]!.id, lobbyId: lobby.id, playerId: players[2]!.id, targetSlot: 0 })).status).toBe(200)
    expect((await world.lobby.place('2v2', { userId: players[0]!.id, lobbyId: lobby.id, playerId: players[3]!.id, targetSlot: 1 })).status).toBe(200)

    const launch = await world.activity.launch({ channelId: lobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: lobby.id,
          repeatDraft: {
            kind: 'resume',
            matchId: started.matchId,
          },
        },
      },
    })

    const repeated = await world.lobby.repeat('2v2', { hostId: players[0]!.id, lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect(repeated.kind).toBe('resume')
    expect(repeated.matchId).toBe(started.matchId)
    expect((await world.match.get(repeated.matchId))?.status).toBe('drafting')
  })

  test('repeat draft rejects the same players seated on different teams', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(4, 'repeat-teams')
    const firstLobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: players.map(player => player.id),
      channelId: 'channel-repeat-teams',
    })
    const started = await world.lobby.start('2v2', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const secondLobby = await world.lobby.createOpen({
      mode: '2v2',
      players,
      slots: [players[0]!.id, players[2]!.id, players[1]!.id, players[3]!.id],
      channelId: firstLobby.channelId,
    })

    await world.activity.targetLobby({ channelId: secondLobby.channelId, userId: players[0]!.id, lobbyId: secondLobby.id })
    const launch = await world.activity.launch({ channelId: secondLobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: secondLobby.id,
        },
      },
    })
    expect((launch.body as any).selection.lobby.repeatDraft).toBeUndefined()
    await expect(world.lobby.repeat('2v2', { hostId: players[0]!.id, lobbyId: secondLobby.id })).rejects.toThrow('No repeatable draft matches the current players and teams.')
  })

  test('repeat draft requires the host to be slotted', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(2, 'repeat-host-seat')
    const firstLobby = await world.lobby.createOpen({
      mode: '1v1',
      players,
      channelId: 'channel-repeat-host-seat',
    })
    const started = await world.lobby.start('1v1', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const secondLobby = await world.lobby.createOpen({
      mode: '1v1',
      hostId: 'repeat-host-seat-host',
      players,
      channelId: firstLobby.channelId,
    })

    await expect(world.lobby.repeat('1v1', { hostId: 'repeat-host-seat-host', lobbyId: secondLobby.id })).rejects.toThrow('Host must be in a lobby slot before repeating.')
  })

  test('repeat draft rejects completed FFA drafts with a different Permanent Ally setting', async () => {
    const world = await createTrackedWorld()
    const players = createPlayers(8, 'repeat-pa')
    const firstLobby = await world.lobby.createOpen({
      mode: 'ffa',
      players,
      channelId: 'channel-repeat-pa',
    })
    const started = await world.lobby.start('ffa', { hostId: players[0]!.id, lobbyId: firstLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const secondLobby = await world.lobby.createOpen({
      mode: 'ffa',
      players,
      channelId: firstLobby.channelId,
    })
    expect((await world.lobby.config('ffa', { hostId: players[0]!.id, lobbyId: secondLobby.id, permanentAlly: false })).status).toBe(200)

    await world.activity.targetLobby({ channelId: secondLobby.channelId, userId: players[0]!.id, lobbyId: secondLobby.id })
    const launch = await world.activity.launch({ channelId: secondLobby.channelId, userId: players[0]!.id })
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        lobby: {
          id: secondLobby.id,
        },
      },
    })
    expect((launch.body as any).selection.lobby.repeatDraft).toBeUndefined()
    await expect(world.lobby.repeat('ffa', { hostId: players[0]!.id, lobbyId: secondLobby.id })).rejects.toThrow('No repeatable draft matches the current players and teams.')
  })

  test('report sync recreates a deleted lobby message and rebinds the stored message id', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })
    const staleMessageId = lobby.messageId

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)

    await world.discord.deleteCurrentLobbyMessage(lobby.id)
    const requestsBeforeReport = world.discord.requests().length

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    const messageIds = await world.match.getMessageIds(started.matchId)
    const reboundMessageId = messageIds.find(messageId => messageId !== staleMessageId) ?? null
    const reportRequests = world.discord.requests().slice(requestsBeforeReport)

    expect(world.discord.message(staleMessageId)).toBeNull()
    expect(reboundMessageId).not.toBeNull()
    expect(world.discord.message(reboundMessageId!)).not.toBeNull()
    expect(reportRequests.some(request => request.method === 'PATCH' && request.url.includes(staleMessageId))).toBe(true)
    expect(reportRequests.some(request => request.method === 'POST' && request.url.includes(`/channels/${lobby.channelId}/messages`))).toBe(true)
  })

  test('report cleanup clears live state but leaves message context usable for later sync', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    const messageIds = await world.match.getMessageIds(started.matchId)
    expect(messageIds.length).toBeGreaterThanOrEqual(2)
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect(await world.inspect.lobbyByMatch(started.matchId)).toBeNull()

    world.discord.deleteMessage(messageIds[0]!)

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(world.discord.requests().some(request => request.method === 'PATCH' && request.url.includes(messageIds[1]!))).toBe(true)
  })

  test('duplicate report submission is idempotent and does not recreate archive or cleanup side effects', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    const archivePostsAfterFirstReport = world.discord.requests().filter(request => request.method === 'POST' && request.url.includes('/channels/channel-archive/messages')).length
    const messageIdsAfterFirstReport = await world.match.getMessageIds(started.matchId)

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    expect((await world.match.get(started.matchId))?.status).toBe('completed')
    expect(await world.lobby.getById(lobby.id)).toBeNull()
    expect(await world.inspect.lobbyByMatch(started.matchId)).toBeNull()
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect(world.discord.requests().filter(request => request.method === 'POST' && request.url.includes('/channels/channel-archive/messages'))).toHaveLength(archivePostsAfterFirstReport)
    expect(await world.match.getMessageIds(started.matchId)).toEqual(messageIdsAfterFirstReport)
  })

  test('concurrent duplicate report submission creates one archive result', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const reports = await Promise.all([
      world.match.report(started.matchId, {
        reporterId: 'p1',
        placements: 'A',
      }),
      world.match.report(started.matchId, {
        reporterId: 'p1',
        placements: 'A',
      }),
    ])
    await world.flushBackgroundTasks()

    expect(reports.every(report => report.ok)).toBe(true)
    expect((await world.match.get(started.matchId))?.status).toBe('completed')
    expect(world.discord.requests().filter(request => request.method === 'POST' && request.url.includes('/channels/channel-archive/messages'))).toHaveLength(1)
    expect((await world.match.getMessageIds(started.matchId)).length).toBeGreaterThanOrEqual(2)
  })

  test('concurrent duplicate tournament report submission creates one archive image', async () => {
    const world = await createTrackedWorld()
    await setSystemChannel(world.kv, 'tournament-archive', 'channel-tournament-archive')
    const playerOneId = '100000000000000001'
    const playerTwoId = '100000000000000002'

    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: playerOneId, displayName: 'Alice' }, { id: playerTwoId, displayName: 'Bob' }],
    })
    const tournament = await createTournament(world.db, { name: 'Concurrent Cup', createdById: 'admin', minGames: 1 })
    const imported = await importTournamentPlayersCsv(world.db, tournament.id, [
      'seed,display_name,confirmed,discord_user_id',
      `1,Alice,true,${playerOneId}`,
      `2,Bob,true,${playerTwoId}`,
    ].join('\n'))
    expect('error' in imported).toBe(false)
    await createTournamentMatchLink(world.db, {
      tournamentId: tournament.id,
      sessionId: lobby.id,
      hostId: playerOneId,
      playerOneId,
      playerTwoId,
    })

    const started = await world.lobby.start('1v1', { hostId: playerOneId, lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const reports = await Promise.all([
      world.match.report(started.matchId, {
        reporterId: playerOneId,
        placements: 'A',
      }),
      world.match.report(started.matchId, {
        reporterId: playerOneId,
        placements: 'A',
      }),
    ])
    await world.flushBackgroundTasks()

    expect(reports.every(report => report.ok)).toBe(true)
    expect((await world.match.get(started.matchId))?.status).toBe('completed')
    expect(world.discord.requests().filter(request => request.method === 'POST' && request.url.includes('/channels/channel-tournament-archive/messages'))).toHaveLength(1)
    expect(world.discord.requests().filter(request => request.method === 'POST' && request.url.includes('/channels/channel-archive/messages'))).toHaveLength(0)
  })

  test('stale cancellation redelivery after players move on does not clear the newer lobby bindings or message', async () => {
    const world = await createTrackedWorld()
    const oldLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-stale-old-scrub',
    })

    const oldMatch = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: oldLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.cancelDraft(oldMatch.matchId, { reason: 'scrub' })).status).toBe(200)
    await world.flushBackgroundTasks()

    const newLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'fresh-host' }, { id: 'p1' }],
      hostId: 'fresh-host',
      channelId: oldLobby.channelId,
    })
    const selectedLobby = await world.activity.targetLobby({
      channelId: newLobby.channelId,
      userId: 'spectator-1',
      lobbyId: newLobby.id,
    })
    const requestsBeforeReplay = world.discord.requests().length
    const messageBeforeReplay = await world.discord.currentLobbyMessage(newLobby.id)

    expect(selectedLobby.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'lobby',
          option: { id: newLobby.id },
        },
      },
    })

    expect((await world.party.replayDraftCancel(oldMatch.matchId, { index: 0 })).status).toBe(200)
    await world.flushBackgroundTasks()

    const replayRequests = world.discord.requests().slice(requestsBeforeReplay)
    const launch = await world.activity.launch({ channelId: newLobby.channelId, userId: 'spectator-1' })

    expect((await world.match.get(oldMatch.matchId))?.status).toBe('cancelled')
    expect(await world.lobby.getById(oldLobby.id)).toBeNull()
    expect((await world.lobby.getById(newLobby.id))?.status).toBe('open')
    expect(await world.inspect.lobbyMapping('p1')).toBe(newLobby.id)
    expect(await world.inspect.lobbyMapping('p2')).toBeNull()
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: newLobby.id,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: newLobby.id, kind: 'lobby' }),
      ]),
    })
    expect((await world.discord.currentLobbyMessage(newLobby.id))?.id).toBe(messageBeforeReplay?.id)
    expect(replayRequests.some(request => request.url.includes(newLobby.messageId))).toBe(false)
  })

  test('duplicate old report after players move on leaves the newer live participant bindings untouched', async () => {
    const world = await createTrackedWorld()
    const oldLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-stale-old-report',
    })

    const oldMatch = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: oldLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(oldMatch.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()
    expect((await world.match.report(oldMatch.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    const newLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'fresh-host' }, { id: 'p1' }],
      hostId: 'fresh-host',
      channelId: oldLobby.channelId,
    })
    await world.activity.targetLobby({
      channelId: newLobby.channelId,
      userId: 'spectator-1',
      lobbyId: newLobby.id,
    })

    const newMatch = await world.lobby.start('1v1', { hostId: 'fresh-host', lobbyId: newLobby.id })
    await world.flushBackgroundTasks()

    const requestsBeforeDuplicateReport = world.discord.requests().length
    expect((await world.match.report(oldMatch.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    const duplicateReportRequests = world.discord.requests().slice(requestsBeforeDuplicateReport)
    const spectatorLaunch = await world.activity.launch({ channelId: newLobby.channelId, userId: 'spectator-1' })
    expect(await world.inspect.matchMapping('p1')).toBe(newMatch.matchId)
    expect(await world.inspect.matchMapping('fresh-host')).toBe(newMatch.matchId)
    expect(spectatorLaunch.body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: newMatch.matchId,
        option: {
          id: newMatch.matchId,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: newMatch.matchId, kind: 'match' }),
      ]),
    })
    expect(duplicateReportRequests.some(request => request.url.includes(newLobby.messageId))).toBe(false)
  })

  test('reported players get a fresh activity launch without reusing stale match bindings', async () => {
    const world = await createTrackedWorld()
    const initialLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: initialLobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)

    const freshLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'fresh-host' }],
      hostId: 'fresh-host',
      channelId: initialLobby.channelId,
    })

    const launch = await world.activity.launch({ channelId: initialLobby.channelId, userId: 'p1' })

    expect(launch.status).toBe(200)
    expect(launch.body).toMatchObject({
      selection: null,
      options: [
        expect.objectContaining({ id: freshLobby.id, kind: 'lobby' }),
      ],
    })
    expect((await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })).status).toBe(200)
    await world.flushBackgroundTasks()
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.lobbyByMatch(started.matchId)).toBeNull()
    expect(await world.inspect.lobbyMapping('p1')).toBe(freshLobby.id)
  })

  test('activity launch keeps explicit spectator follow target separate from real membership', async () => {
    const world = await createTrackedWorld()
    const currentLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }, { id: 'p1' }],
      hostId: 'host',
      channelId: 'channel-shared',
    })
    const staleLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'other-host' }],
      hostId: 'other-host',
      channelId: 'channel-shared',
    })

    await world.activity.targetLobby({
      channelId: currentLobby.channelId,
      userId: 'p1',
      lobbyId: staleLobby.id,
    })

    const launch = await world.activity.launch({ channelId: currentLobby.channelId, userId: 'p1' })

    expect(launch.status).toBe(200)
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: staleLobby.id,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: currentLobby.id, kind: 'lobby', isMember: true }),
      ]),
    })
  })

  test('real join route blocks a drafting player until the canonical session is terminal', async () => {
    const world = await createTrackedWorld()
    const liveLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-stale-live-join',
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: liveLobby.id })
    await world.flushBackgroundTasks()

    const freshLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'fresh-host' }],
      hostId: 'fresh-host',
      channelId: 'channel-fresh-join',
    })

    const blockedJoin = await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })

    expect(blockedJoin.status).toBe(400)
    expect(blockedJoin.body).toEqual({ error: 'That player is already in a live match.' })

    await world.db.update(matches).set({ status: 'completed' }).where(eq(matches.id, started.matchId))

    const stillBlockedJoin = await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })

    expect(stillBlockedJoin.status).toBe(400)

    await runSessionTerminalLifecycleCommand(world.env.SessionDO, liveLobby.id, { type: 'mark-reported', matchId: started.matchId, at: Date.now() })

    const recoveredJoin = await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })
    await world.flushBackgroundTasks()

    expect(recoveredJoin.status).toBe(200)
    expect((await world.lobby.getById(freshLobby.id))?.memberPlayerIds).toEqual(['fresh-host', 'p1'])
    expect((await world.lobby.getById(freshLobby.id))?.slots).toEqual(['fresh-host', 'p1'])
    expect(await world.inspect.lobbyMapping('p1')).toBe(freshLobby.id)
    expect(await world.inspect.matchMapping('p1')).toBeNull()
  })

  test('draft-complete active sessions release admission before report', async () => {
    const world = await createTrackedWorld()
    const liveLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-active-release',
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: liveLobby.id })
    await world.flushBackgroundTasks()
    const finalized = await world.party.completeDraft(started.matchId, { finalized: true })
    expect(finalized.status).toBe(200)
    await world.flushBackgroundTasks()

    const freshLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'fresh-host' }],
      hostId: 'fresh-host',
      channelId: 'channel-after-active-release',
    })

    const selectedLobby = await world.activity.targetLobby({
      channelId: freshLobby.channelId,
      userId: 'p1',
      lobbyId: freshLobby.id,
    })
    expect(selectedLobby.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'lobby',
          joinEligibility: {
            canJoin: true,
            blockedReason: null,
            pendingSlot: 1,
          },
        },
      },
    })

    const joined = await world.lobby.place('1v1', {
      userId: 'p1',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p1',
    })

    expect(joined.status).toBe(200)
    expect((await world.lobby.getById(freshLobby.id))?.memberPlayerIds).toEqual(['fresh-host', 'p1'])
    expect((await world.inspect.lobbiesForPlayer('p1')).map(lobby => lobby.id)).toEqual([freshLobby.id])
  })

  test('steam lobby link add update and clear is reflected in participant and selected spectator match snapshots', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
      channelId: 'channel-steam-link',
    })

    expect((await world.lobby.config('1v1', {
      hostId: 'p1',
      lobbyId: lobby.id,
      steamLobbyLink: 'steam://joinlobby/289070/123456789/987654321',
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    expect((await world.activity.targetLobby({
      channelId: lobby.channelId,
      userId: 'spectator',
      lobbyId: lobby.id,
    })).body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'lobby',
          option: { id: lobby.id },
        },
      },
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const participantInitialLaunch = await world.activity.launch({ channelId: lobby.channelId, userId: 'p1' })
    const spectatorInitialTarget = await world.activity.targetMatch({ channelId: lobby.channelId, userId: 'spectator', matchId: started.matchId })

    expect(participantInitialLaunch.body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: started.matchId,
        steamLobbyLink: 'steam://joinlobby/289070/123456789/987654321',
      },
    })
    expect(spectatorInitialTarget.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'match',
          matchId: started.matchId,
          steamLobbyLink: 'steam://joinlobby/289070/123456789/987654321',
        },
      },
    })

    expect((await world.lobby.config('1v1', {
      hostId: 'p2',
      lobbyId: lobby.id,
      steamLobbyLink: 'steam://joinlobby/289070/222222222/111111111',
    })).status).toBe(200)
    expect((await world.lobby.config('1v1', {
      hostId: 'spectator',
      lobbyId: lobby.id,
      steamLobbyLink: 'steam://joinlobby/289070/333333333/111111111',
    })).status).toBe(403)
    expect((await world.lobby.config('1v1', {
      hostId: 'p1',
      lobbyId: lobby.id,
      pickTimerSeconds: 45,
    })).status).toBe(409)
    await world.flushBackgroundTasks()

    const participantLaunch = await world.activity.launch({ channelId: lobby.channelId, userId: 'p1' })
    const spectatorTarget = await world.activity.targetMatch({ channelId: lobby.channelId, userId: 'spectator', matchId: started.matchId })

    expect(participantLaunch.body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: started.matchId,
        steamLobbyLink: 'steam://joinlobby/289070/222222222/111111111',
      },
    })
    expect(spectatorTarget.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'match',
          matchId: started.matchId,
          steamLobbyLink: 'steam://joinlobby/289070/222222222/111111111',
        },
      },
    })

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    expect((await world.lobby.config('1v1', {
      hostId: 'p2',
      lobbyId: lobby.id,
      steamLobbyLink: null,
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    const participantAfterClear = await world.activity.launch({ channelId: lobby.channelId, userId: 'p1' })
    const spectatorAfterClear = await world.activity.targetMatch({ channelId: lobby.channelId, userId: 'spectator', matchId: started.matchId })

    expect((await world.lobby.getById(lobby.id))?.status).toBe('active')
    expect((await world.lobby.getById(lobby.id))?.steamLobbyLink).toBeNull()
    expect(participantAfterClear.body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: started.matchId,
        steamLobbyLink: null,
      },
    })
    expect(spectatorAfterClear.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'match',
          matchId: started.matchId,
          steamLobbyLink: null,
        },
      },
    })
  })

  test('lobby message unsticks after a join-path update recreates the tracked message', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }],
    })
    const staleMessageId = lobby.messageId
    world.discord.failNextPatch(staleMessageId)

    const joinResponse = await world.lobby.place('1v1', {
      userId: 'p2',
      lobbyId: lobby.id,
      targetSlot: 1,
      displayName: 'p2',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(200)
    const reboundLobby = await world.lobby.getById(lobby.id)
    expect(reboundLobby).not.toBeNull()
    expect(reboundLobby?.messageId).not.toBe(staleMessageId)
    expect(world.discord.message(staleMessageId)).toBeNull()
    expect(world.discord.message(reboundLobby!.messageId)).not.toBeNull()
    expect(world.discord.requests().some(request => request.method === 'PATCH' && request.url.includes(staleMessageId))).toBe(true)
    expect(world.discord.requests().some(request => request.method === 'POST' && request.url.includes(`/channels/${lobby.channelId}/messages`))).toBe(true)

    const removeResponse = await world.lobby.remove('1v1', {
      userId: 'p2',
      lobbyId: lobby.id,
      slot: 1,
      displayName: 'p2',
    })
    await world.flushBackgroundTasks()
    expect(removeResponse.status).toBe(200)

    const rejoinResponse = await world.lobby.place('1v1', {
      userId: 'p2',
      lobbyId: lobby.id,
      targetSlot: 1,
      displayName: 'p2',
    })
    await world.flushBackgroundTasks()

    const finalLobby = await world.lobby.getById(lobby.id)
    expect(rejoinResponse.status).toBe(200)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', 'p2'])
    expect(finalLobby?.slots).toEqual(['host', 'p2'])
    expect(finalLobby?.messageId).toBe(reboundLobby?.messageId)
    expect(await world.discord.currentLobbyMessage(lobby.id)).toMatchObject({ id: reboundLobby?.messageId })
  })

  test('initial drafting embed update failure does not break the draft lifecycle', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })
    const staleMessageId = lobby.messageId
    world.discord.failNextPatch(staleMessageId)

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    const draftingLobby = await world.lobby.getById(lobby.id)
    expect(draftingLobby?.status).toBe('drafting')
    expect(draftingLobby?.messageId).not.toBe(staleMessageId)
    expect(world.discord.message(staleMessageId)).toBeNull()

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()
    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    expect((await world.match.get(started.matchId))?.status).toBe('completed')
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
  })

  test('draft-complete embed update failure does not break activation or report flows', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    world.discord.failNextPatch(lobby.messageId)

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const activeLobby = await world.lobby.getById(lobby.id)
    expect((await world.match.get(started.matchId))?.status).toBe('active')
    expect(activeLobby?.status).toBe('active')
    expect(activeLobby?.messageId).not.toBe(lobby.messageId)
    expect(world.discord.message(activeLobby!.messageId)).not.toBeNull()

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    expect((await world.match.get(started.matchId))?.status).toBe('completed')
    expect((await world.match.getMessageIds(started.matchId)).length).toBeGreaterThanOrEqual(2)
  })

  test('cancelled embed update failure does not leave stale live mappings behind', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    world.discord.failNextPatch(lobby.messageId)

    expect((await world.party.cancelDraft(started.matchId, { reason: 'scrub' })).status).toBe(200)
    await world.flushBackgroundTasks()

    expect(await world.lobby.getById(lobby.id)).toBeNull()
    expect(await world.inspect.lobbyByMatch(started.matchId)).toBeNull()
    expect(await world.inspect.lobbyMapping('p1')).toBeNull()
    expect(await world.inspect.lobbyMapping('p2')).toBeNull()
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect((await world.match.get(started.matchId))?.status).toBe('cancelled')
  })

  test('archive message failure during report does not reopen or corrupt a completed match', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()
    world.discord.failNextPost('channel-archive')

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    expect((await world.match.get(started.matchId))?.status).toBe('completed')
    expect(await world.lobby.getById(lobby.id)).toBeNull()
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect(await world.match.getMessageIds(started.matchId)).toHaveLength(2)
    expect(world.discord.messages().filter(message => message.channelId === 'channel-archive')).toHaveLength(1)
  })

  test('moving from one open lobby to another uses the real join path and keeps mappings coherent', async () => {
    const world = await createTrackedWorld()
    const sourceLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'source-host' }, { id: 'guest' }],
    })
    const targetLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'target-host' }],
      hostId: 'target-host',
      channelId: 'channel-target',
    })

    const joinResponse = await world.lobby.place('1v1', {
      userId: 'guest',
      lobbyId: targetLobby.id,
      targetSlot: 1,
      displayName: 'guest',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(200)
    expect(joinResponse.body).toMatchObject({ transferNotice: 'Moved you from your previous 1v1 lobby.' })
    expect((await world.lobby.getById(sourceLobby.id))?.memberPlayerIds).toEqual(['source-host'])
    expect((await world.lobby.getById(sourceLobby.id))?.slots).toEqual(['source-host', null])
    expect((await world.lobby.getById(targetLobby.id))?.memberPlayerIds).toEqual(['target-host', 'guest'])
    expect((await world.lobby.getById(targetLobby.id))?.slots).toEqual(['target-host', 'guest'])
    expect(await world.inspect.lobbyMapping('guest')).toBe(targetLobby.id)
    expect(await world.inspect.lobbiesForPlayer('guest')).toEqual([
      expect.objectContaining({ id: targetLobby.id, status: 'open' }),
    ])
    expect((await world.activity.launch({ channelId: targetLobby.channelId, userId: 'guest' })).body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: targetLobby.id,
          isMember: true,
        },
      },
    })
  })

  test('host cannot abandon players in another populated open lobby through the real join path', async () => {
    const world = await createTrackedWorld()
    const sourceLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'guest' }, { id: 'ally' }],
      hostId: 'guest',
    })
    const targetLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'target-host' }],
      hostId: 'target-host',
      channelId: 'channel-target',
    })

    const beforeRequests = world.discord.requests().length
    const joinResponse = await world.lobby.place('1v1', {
      userId: 'guest',
      lobbyId: targetLobby.id,
      targetSlot: 1,
      displayName: 'guest',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(400)
    expect(joinResponse.body).toEqual({
      error: 'You are hosting another open lobby with other players. Cancel it first.',
    })
    expect((await world.lobby.getById(sourceLobby.id))?.memberPlayerIds).toEqual(['guest', 'ally'])
    expect((await world.lobby.getById(sourceLobby.id))?.slots).toEqual(['guest', 'ally'])
    expect((await world.lobby.getById(targetLobby.id))?.memberPlayerIds).toEqual(['target-host'])
    expect((await world.lobby.getById(targetLobby.id))?.slots).toEqual(['target-host', null])
    expect(await world.inspect.lobbiesForPlayer('guest')).toEqual([
      expect.objectContaining({ id: sourceLobby.id, status: 'open' }),
    ])
    expect(world.discord.requests()).toHaveLength(beforeRequests)
  })

  test('direct joins fill canonical open-lobby membership across 1v1, team, and FFA modes', async () => {
    const oneVOneWorld = await createTrackedWorld()
    const oneVOneLobby = await oneVOneWorld.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'duel-host' }],
      hostId: 'duel-host',
      channelId: 'channel-direct-1v1',
    })

    expect((await oneVOneWorld.lobby.place('1v1', {
      userId: 'duel-join',
      lobbyId: oneVOneLobby.id,
      targetSlot: 1,
      displayName: 'duel-join',
    })).status).toBe(200)
    await oneVOneWorld.flushBackgroundTasks()

    expect((await oneVOneWorld.lobby.getById(oneVOneLobby.id))?.memberPlayerIds).toEqual(['duel-host', 'duel-join'])
    expect((await oneVOneWorld.lobby.getById(oneVOneLobby.id))?.slots).toEqual(['duel-host', 'duel-join'])
    await expectQueuePlayers(oneVOneWorld, '1v1', ['duel-host', 'duel-join'])
    expect((await oneVOneWorld.activity.launch({ channelId: oneVOneLobby.channelId, userId: 'duel-join' })).body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: { id: oneVOneLobby.id, isMember: true },
      },
    })

    const teamWorld = await createTrackedWorld()
    const teamLobby = await teamWorld.lobby.createOpen({
      mode: '2v2',
      players: [{ id: 'team-host' }],
      hostId: 'team-host',
      channelId: 'channel-direct-team',
    })

    for (const [userId, targetSlot] of [['team-2', 1], ['team-3', 2], ['team-4', 3]] as const) {
      expect((await teamWorld.lobby.place('2v2', {
        userId,
        lobbyId: teamLobby.id,
        targetSlot,
        displayName: userId,
      })).status).toBe(200)
    }
    await teamWorld.flushBackgroundTasks()

    expect((await teamWorld.lobby.getById(teamLobby.id))?.memberPlayerIds).toEqual(['team-host', 'team-2', 'team-3', 'team-4'])
    expect((await teamWorld.lobby.getById(teamLobby.id))?.slots).toEqual(['team-host', 'team-2', 'team-3', 'team-4'])
    await expectQueuePlayers(teamWorld, '2v2', ['team-host', 'team-2', 'team-3', 'team-4'])
    expect((await teamWorld.activity.launch({ channelId: teamLobby.channelId, userId: 'team-4' })).body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: { id: teamLobby.id, isMember: true },
      },
    })

    const ffaWorld = await createTrackedWorld()
    const ffaLobby = await ffaWorld.lobby.createOpen({
      mode: 'ffa',
      players: [{ id: 'ffa-host' }],
      hostId: 'ffa-host',
      channelId: 'channel-direct-ffa',
    })

    for (const [userId, targetSlot] of [['ffa-2', 4], ['ffa-3', 1], ['ffa-4', 7]] as const) {
      expect((await ffaWorld.lobby.place('ffa', {
        userId,
        lobbyId: ffaLobby.id,
        targetSlot,
        displayName: userId,
      })).status).toBe(200)
    }
    await ffaWorld.flushBackgroundTasks()

    expect((await ffaWorld.lobby.getById(ffaLobby.id))?.memberPlayerIds).toEqual(['ffa-host', 'ffa-2', 'ffa-3', 'ffa-4'])
    expect((await ffaWorld.lobby.getById(ffaLobby.id))?.slots).toEqual(['ffa-host', 'ffa-3', null, null, 'ffa-2', null, null, 'ffa-4'])
    await expectQueuePlayers(ffaWorld, 'ffa', ['ffa-host', 'ffa-2', 'ffa-3', 'ffa-4'])
    expect((await ffaWorld.activity.launch({ channelId: ffaLobby.channelId, userId: 'ffa-4' })).body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: { id: ffaLobby.id, isMember: true },
      },
    })
  })

  test('remove self then rejoin keeps lobby and activity state coherent', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }],
    })

    expect((await world.lobby.place('1v1', {
      userId: 'guest',
      lobbyId: lobby.id,
      targetSlot: 1,
      displayName: 'guest',
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    expect(await world.inspect.lobbyMapping('guest')).toBe(lobby.id)
    expect((await world.activity.launch({ channelId: lobby.channelId, userId: 'guest' })).body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: { id: lobby.id, isMember: true },
      },
    })

    const removeResponse = await world.lobby.remove('1v1', {
      userId: 'guest',
      lobbyId: lobby.id,
      slot: 1,
      displayName: 'guest',
    })
    await world.flushBackgroundTasks()

    expect(removeResponse.status).toBe(200)
    await expectQueuePlayers(world, '1v1', ['host'])
    expect((await world.lobby.getById(lobby.id))?.memberPlayerIds).toEqual(['host'])
    expect(await world.inspect.lobbyMapping('guest')).toBeNull()
    expect((await world.activity.launch({ channelId: lobby.channelId, userId: 'guest' })).body).toMatchObject({
      selection: null,
      options: expect.arrayContaining([
        expect.objectContaining({ id: lobby.id, kind: 'lobby' }),
      ]),
    })

    const rejoinResponse = await world.lobby.place('1v1', {
      userId: 'guest',
      lobbyId: lobby.id,
      targetSlot: 1,
      displayName: 'guest',
    })
    await world.flushBackgroundTasks()

    expect(rejoinResponse.status).toBe(200)
    await expectQueuePlayers(world, '1v1', ['host', 'guest'])
    expect((await world.lobby.getById(lobby.id))?.memberPlayerIds).toEqual(['host', 'guest'])
    expect((await world.lobby.getById(lobby.id))?.slots).toEqual(['host', 'guest'])
    expect(await world.inspect.lobbyMapping('guest')).toBe(lobby.id)
    expect((await world.activity.launch({ channelId: lobby.channelId, userId: 'guest' })).body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: { id: lobby.id, isMember: true },
      },
    })
  })

  test('duplicate join requests settle to one coherent member and embed state', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }],
    })

    const [firstJoin, secondJoin] = await Promise.all([
      world.lobby.place('1v1', {
        userId: 'p2',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'p2',
      }),
      world.lobby.place('1v1', {
        userId: 'p2',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'p2',
      }),
    ])
    await world.flushBackgroundTasks()

    const finalLobby = await world.lobby.getById(lobby.id)
    const message = await world.discord.currentLobbyMessage(lobby.id)

    expect(firstJoin.status).toBe(200)
    expect(secondJoin.status).toBe(200)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', 'p2'])
    expect(finalLobby?.slots).toEqual(['host', 'p2'])
    await expectQueuePlayers(world, '1v1', ['host', 'p2'])
    expect(await world.inspect.lobbyMapping('p2')).toBe(lobby.id)
    expect(JSON.stringify(message?.payload)).toContain('<@p2>')
  })

  test('concurrent joins for the last slot settle to one winner without leaving stale lobby or embed state', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }],
    })

    const joinResults = await Promise.all([
      world.lobby.place('1v1', {
        userId: 'p2',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'p2',
      }),
      world.lobby.place('1v1', {
        userId: 'p3',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'p3',
      }),
    ])
    await world.flushBackgroundTasks()

    const finalLobby = await world.lobby.getById(lobby.id)
    const winner = finalLobby?.slots[1] ?? null
    const loser = winner === 'p2' ? 'p3' : 'p2'
    const message = await world.discord.currentLobbyMessage(lobby.id)
    const payloadText = JSON.stringify(message?.payload)

    expect(joinResults.map(result => result.status).every(status => status < 500)).toBe(true)
    expect(winner === 'p2' || winner === 'p3').toBe(true)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', winner!])
    expect(finalLobby?.slots).toEqual(['host', winner!])
    await expectQueuePlayers(world, '1v1', ['host', winner!])
    expect(await world.inspect.lobbyMapping(winner!)).toBe(lobby.id)
    expect(await world.inspect.lobbyMapping(loser)).toBeNull()
    expect(payloadText).toContain(`<@${winner}>`)
    expect(payloadText).not.toContain(`<@${loser}>`)
  })

  test('mode changes preserve host order, team splits, and canonical compact rosters', async () => {
    const hostOrderWorld = await createTrackedWorld()
    const hostOrderLobby = await hostOrderWorld.lobby.createOpen({
      mode: '4v4',
      players: [{ id: 'host' }, { id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p5' }, { id: 'p6' }],
      hostId: 'host',
      slots: ['p1', 'p2', 'p3', 'host', 'p5', 'p6', null, null],
      channelId: 'channel-mode-host-order',
    })

    expect((await hostOrderWorld.lobby.changeMode('4v4', {
      hostId: 'host',
      lobbyId: hostOrderLobby.id,
      nextMode: '3v3',
    })).status).toBe(200)
    await hostOrderWorld.flushBackgroundTasks()

    expect((await hostOrderWorld.lobby.getById(hostOrderLobby.id))?.mode).toBe('3v3')
    expect((await hostOrderWorld.lobby.getById(hostOrderLobby.id))?.slots).toEqual(['p1', 'p2', 'p3', 'host', 'p5', 'p6'])
    await expectQueuePlayers(hostOrderWorld, '4v4', [])
    await expectQueuePlayers(hostOrderWorld, '3v3', ['host', 'p1', 'p2', 'p3', 'p5', 'p6'])

    const expandWorld = await createTrackedWorld()
    const expandLobby = await expandWorld.lobby.createOpen({
      mode: '3v3',
      players: createPlayers(6),
      hostId: 'p1',
      slots: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      channelId: 'channel-mode-expand',
    })

    expect((await expandWorld.lobby.changeMode('3v3', {
      hostId: 'p1',
      lobbyId: expandLobby.id,
      nextMode: '4v4',
    })).status).toBe(200)
    await expandWorld.flushBackgroundTasks()

    expect((await expandWorld.lobby.getById(expandLobby.id))?.mode).toBe('4v4')
    expect((await expandWorld.lobby.getById(expandLobby.id))?.slots).toEqual(['p1', 'p2', 'p3', null, 'p4', 'p5', 'p6', null])
    await expectQueuePlayers(expandWorld, '3v3', [])
    await expectQueuePlayers(expandWorld, '4v4', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])

    const compactWorld = await createTrackedWorld()
    const compactLobby = await compactWorld.lobby.createOpen({
      mode: '3v3',
      players: createPlayers(6),
      hostId: 'p1',
      memberPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
      slots: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      channelId: 'channel-mode-compact',
    })

    expect((await compactWorld.lobby.changeMode('3v3', {
      hostId: 'p1',
      lobbyId: compactLobby.id,
      nextMode: '2v2',
    })).status).toBe(200)
    await compactWorld.flushBackgroundTasks()

    expect((await compactWorld.lobby.getById(compactLobby.id))?.mode).toBe('2v2')
    expect((await compactWorld.lobby.getById(compactLobby.id))?.memberPlayerIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect((await compactWorld.lobby.getById(compactLobby.id))?.slots.filter((playerId): playerId is string => playerId != null)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect((await compactWorld.lobby.getById(compactLobby.id))?.slots).not.toContain('p6')
    await expectQueuePlayers(compactWorld, '3v3', [])
    await expectQueuePlayers(compactWorld, '2v2', ['p1', 'p2', 'p3', 'p4', 'p5'])
  })

  test('mode changes preserve Red Death settings and normalize unsupported toggles on the destination mode', async () => {
    const redDeathWorld = await createTrackedWorld()
    const redDeathLobby = await redDeathWorld.lobby.createOpen({
      mode: '2v2',
      players: [{ id: 'host' }],
      hostId: 'host',
      channelId: 'channel-mode-red-death',
    })

    expect((await redDeathWorld.lobby.config('2v2', {
      hostId: 'host',
      lobbyId: redDeathLobby.id,
      redDeath: true,
      dealOptionsSize: 4,
      randomDraft: true,
      duplicateFactions: false,
    })).status).toBe(200)
    expect((await redDeathWorld.lobby.changeMode('2v2', {
      hostId: 'host',
      lobbyId: redDeathLobby.id,
      nextMode: '1v1',
    })).status).toBe(200)
    await redDeathWorld.flushBackgroundTasks()

    expect((await redDeathWorld.lobby.getById(redDeathLobby.id))?.draftConfig).toMatchObject({
      redDeath: true,
      randomDraft: true,
      duplicateFactions: false,
    })

    const duplicateWorld = await createTrackedWorld()
    const duplicateLobby = await duplicateWorld.lobby.createOpen({
      mode: '5v5',
      players: [{ id: 'host' }],
      hostId: 'host',
      channelId: 'channel-mode-duplicate',
    })

    expect((await duplicateWorld.lobby.config('5v5', {
      hostId: 'host',
      lobbyId: duplicateLobby.id,
      redDeath: true,
      dealOptionsSize: 4,
      duplicateFactions: false,
    })).status).toBe(200)
    expect((await duplicateWorld.lobby.changeMode('5v5', {
      hostId: 'host',
      lobbyId: duplicateLobby.id,
      nextMode: '6v6',
    })).status).toBe(200)
    await duplicateWorld.flushBackgroundTasks()

    expect((await duplicateWorld.lobby.getById(duplicateLobby.id))?.draftConfig).toMatchObject({
      redDeath: true,
      duplicateFactions: true,
    })

    const simultaneousWorld = await createTrackedWorld()
    const simultaneousLobby = await simultaneousWorld.lobby.createOpen({
      mode: 'ffa',
      players: [{ id: 'host' }],
      hostId: 'host',
      channelId: 'channel-mode-simultaneous',
    })

    expect((await simultaneousWorld.lobby.config('ffa', {
      hostId: 'host',
      lobbyId: simultaneousLobby.id,
      simultaneousPick: true,
    })).status).toBe(200)
    expect((await simultaneousWorld.lobby.changeMode('ffa', {
      hostId: 'host',
      lobbyId: simultaneousLobby.id,
      nextMode: '1v1',
    })).status).toBe(200)
    await simultaneousWorld.flushBackgroundTasks()

    expect((await simultaneousWorld.lobby.getById(simultaneousLobby.id))?.draftConfig.simultaneousPick).toBe(false)

    const blindBansWorld = await createTrackedWorld()
    const blindBansLobby = await blindBansWorld.lobby.createOpen({
      mode: '3v3',
      players: [{ id: 'host' }],
      hostId: 'host',
      channelId: 'channel-mode-blind-bans',
    })

    expect((await blindBansWorld.lobby.config('3v3', {
      hostId: 'host',
      lobbyId: blindBansLobby.id,
      blindBans: false,
    })).status).toBe(200)
    expect((await blindBansWorld.lobby.changeMode('3v3', {
      hostId: 'host',
      lobbyId: blindBansLobby.id,
      nextMode: 'ffa',
    })).status).toBe(200)
    await blindBansWorld.flushBackgroundTasks()

    expect((await blindBansWorld.lobby.getById(blindBansLobby.id))?.draftConfig.blindBans).toBe(true)
  })

  test('arrange keeps canonical membership coherent when slot order changes', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '2v2',
      players: [
        { id: 'p1', displayName: 'Alpha' },
        { id: 'p2', displayName: 'Bravo' },
        { id: 'p3', displayName: 'Charlie' },
        { id: 'p4', displayName: 'Delta' },
      ],
      hostId: 'p1',
      slots: ['p1', 'p3', 'p2', 'p4'],
      channelId: 'channel-arrange-diverged',
    })

    const originalRandom = Math.random
    let arrangeResponse: Awaited<ReturnType<typeof world.lobby.arrange>>
    try {
      Math.random = () => 0
      arrangeResponse = await world.lobby.arrange('2v2', {
        hostId: 'p1',
        lobbyId: lobby.id,
        strategy: 'shuffle-teams',
      })
    }
    finally {
      Math.random = originalRandom
    }
    await world.flushBackgroundTasks()

    const arrangedLobby = await world.lobby.getById(lobby.id)
    const arrangedSlots = arrangedLobby?.slots ?? []
    const launch = await world.activity.launch({ channelId: lobby.channelId, userId: 'p3' })

    expect(arrangeResponse.status).toBe(200)
    expect(arrangedLobby?.memberPlayerIds).toEqual(['p1', 'p2', 'p3', 'p4'])
    await expectQueuePlayers(world, '2v2', ['p1', 'p2', 'p3', 'p4'])
    expect(arrangedLobby?.lastArrange).toMatchObject({ strategy: 'shuffle-teams' })
    expect(arrangedSlots).not.toEqual(['p1', 'p3', 'p2', 'p4'])
    expect(new Set(arrangedSlots.filter((playerId): playerId is string => playerId != null))).toEqual(new Set(['p1', 'p2', 'p3', 'p4']))
    expect(launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: lobby.id,
          isMember: true,
        },
      },
    })
  })

  test('deterministic arrange uses seeded runtime controls and preserves selectable lobby options', async () => {
    const first = await runSeededArrangeScenario('arrange-deterministic-a', 'channel-arrange-deterministic-a')
    const second = await runSeededArrangeScenario('arrange-deterministic-a', 'channel-arrange-deterministic-b')
    const third = await runSeededArrangeScenario('arrange-deterministic-b', 'channel-arrange-deterministic-c')

    expect(first.arranged.status).toBe(200)
    expect(second.arranged.status).toBe(200)
    expect(third.arranged.status).toBe(200)
    expect(first.selectedTarget.body).toMatchObject({
      snapshot: {
        selection: {
          kind: 'lobby',
          option: { id: first.lobby.id },
        },
      },
    })
    expect(first.arrangedLobby?.lastArrange).toEqual({ strategy: 'shuffle-teams', at: 1_700_000_005_000 })
    expect(first.arrangedLobby?.slots).toEqual(second.arrangedLobby?.slots)
    expect(first.arrangedLobby?.slots).not.toEqual(third.arrangedLobby?.slots)
    expect(first.launch.body).toMatchObject({
      selection: {
        kind: 'lobby',
        option: {
          id: first.lobby.id,
          isMember: false,
        },
      },
      options: expect.arrayContaining([
        expect.objectContaining({ id: first.lobby.id, kind: 'lobby' }),
      ]),
    })
  })

  test('join racing with host start leaves a clean drafting match state instead of reviving lobby membership', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }, { id: 'p2' }],
    })

    const [started, duplicateJoin] = await Promise.all([
      world.lobby.start('1v1', { hostId: 'host', lobbyId: lobby.id }),
      world.lobby.place('1v1', {
        userId: 'p2',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'p2',
      }),
    ])
    await world.flushBackgroundTasks()

    const finalLobby = await world.lobby.getById(lobby.id)
    expect(duplicateJoin.status).toBe(200)
    expect(finalLobby?.status).toBe('drafting')
    expect(finalLobby?.matchId).toBe(started.matchId)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', 'p2'])
    await expectQueuePlayers(world, '1v1', [])
    expect(await world.inspect.lobbyMapping('p2')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBe(started.matchId)
    expect((await world.activity.launch({ channelId: lobby.channelId, userId: 'p2' })).body).toMatchObject({
      selection: {
        kind: 'match',
        matchId: started.matchId,
      },
    })
  })

  test('report racing with a late join rejects the join cleanly and still allows a fresh later join', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)

    const [reportResult, lateJoin] = await Promise.all([
      world.match.report(started.matchId, {
        reporterId: 'p1',
        placements: 'A',
      }),
      world.lobby.place('1v1', {
        userId: 'p3',
        lobbyId: lobby.id,
        targetSlot: 1,
        displayName: 'p3',
      }),
    ])
    await world.flushBackgroundTasks()

    expect(reportResult.ok).toBe(true)
    expect(lateJoin.status).toBe(404)
    expect(lateJoin.body).toEqual({ error: 'No open lobby for this mode' })
    expect(await world.lobby.getById(lobby.id)).toBeNull()
    expect(await world.inspect.lobbyMapping('p3')).toBeNull()

    const freshLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'fresh-host' }],
      hostId: 'fresh-host',
    })

    const freshJoin = await world.lobby.place('1v1', {
      userId: 'p3',
      lobbyId: freshLobby.id,
      targetSlot: 1,
      displayName: 'p3',
    })
    await world.flushBackgroundTasks()

    expect(freshJoin.status).toBe(200)
    expect((await world.lobby.getById(freshLobby.id))?.memberPlayerIds).toEqual(['fresh-host', 'p3'])
    expect(await world.inspect.lobbyMapping('p3')).toBe(freshLobby.id)
  })

  test('out-of-order completion then cancellation is ignored without disturbing the active match', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const requestsBeforeCancel = world.discord.requests().length
    const messageBeforeCancel = await world.discord.currentLobbyMessage(lobby.id)

    const staleCancel = await world.party.cancelDraft(started.matchId, { reason: 'scrub' })
    await world.flushBackgroundTasks()

    expect(staleCancel.status).toBe(200)
    await expect(staleCancel.json()).resolves.toEqual({ ok: true, ignored: true })
    expect((await world.match.get(started.matchId))?.status).toBe('active')
    expect((await world.lobby.getById(lobby.id))?.status).toBe('active')
    expect(await world.discord.currentLobbyMessage(lobby.id)).toMatchObject({ id: messageBeforeCancel?.id })
    expect(world.discord.requests()).toHaveLength(requestsBeforeCancel)
  })

  test('out-of-order cancellation then completion is ignored without reviving the cancelled match', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1' })
    await world.flushBackgroundTasks()
    expect((await world.party.timeoutDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const reopenedLobby = await world.lobby.get('1v1')
    const openPlayersBeforeReplay = reopenedLobby?.memberPlayerIds ?? []
    const requestsBeforeReplay = world.discord.requests().length

    const staleComplete = await world.party.completeDraft(started.matchId)
    await world.flushBackgroundTasks()

    expect(staleComplete.status).toBe(200)
    await expect(staleComplete.json()).resolves.toEqual({ ok: true, ignored: true })
    expect((await world.match.get(started.matchId))?.status).toBe('cancelled')
    expect((await world.lobby.getById(reopenedLobby!.id))?.status).toBe('open')
    await expectQueuePlayers(world, '1v1', openPlayersBeforeReplay)
    expect(world.discord.requests()).toHaveLength(requestsBeforeReplay)
  })

  test('delayed lifecycle sync after report cleanup is ignored safely', async () => {
    const world = await createTrackedWorld()
    const result = await runReportedLifecycle(world, {
      mode: '1v1',
      players: createPlayers(2),
    })

    const requestsBeforeReplay = world.discord.requests().length
    const messageIdsBeforeReplay = await world.match.getMessageIds(result.matchId)

    const delayedComplete = await world.party.replayDraftComplete(result.matchId)
    const delayedCancel = await world.party.cancelDraft(result.matchId, { reason: 'scrub' })
    await world.flushBackgroundTasks()

    expect(delayedComplete.status).toBe(200)
    await expect(delayedComplete.json()).resolves.toEqual({ ok: true, ignored: true })
    expect(delayedCancel.status).toBe(200)
    await expect(delayedCancel.json()).resolves.toEqual({ ok: true, ignored: true })
    expect((await world.match.get(result.matchId))?.status).toBe('completed')
    expect(await world.lobby.getById(result.lobby.id)).toBeNull()
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect(await world.match.getMessageIds(result.matchId)).toEqual(messageIdsBeforeReplay)
    expect(world.discord.requests()).toHaveLength(requestsBeforeReplay)
  })

  test('blind-ban 1v1 lifecycle keeps the default blind format through completion and report', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: createPlayers(2, 'blind'),
    })
    const started = await world.lobby.start('1v1', { hostId: 'blind1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const activeMatch = await world.match.get(started.matchId)
    const activeParticipants = await world.match.getParticipants(started.matchId)
    const bans = await world.match.getBans(started.matchId)
    const draftState = parseDraftData(activeMatch)?.state as {
      formatId?: string
      steps?: Array<{ action?: string, seats?: 'all' | number[], count?: number }>
      bans?: Array<{ stepIndex?: number }>
    } | null
    const bansByPlayer = new Map<string, number>()
    for (const ban of bans) {
      bansByPlayer.set(ban.bannedBy, (bansByPlayer.get(ban.bannedBy) ?? 0) + 1)
    }

    expect(findDraftRuntimeConfig(world, started.matchId)?.formatId).toBe('default-1v1')
    expect(draftState?.formatId).toBe('default-1v1')
    expect(activeParticipants.every(participant => participant.civId != null)).toBe(true)
    expect(bans).toHaveLength(6)
    expect(bansByPlayer).toEqual(new Map([['blind1', 3], ['blind2', 3]]))
    expect(draftState?.steps?.[0]).toMatchObject({ action: 'ban', seats: 'all', count: 3 })
    expect(new Set((draftState?.bans ?? []).map(ban => ban.stepIndex))).toEqual(new Set([0]))

    expect((await world.match.report(started.matchId, {
      reporterId: 'blind1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    expect((await world.match.get(started.matchId))?.status).toBe('completed')
  })

  test('visible-ban 1v1 lifecycle uses the visible-ban format through completion and report', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: createPlayers(2, 'visible'),
    })
    expect((await world.lobby.config('1v1', {
      hostId: 'visible1',
      lobbyId: lobby.id,
      blindBans: false,
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    const started = await world.lobby.start('1v1', { hostId: 'visible1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const activeMatch = await world.match.get(started.matchId)
    const activeParticipants = await world.match.getParticipants(started.matchId)
    const bans = await world.match.getBans(started.matchId)
    const draftState = parseDraftData(activeMatch)?.state as {
      formatId?: string
      steps?: Array<{ action?: string, seats?: 'all' | number[], count?: number }>
      bans?: Array<{ stepIndex?: number }>
    } | null
    const bansByPlayer = new Map<string, number>()
    for (const ban of bans) {
      bansByPlayer.set(ban.bannedBy, (bansByPlayer.get(ban.bannedBy) ?? 0) + 1)
    }

    expect(findDraftRuntimeConfig(world, started.matchId)?.formatId).toBe('default-1v1-visible-bans')
    expect(draftState?.formatId).toBe('default-1v1-visible-bans')
    expect(activeParticipants.every(participant => participant.civId != null)).toBe(true)
    expect(bans).toHaveLength(6)
    expect(bansByPlayer).toEqual(new Map([['visible1', 3], ['visible2', 3]]))
    expect(draftState?.steps?.[0]).toMatchObject({ action: 'ban', seats: [0], count: 1 })
    expect(draftState?.steps?.[1]).toMatchObject({ action: 'ban', seats: [1], count: 1 })
    expect(new Set((draftState?.bans ?? []).map(ban => ban.stepIndex))).toEqual(new Set([0, 1, 2, 3, 4, 5]))

    expect((await world.match.report(started.matchId, {
      reporterId: 'visible1',
      placements: 'A',
    })).ok).toBe(true)
    await world.flushBackgroundTasks()

    expect((await world.match.get(started.matchId))?.status).toBe('completed')
  })
})

async function createTrackedWorld() {
  const world = await createSystemWorld()
  worlds.push(world)
  return world
}

function createPlayers(count: number, prefix = 'p') {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}` }))
}

function getTestSessionNamespace(world: Awaited<ReturnType<typeof createSystemWorld>>): TestSessionNamespace {
  return world.env.SessionDO as unknown as TestSessionNamespace
}

function draftSocketAttachment(id: string, sessionId: string, playerId: string) {
  return { id, sessionId, playerId, kind: 'draft', connectedAt: Date.now() }
}

function lastMessageOfType(messages: readonly unknown[], type: string): any | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === type) return message as any
  }
  return null
}

async function runSeededArrangeScenario(seed: string, channelId: string) {
  const world = await createTrackedWorld()
  const lobby = await world.lobby.createOpen({
    mode: '2v2',
    players: [
      { id: 'p1', displayName: 'Alpha' },
      { id: 'p2', displayName: 'Bravo' },
      { id: 'p3', displayName: 'Charlie' },
      { id: 'p4', displayName: 'Delta' },
    ],
    hostId: 'p1',
    slots: ['p1', 'p3', 'p2', 'p4'],
    channelId,
  })

  world.runtime.clock.freeze(1_700_000_000_000)
  const selectedTarget = await world.activity.targetLobby({ channelId: lobby.channelId, userId: 'spectator', lobbyId: lobby.id })

  world.runtime.clock.advance(5_000)
  world.runtime.random.seed(seed)

  const arranged = await world.lobby.arrange('2v2', {
    hostId: 'p1',
    lobbyId: lobby.id,
    strategy: 'shuffle-teams',
  })
  await world.flushBackgroundTasks()

  return {
    world,
    lobby,
    arranged,
    selectedTarget,
    arrangedLobby: await world.lobby.getById(lobby.id),
    launch: await world.activity.launch({ channelId: lobby.channelId, userId: 'spectator' }),
  }
}

async function runReportedLifecycle(
  world: Awaited<ReturnType<typeof createSystemWorld>>,
  input: {
    mode: GameMode
    players: Array<{ id: string }>
    config?: {
      simultaneousPick?: boolean
      redDeath?: boolean
      dealOptionsSize?: number
      randomDraft?: boolean
      duplicateFactions?: boolean
      mapVoteEnabled?: boolean
      targetSize?: number
    }
    completeDraftOptions?: Parameters<Awaited<ReturnType<typeof createSystemWorld>>['party']['completeDraft']>[1]
    placements?: string | ((participants: Awaited<ReturnType<typeof world.match.getParticipants>>) => string)
    reporterId?: string
  },
) {
  const hostId = input.players[0]!.id
  const lobby = await world.lobby.createOpen({
    mode: input.mode,
    players: input.players,
    hostId,
  })

  if (input.config) {
    const configResponse = await world.lobby.config(input.mode, {
      hostId,
      lobbyId: lobby.id,
      ...input.config,
    })
    expect(configResponse.status).toBe(200)
    await world.flushBackgroundTasks()
  }

  const started = await world.lobby.start(input.mode, { hostId, lobbyId: lobby.id })
  await world.flushBackgroundTasks()

  expect((await world.party.completeDraft(started.matchId, input.completeDraftOptions)).status).toBe(200)
  await world.flushBackgroundTasks()

  const activeMatch = await world.match.get(started.matchId)
  const activeParticipants = await world.match.getParticipants(started.matchId)
  expect(activeMatch?.status).toBe('active')

  const placements = typeof input.placements === 'function'
    ? input.placements(activeParticipants)
    : (input.placements ?? defaultPlacementsForMode(input.mode, activeParticipants))

  expect((await world.match.report(started.matchId, {
    reporterId: input.reporterId ?? hostId,
    placements,
  })).ok).toBe(true)
  await world.flushBackgroundTasks()

  const reportedMatch = await world.match.get(started.matchId)
  const reportedParticipants = await world.match.getParticipants(started.matchId)
  const messageIds = await world.match.getMessageIds(started.matchId)

  expect(reportedMatch?.status).toBe('completed')
  await expectQueuePlayers(world, input.mode, [])
  expect(messageIds.length).toBeGreaterThanOrEqual(2)
  expect(world.discord.requests().some(request => request.method === 'PATCH' && request.url.includes('/channels/'))).toBe(true)
  expect(world.discord.requests().some(request => request.method === 'POST' && request.url.includes('/channels/channel-archive/messages'))).toBe(true)

  return {
    lobby,
    matchId: started.matchId,
    activeMatch,
    activeParticipants,
    reportedMatch,
    reportedParticipants,
  }
}

function defaultPlacementsForMode(mode: GameMode, participants: Array<{ playerId: string, team?: number | null }>) {
  if (mode !== 'ffa') return 'A'
  return buildOrderedMentions(participants)
}

function buildOrderedMentions(participants: Array<{ playerId: string }>) {
  return participants.map(participant => `<@${participant.playerId}>`).join('\n')
}

function expectOrderedPlacements(participants: Array<{ playerId: string, placement: number | null }>, orderedIds: string[]) {
  const placements = new Map(participants.map(participant => [participant.playerId, participant.placement]))
  orderedIds.forEach((playerId, index) => {
    expect(placements.get(playerId)).toBe(index + 1)
  })
}

function expectAdjacentPairPlacements(participants: Array<{ playerId: string, placement: number | null }>, orderedIds: string[]) {
  const placements = new Map(participants.map(participant => [participant.playerId, participant.placement]))
  orderedIds.forEach((playerId, index) => {
    expect(placements.get(playerId)).toBe(Math.floor(index / 2) + 1)
  })
}

function expectTeamPlacements(participants: Array<{ team: number | null, placement: number | null }>, expectedByTeam: Map<number, number>) {
  for (const participant of participants) {
    expect(participant.team).not.toBeNull()
    expect(participant.placement).toBe(expectedByTeam.get(participant.team!))
  }
}

function groupParticipantsByTeam<T extends { team: number | null }>(participants: T[]) {
  const grouped = new Map<number, T[]>()
  for (const participant of participants) {
    if (participant.team == null) continue
    const teamParticipants = grouped.get(participant.team) ?? []
    teamParticipants.push(participant)
    grouped.set(participant.team, teamParticipants)
  }
  return grouped
}

function placementsByTeamIndex(participants: Array<{ team: number | null, placement: number | null }>) {
  return new Map(
    [...groupParticipantsByTeam(participants)].map(([team, teamParticipants]) => [team, teamParticipants[0]?.placement ?? null]),
  )
}

function parseDraftData(match: { draftData: string | null } | null) {
  return match?.draftData ? JSON.parse(match.draftData) as Record<string, any> : null
}

function findDraftRuntimeConfig(world: Awaited<ReturnType<typeof createSystemWorld>>, matchId: string) {
  return world.party.rooms().find(room => room.config.matchId === matchId)?.config ?? null
}

function payloadHasEmbedField(payload: Record<string, unknown>, name: string, value: string) {
  const embeds = payload.embeds
  if (!Array.isArray(embeds)) return false

  return embeds.some((embed) => {
    if (!embed || typeof embed !== 'object') return false
    const fields = (embed as { fields?: unknown }).fields
    if (!Array.isArray(fields)) return false

    return fields.some((field) => {
      if (!field || typeof field !== 'object') return false
      const candidate = field as { name?: unknown, value?: unknown }
      return candidate.name === name && candidate.value === value
    })
  })
}

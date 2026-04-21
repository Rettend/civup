import type { GameMode, ResolvedMapVoteResult } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { formatMapVoteResultLabel, swapSeatPicks } from '@civup/game'
import { getQueueState } from '../../src/services/queue/index.ts'
import { createSystemWorld } from './helpers/world.ts'

const worlds: Array<Awaited<ReturnType<typeof createSystemWorld>>> = []

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

afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

describe('system scenarios', () => {
  for (const { mode, playerCount } of CORE_MODE_CASES) {
    test(`core ${mode} lifecycle completes, reports, and archives cleanly`, async () => {
      const world = await createTrackedWorld()
      const result = await runReportedLifecycle(world, {
        mode,
        players: createPlayers(playerCount),
      })

      if (mode === 'ffa') {
        expectOrderedPlacements(result.reportedParticipants, result.activeParticipants.map(participant => participant.playerId))
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
    expect(findRoomConfig(simultaneousWorld, simultaneous.matchId)?.formatId).toBe('default-ffa-simultaneous')
    expect(parseDraftData(simultaneous.reportedMatch)?.state).toMatchObject({ formatId: 'default-ffa-simultaneous' })
    expectOrderedPlacements(simultaneous.reportedParticipants, [...simultaneous.activeParticipants].reverse().map(participant => participant.playerId))

    const redDeathWorld = await createTrackedWorld()
    const redDeath = await runReportedLifecycle(redDeathWorld, {
      mode: '3v3',
      players: createPlayers(6, 'rd'),
      config: { redDeath: true, dealOptionsSize: 3 },
    })
    const redDeathRoom = findRoomConfig(redDeathWorld, redDeath.matchId)
    expect(redDeathRoom?.dealOptionsSize).toBe(3)
    expect(parseDraftData(redDeath.reportedMatch)?.redDeath).toBe(true)
    expect(redDeath.reportedParticipants.every(participant => participant.civId != null)).toBe(true)

    const randomWorld = await createTrackedWorld()
    const randomDraft = await runReportedLifecycle(randomWorld, {
      mode: '1v1',
      players: createPlayers(2, 'rnd'),
      config: { randomDraft: true },
    })
    const randomRoom = findRoomConfig(randomWorld, randomDraft.matchId)
    expect(randomRoom?.randomDraft).toBe(true)
    expect(randomDraft.reportedParticipants.every(participant => participant.civId != null)).toBe(true)

    const duplicateWorld = await createTrackedWorld()
    const duplicate = await runReportedLifecycle(duplicateWorld, {
      mode: '1v1',
      players: createPlayers(2, 'dup'),
      config: { duplicateFactions: true },
    })
    const duplicateCivs = [...new Set(duplicate.reportedParticipants.map(participant => participant.civId))]
    expect(findRoomConfig(duplicateWorld, duplicate.matchId)?.duplicateFactions).toBe(true)
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

    expect(findRoomConfig(mapVoteWorld, mapVote.matchId)?.mapVoteEnabled).toBe(true)
    expect(parseDraftData(mapVote.reportedMatch)?.mapVoteResult).toEqual(MAP_VOTE_RESULT)
    expect(mapVotePayloads.some(payload => payloadHasEmbedField(payload, 'Map', formatMapVoteResultLabel(MAP_VOTE_RESULT.mapType, MAP_VOTE_RESULT.mapScript)))).toBe(true)
  })

  test('FFA ordered participant reporting respects the submitted real placement order', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: 'ffa',
      players: createPlayers(8, 'ffa-order'),
    })

    const started = await world.lobby.start('ffa', { hostId: 'ffa-order1', lobbyId: lobby.id })
    await world.flushBackgroundTasks()
    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const participants = await world.match.getParticipants(started.matchId)
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
      placements: participants => {
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

  test('completion replay is idempotent and finalized webhook can refresh active match civ assignments', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '2v2',
      players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    })

    const started = await world.lobby.start('2v2', { hostId: 'p1' })
    await world.flushBackgroundTasks()

    expect((await world.party.completeDraft(started.matchId)).status).toBe(200)
    const beforeFinalized = new Map((await world.match.getParticipants(started.matchId)).map(participant => [participant.playerId, participant.civId]))
    const firstPatchCount = countDiscordMessageUpdates(world, 'PATCH')

    expect((await world.party.replayDraftComplete(started.matchId)).status).toBe(200)
    const replayPatchCount = countDiscordMessageUpdates(world, 'PATCH')

    expect((await world.party.completeDraft(started.matchId, {
      finalized: true,
      transformState: (state) => {
        const swappedPicks = swapSeatPicks(state, 0, 2)
        if ('error' in swappedPicks) throw new Error(swappedPicks.error)
        return { ...state, picks: swappedPicks }
      },
    })).status).toBe(200)
    const finalizedPatchCount = countDiscordMessageUpdates(world, 'PATCH')
    const messageIds = await world.match.getMessageIds(started.matchId)
    const afterFinalized = new Map((await world.match.getParticipants(started.matchId)).map(participant => [participant.playerId, participant.civId]))

    expect(replayPatchCount).toBe(firstPatchCount)
    expect(finalizedPatchCount).toBe(firstPatchCount + 1)
    expect(messageIds).toEqual([expect.any(String)])
    expect((await world.match.get(started.matchId))?.status).toBe('active')
    expect(afterFinalized.get('p1')).toBe(beforeFinalized.get('p2'))
    expect(afterFinalized.get('p2')).toBe(beforeFinalized.get('p1'))
    expect(afterFinalized.get('p3')).toBe(beforeFinalized.get('p3'))
    expect(afterFinalized.get('p4')).toBe(beforeFinalized.get('p4'))
  })

  test('timeout draft reopens lobby and removes the timed out player', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1' })
    await world.flushBackgroundTasks()

    expect((await world.party.timeoutDraft(started.matchId)).status).toBe(200)

    const reopenedLobby = await world.lobby.get('1v1')
    const queue = await getQueueState(world.kv, '1v1')

    expect(reopenedLobby?.status).toBe('open')
    expect(reopenedLobby?.hostId).toBe('p2')
    expect(reopenedLobby?.memberPlayerIds).toEqual(['p2'])
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['p2'])
    expect((await world.match.get(started.matchId))?.status).toBe('cancelled')
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
    expect(await world.inspect.activityTarget(freshLobby.channelId, 'p1')).toMatchObject({ kind: 'lobby', id: freshLobby.id })
  })

  test('activity launch ignores stale open-lobby residue and still offers the real join target', async () => {
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
      memberPlayerIds: ['source-host', 'p1'],
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

  test('current-lobby route repairs a stale activity-lobby-user mapping to the real open lobby', async () => {
    const world = await createTrackedWorld()
    const realLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }, { id: 'p1' }],
      hostId: 'host',
      channelId: 'channel-real',
    })
    const staleLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'other-host' }],
      hostId: 'other-host',
      channelId: 'channel-stale',
    })

    await world.corrupt.activityLobbyUser('p1', staleLobby.id)

    const currentLobby = await world.activity.currentLobby({ userId: 'p1' })

    expect(currentLobby.status).toBe(200)
    expect(currentLobby.body).toMatchObject({ id: realLobby.id })
    expect(await world.inspect.lobbyMapping('p1')).toBe(realLobby.id)
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

    const messageIds = await world.match.getMessageIds(started.matchId)
    const reboundMessageId = messageIds.find(messageId => messageId !== staleMessageId) ?? null
    const reportRequests = world.discord.requests().slice(requestsBeforeReport)

    expect(world.discord.message(staleMessageId)).toBeNull()
    expect(reboundMessageId).not.toBeNull()
    expect(world.discord.message(reboundMessageId!)).not.toBeNull()
    expect(reportRequests.some(request => request.method === 'PATCH' && request.url.includes(staleMessageId))).toBe(true)
    expect(reportRequests.some(request => request.method === 'POST' && request.url.includes(`/channels/${lobby.channelId}/messages`))).toBe(true)
  })

  test('report cleanup clears live targeting but leaves message context usable for later sync', async () => {
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

    const messageIds = await world.match.getMessageIds(started.matchId)
    expect(messageIds.length).toBeGreaterThanOrEqual(2)
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBeNull()
    expect(await world.inspect.lobbyByMatch(started.matchId)).toBeNull()
    expect(await world.inspect.activityTarget(lobby.channelId, 'p1')).toBeNull()

    world.discord.deleteMessage(messageIds[0]!)

    expect((await world.match.report(started.matchId, {
      reporterId: 'p1',
      placements: 'A',
    })).ok).toBe(true)
    expect(await world.inspect.matchMapping('p1')).toBeNull()
    expect(await world.inspect.activityTarget(lobby.channelId, 'p1')).toBeNull()
    expect(world.discord.requests().some(request => request.method === 'PATCH' && request.url.includes(messageIds[1]!))).toBe(true)
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

  test('activity launch prefers the real current lobby over a stale target in the same channel', async () => {
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
          id: currentLobby.id,
          isMember: true,
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

  test('moving from one open lobby to another uses the real join path and keeps mappings coherent', async () => {
    const world = await createTrackedWorld()
    const sourceLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'source-host' }, { id: 'pleb' }],
    })
    const targetLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'target-host' }],
      hostId: 'target-host',
      channelId: 'channel-target',
    })

    const joinResponse = await world.lobby.place('1v1', {
      userId: 'pleb',
      lobbyId: targetLobby.id,
      targetSlot: 1,
      displayName: 'pleb',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(200)
    expect(joinResponse.body).toMatchObject({ transferNotice: 'Moved you from your previous 1v1 lobby.' })
    expect((await world.lobby.getById(sourceLobby.id))?.memberPlayerIds).toEqual(['source-host'])
    expect((await world.lobby.getById(sourceLobby.id))?.slots).toEqual(['source-host', null])
    expect((await world.lobby.getById(targetLobby.id))?.memberPlayerIds).toEqual(['target-host', 'pleb'])
    expect((await world.lobby.getById(targetLobby.id))?.slots).toEqual(['target-host', 'pleb'])
    expect(await world.inspect.lobbyMapping('pleb')).toBe(targetLobby.id)
    expect(await world.inspect.activityTarget(targetLobby.channelId, 'pleb')).toMatchObject({ kind: 'lobby', id: targetLobby.id })
    expect(await world.inspect.lobbiesForPlayer('pleb')).toEqual([
      expect.objectContaining({ id: targetLobby.id, status: 'open' }),
    ])
  })

  test('host cannot abandon players in another populated open lobby through the real join path', async () => {
    const world = await createTrackedWorld()
    const sourceLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'pleb' }, { id: 'ally' }],
      hostId: 'pleb',
    })
    const targetLobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'target-host' }],
      hostId: 'target-host',
      channelId: 'channel-target',
    })

    const beforeRequests = world.discord.requests().length
    const joinResponse = await world.lobby.place('1v1', {
      userId: 'pleb',
      lobbyId: targetLobby.id,
      targetSlot: 1,
      displayName: 'pleb',
    })
    await world.flushBackgroundTasks()

    expect(joinResponse.status).toBe(400)
    expect(joinResponse.body).toEqual({
      error: 'You are hosting another open lobby with other players. Cancel it first.',
    })
    expect((await world.lobby.getById(sourceLobby.id))?.memberPlayerIds).toEqual(['pleb', 'ally'])
    expect((await world.lobby.getById(sourceLobby.id))?.slots).toEqual(['pleb', 'ally'])
    expect((await world.lobby.getById(targetLobby.id))?.memberPlayerIds).toEqual(['target-host'])
    expect((await world.lobby.getById(targetLobby.id))?.slots).toEqual(['target-host', null])
    expect(await world.inspect.lobbiesForPlayer('pleb')).toEqual([
      expect.objectContaining({ id: sourceLobby.id, status: 'open' }),
    ])
    expect(world.discord.requests()).toHaveLength(beforeRequests)
  })

  test('remove self then rejoin keeps queue and activity state coherent', async () => {
    const world = await createTrackedWorld()
    const lobby = await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'host' }],
    })

    expect((await world.lobby.place('1v1', {
      userId: 'pleb',
      lobbyId: lobby.id,
      targetSlot: 1,
      displayName: 'pleb',
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    expect(await world.inspect.lobbyMapping('pleb')).toBe(lobby.id)
    expect(await world.inspect.activityTarget(lobby.channelId, 'pleb')).toMatchObject({ kind: 'lobby', id: lobby.id })

    const removeResponse = await world.lobby.remove('1v1', {
      userId: 'pleb',
      lobbyId: lobby.id,
      slot: 1,
      displayName: 'pleb',
    })
    await world.flushBackgroundTasks()

    expect(removeResponse.status).toBe(200)
    expect((await getQueueState(world.kv, '1v1')).entries.map(entry => entry.playerId)).toEqual(['host'])
    expect((await world.lobby.getById(lobby.id))?.memberPlayerIds).toEqual(['host'])
    expect(await world.inspect.lobbyMapping('pleb')).toBeNull()
    expect(await world.inspect.activityTarget(lobby.channelId, 'pleb')).toMatchObject({ kind: 'lobby', id: lobby.id })

    const rejoinResponse = await world.lobby.place('1v1', {
      userId: 'pleb',
      lobbyId: lobby.id,
      targetSlot: 1,
      displayName: 'pleb',
    })
    await world.flushBackgroundTasks()

    expect(rejoinResponse.status).toBe(200)
    expect((await getQueueState(world.kv, '1v1')).entries.map(entry => entry.playerId)).toEqual(['host', 'pleb'])
    expect((await world.lobby.getById(lobby.id))?.memberPlayerIds).toEqual(['host', 'pleb'])
    expect((await world.lobby.getById(lobby.id))?.slots).toEqual(['host', 'pleb'])
    expect(await world.inspect.lobbyMapping('pleb')).toBe(lobby.id)
    expect(await world.inspect.activityTarget(lobby.channelId, 'pleb')).toMatchObject({ kind: 'lobby', id: lobby.id })
  })

  test('duplicate join requests settle to one coherent member, queue, and embed state', async () => {
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
    const queue = await getQueueState(world.kv, '1v1')
    const message = await world.discord.currentLobbyMessage(lobby.id)

    expect(firstJoin.status).toBe(200)
    expect(secondJoin.status).toBe(200)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', 'p2'])
    expect(finalLobby?.slots).toEqual(['host', 'p2'])
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['host', 'p2'])
    expect(await world.inspect.lobbyMapping('p2')).toBe(lobby.id)
    expect(JSON.stringify(message?.payload)).toContain('<@p2>')
  })

  test('concurrent joins for the last slot settle to one winner without leaving stale queue or embed state', async () => {
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
    const queue = await getQueueState(world.kv, '1v1')
    const message = await world.discord.currentLobbyMessage(lobby.id)
    const payloadText = JSON.stringify(message?.payload)

    expect(joinResults.map(result => result.status).every(status => status < 500)).toBe(true)
    expect(winner === 'p2' || winner === 'p3').toBe(true)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', winner!])
    expect(finalLobby?.slots).toEqual(['host', winner!])
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['host', winner!])
    expect(await world.inspect.lobbyMapping(winner!)).toBe(lobby.id)
    expect(await world.inspect.lobbyMapping(loser)).toBeNull()
    expect(payloadText).toContain(`<@${winner}>`)
    expect(payloadText).not.toContain(`<@${loser}>`)
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
    const queue = await getQueueState(world.kv, '1v1')

    expect(duplicateJoin.status).toBe(200)
    expect(finalLobby?.status).toBe('drafting')
    expect(finalLobby?.matchId).toBe(started.matchId)
    expect(finalLobby?.memberPlayerIds).toEqual(['host', 'p2'])
    expect(queue.entries).toEqual([])
    expect(await world.inspect.lobbyMapping('p2')).toBeNull()
    expect(await world.inspect.matchMapping('p2')).toBe(started.matchId)
    expect(await world.inspect.activityTarget(lobby.channelId, 'p2')).toMatchObject({ kind: 'match', id: started.matchId })
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

  test('duplicate timeout webhook after a reopened lobby gains a new joiner does not strand players or rewrite the embed', async () => {
    const world = await createTrackedWorld()
    await world.lobby.createOpen({
      mode: '1v1',
      players: [{ id: 'p1' }, { id: 'p2' }],
    })

    const started = await world.lobby.start('1v1', { hostId: 'p1' })
    await world.flushBackgroundTasks()
    expect((await world.party.timeoutDraft(started.matchId)).status).toBe(200)

    const reopenedLobby = await world.lobby.get('1v1')
    expect(reopenedLobby?.memberPlayerIds).toEqual(['p2'])

    expect((await world.lobby.place('1v1', {
      userId: 'p3',
      lobbyId: reopenedLobby!.id,
      targetSlot: 0,
      displayName: 'p3',
    })).status).toBe(200)
    await world.flushBackgroundTasks()

    const requestCountBeforeReplay = world.discord.requests().length
    const messageBeforeReplay = await world.discord.currentLobbyMessage(reopenedLobby!.id)

    expect((await world.party.replayDraftCancel(started.matchId)).status).toBe(200)
    await world.flushBackgroundTasks()

    const finalLobby = await world.lobby.getById(reopenedLobby!.id)
    const queue = await getQueueState(world.kv, '1v1')
    const messageAfterReplay = await world.discord.currentLobbyMessage(reopenedLobby!.id)

    expect(finalLobby?.status).toBe('open')
    expect(finalLobby?.hostId).toBe('p2')
    expect(finalLobby?.memberPlayerIds).toEqual(['p2', 'p3'])
    expect(finalLobby?.slots).toEqual(['p3', 'p2'])
    expect(queue.entries.map(entry => entry.playerId)).toEqual(['p2', 'p3'])
    expect(await world.inspect.lobbyMapping('p2')).toBe(reopenedLobby?.id)
    expect(await world.inspect.lobbyMapping('p3')).toBe(reopenedLobby?.id)
    expect(world.discord.requests()).toHaveLength(requestCountBeforeReplay)
    expect(messageAfterReplay?.id).toBe(messageBeforeReplay?.id)
  })
})

async function createTrackedWorld() {
  const world = await createSystemWorld()
  worlds.push(world)
  return world
}

function countDiscordMessageUpdates(world: Awaited<ReturnType<typeof createSystemWorld>>, method: 'PATCH' | 'POST') {
  return world.discord.requests().filter(request => request.method === method && request.url.includes('/channels/')).length
}

function createPlayers(count: number, prefix = 'p') {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}` }))
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
  const queue = await getQueueState(world.kv, input.mode)
  const messageIds = await world.match.getMessageIds(started.matchId)

  expect(reportedMatch?.status).toBe('completed')
  expect(queue.entries).toEqual([])
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

function defaultPlacementsForMode(mode: GameMode, participants: Array<{ playerId: string }>) {
  return mode === 'ffa'
    ? buildOrderedMentions(participants)
    : 'A'
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

function findRoomConfig(world: Awaited<ReturnType<typeof createSystemWorld>>, matchId: string) {
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

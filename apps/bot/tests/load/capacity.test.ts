/* eslint-disable no-console */
import type { DraftInput, DraftSeat, DraftState, GameMode, QueueEntry } from '@civup/game'
import type { CapacityModel, OverageRatesPerMillion, UsageLimits } from './capacity/model.ts'
import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import {
  allLeaderIds,
  createDraft,
  GAME_MODES,
  getDefaultFormat,
  isDraftError,
  processDraftInput,
  slotToTeamIndex,
  toLeaderboardMode,
} from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import { resolveLobbyJoinEligibility } from '../../src/routes/activity.ts'
import { buildOpenLobbySnapshot } from '../../src/routes/lobby/snapshot.ts'
import {
  clearLobbyMappings,
  getUserActivityTarget,
  storeMatchMapping,
  storeUserActivityTarget,
  storeUserLobbyMappings,
  storeUserMatchMappings,
} from '../../src/services/activity/index.ts'
import { resolveDraftTimerConfig } from '../../src/services/config/index.ts'
import { markLeaderboardsDirty } from '../../src/services/leaderboard/message.ts'
import {
  attachLobbyMatch,
  clearLobbyById,
  createLobby,
  filterQueueEntriesForLobby,
  getLobbiesByMode,
  getLobby,
  getLobbyByMatch,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  setLobbySlots,
  setLobbyStatus,
} from '../../src/services/lobby/index.ts'
import { activateDraftMatch, createDraftMatch, reportMatch } from '../../src/services/match/index.ts'
import { storeMatchMessageMapping } from '../../src/services/match/message.ts'
import { addToQueue, clearQueue, getQueueState } from '../../src/services/queue/index.ts'
import { listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { startSeason, syncSeasonPeaksForPlayers } from '../../src/services/season/index.ts'
import { createStateStore } from '../../src/services/state/store.ts'
import { getSystemChannel, setSystemChannel } from '../../src/services/system/channels.ts'
import { installStateCoordinatorHarness } from '../helpers/state-coordinator-harness.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'
import {
  estimateOverageUsd,
  findMaxPlaysPerDay,
  findMaxPlaysPerDayForOverageBudget,
  findMetricBreakpoints,
} from './capacity/model.ts'

interface UsageSample {
  workersRequests: number
  d1RowsRead: number
  d1RowsWritten: number
  doSqliteRowsRead: number
  doSqliteRowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

interface SimulationResult {
  usage: UsageSample
  draftRoomIncomingMessages: number
}

interface CapacityScenario {
  id: string
  label: string
  mode: GameMode
  joinGroups: string[][]
}

interface ScenarioReport {
  mode: CapacityScenario
  model: CapacityModel
  draftRoomIncomingMessages: number
  freeCapacityPlaysPerDay: number
  paidIncludedCapacityPlaysPerDay: number
  paidTenDollarCapacityPlaysPerDay: number
  paidTenDollarOverageUsd: number
  freeBreakpoints: ReturnType<typeof findMetricBreakpoints>
  paidBreakpoints: ReturnType<typeof findMetricBreakpoints>
}

const CHANNEL_ID = 'channel-draft'
const GUILD_ID = 'guild-1'
const HOST_ID = 'p1'

const CAPACITY_SCENARIOS: CapacityScenario[] = [
  {
    id: 'duel-ranked',
    label: '1v1',
    mode: '1v1',
    joinGroups: [['p2']],
  },
  {
    id: 'teamers-2v2',
    label: '2v2',
    mode: '2v2',
    joinGroups: [['p2'], ['p3', 'p4']],
  },
  {
    id: 'teamers-3v3',
    label: '3v3',
    mode: '3v3',
    joinGroups: [['p2', 'p3'], ['p4', 'p5', 'p6']],
  },
  {
    id: 'ffa-eight-player',
    label: 'ffa8',
    mode: 'ffa',
    joinGroups: [['p2'], ['p3'], ['p4'], ['p5'], ['p6'], ['p7'], ['p8']],
  },
]

const DO_WEBSOCKET_BILLING_RATIO = 20
const DO_CREATE_ROOM_REQUESTS_PER_DRAFT = 1
const LOBBY_WATCH_SUBSCRIBE_MESSAGES_PER_CONNECTION = 2
const ESTIMATED_DO_GB_SECONDS_PER_REQUEST = 0.0025

const FREE_DAILY_LIMITS: UsageLimits = {
  workersRequests: 100_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  doSqliteRowsRead: 5_000_000,
  doSqliteRowsWritten: 100_000,
  kvReads: 100_000,
  kvWrites: 1_000,
  kvDeletes: 1_000,
  kvLists: 1_000,
  doRequests: 100_000,
  doDurationGbSeconds: 13_000,
}

const PAID_MONTHLY_LIMITS: UsageLimits = {
  workersRequests: 10_000_000,
  d1RowsRead: 25_000_000_000,
  d1RowsWritten: 50_000_000,
  doSqliteRowsRead: 25_000_000_000,
  doSqliteRowsWritten: 50_000_000,
  kvReads: 10_000_000,
  kvWrites: 1_000_000,
  kvDeletes: 1_000_000,
  kvLists: 1_000_000,
  doRequests: 1_000_000,
  doDurationGbSeconds: 400_000,
}

const PAID_OVERAGE_RATES_PER_MILLION: OverageRatesPerMillion = {
  workersRequests: 0.30,
  d1RowsRead: 0.001,
  d1RowsWritten: 1.0,
  doSqliteRowsRead: 0.001,
  doSqliteRowsWritten: 1.0,
  kvReads: 0.50,
  kvWrites: 5.0,
  kvDeletes: 5.0,
  kvLists: 5.0,
  doRequests: 0.15,
  doDurationGbSeconds: 12.5,
}

const PAID_BASE_MONTHLY_PRICE_USD = 5
const PAID_TARGET_MONTHLY_PRICE_USD = 10
const PAID_EXTRA_OVERAGE_BUDGET_USD = PAID_TARGET_MONTHLY_PRICE_USD - PAID_BASE_MONTHLY_PRICE_USD

const DAYS_PER_MONTH = 30
const SHOULD_PRINT_REPORT = Bun.env.CIVUP_CAPACITY_REPORT === '1'
const NOW = 1_700_000_000_000

describe('capacity models', () => {
  test('prints current ranked lifecycle capacity projections', async () => {
    const reports: ScenarioReport[] = []
    for (const mode of CAPACITY_SCENARIOS) {
      reports.push(await buildScenarioReport(mode))
    }

    if (SHOULD_PRINT_REPORT) printReports(reports)

    expect(reports).toHaveLength(CAPACITY_SCENARIOS.length)
    for (const report of reports) {
      expect(report.model.perDraft.workersRequests).toBeGreaterThan(0)
      expect(report.model.perDraft.d1RowsWritten).toBeGreaterThan(0)
      expect(report.freeCapacityPlaysPerDay).toBeGreaterThan(0)
      expect(report.paidIncludedCapacityPlaysPerDay).toBeGreaterThan(0)
      expect(report.paidTenDollarCapacityPlaysPerDay).toBeGreaterThanOrEqual(report.paidIncludedCapacityPlaysPerDay)
      expect(report.paidTenDollarOverageUsd).toBeLessThanOrEqual(PAID_EXTRA_OVERAGE_BUDGET_USD)
    }
  })
})

async function buildScenarioReport(mode: CapacityScenario): Promise<ScenarioReport> {
  const baseline = await simulateScenarioLifecycle({ mode, backgroundRatedPlayers: 0 })
  const withOneBackgroundPlayer = await simulateScenarioLifecycle({ mode, backgroundRatedPlayers: 1 })

  const model: CapacityModel = {
    perDraft: {
      workersRequests: baseline.usage.workersRequests,
      d1RowsReadBase: baseline.usage.d1RowsRead,
      d1RowsReadPerLeaderboardPlayer: withOneBackgroundPlayer.usage.d1RowsRead - baseline.usage.d1RowsRead,
      d1RowsWritten: baseline.usage.d1RowsWritten,
      doSqliteRowsRead: baseline.usage.doSqliteRowsRead,
      doSqliteRowsWritten: baseline.usage.doSqliteRowsWritten,
      kvReads: baseline.usage.kvReads,
      kvWrites: baseline.usage.kvWrites,
      kvDeletes: baseline.usage.kvDeletes,
      kvLists: baseline.usage.kvLists,
      doRequests: baseline.usage.doRequests,
      doDurationGbSeconds: baseline.usage.doDurationGbSeconds,
    },
  }

  const playersPerDraft = scenarioPlayersPerDraft(mode)
  const freeCapacityPlaysPerDay = findMaxPlaysPerDay({
    model,
    limits: FREE_DAILY_LIMITS,
    periodDays: 1,
    playersPerDraft,
  })
  const paidIncludedCapacityPlaysPerDay = findMaxPlaysPerDay({
    model,
    limits: PAID_MONTHLY_LIMITS,
    periodDays: DAYS_PER_MONTH,
    playersPerDraft,
  })
  const paidTenDollarCapacityPlaysPerDay = findMaxPlaysPerDayForOverageBudget({
    model,
    limits: PAID_MONTHLY_LIMITS,
    periodDays: DAYS_PER_MONTH,
    playersPerDraft,
    overageRatesPerMillion: PAID_OVERAGE_RATES_PER_MILLION,
    overageBudgetUsd: PAID_EXTRA_OVERAGE_BUDGET_USD,
  })
  const paidTenDollarOverageUsd = estimateOverageUsd({
    model,
    playsPerDay: paidTenDollarCapacityPlaysPerDay,
    limits: PAID_MONTHLY_LIMITS,
    periodDays: DAYS_PER_MONTH,
    playersPerDraft,
    overageRatesPerMillion: PAID_OVERAGE_RATES_PER_MILLION,
  })

  return {
    mode,
    model,
    draftRoomIncomingMessages: baseline.draftRoomIncomingMessages,
    freeCapacityPlaysPerDay,
    paidIncludedCapacityPlaysPerDay,
    paidTenDollarCapacityPlaysPerDay,
    paidTenDollarOverageUsd,
    freeBreakpoints: findMetricBreakpoints({
      model,
      limits: FREE_DAILY_LIMITS,
      periodDays: 1,
      playersPerDraft,
    }),
    paidBreakpoints: findMetricBreakpoints({
      model,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
      playersPerDraft,
    }),
  }
}

async function simulateScenarioLifecycle(input: {
  mode: CapacityScenario
  backgroundRatedPlayers: number
}): Promise<SimulationResult> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv: rawKv, operations, resetOperations } = createTrackedKv({ trackReads: true })
  const stateCoordinator = installStateCoordinatorHarness()
  const kv = createStateStore({
    KV: rawKv,
    PARTY_HOST: stateCoordinator.host,
    CIVUP_SECRET: stateCoordinator.secret,
  })

  let botRequests = 0
  let activityRequests = 0

  try {
    await setSystemChannel(kv, 'draft', CHANNEL_ID)
    await setSystemChannel(kv, 'archive', 'channel-archive')
    await setSystemChannel(kv, 'leaderboard', 'channel-leaderboard')
    await startSeason(db, { now: NOW })
    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedRatedPlayers(db, input.mode, input.backgroundRatedPlayers)
    await syncRankedRoles({ db, kv, guildId: GUILD_ID, now: NOW + 1_000 })
    await markRankedRolesDirty(kv, 'steady-state-preexisting-dirty-flag')

    resetOperations()
    sqlTracker.reset()

    botRequests += 1
    await simulateMatchCreate(kv, input.mode)

    for (const group of input.mode.joinGroups) {
      botRequests += 1
      await simulateMatchJoin(kv, input.mode, group)
    }

    const playerIds = scenarioPlayerIds(input.mode)
    activityRequests += playerIds.length
    for (const playerId of playerIds) {
      botRequests += 1
      await simulateActivityLaunchSnapshot(kv, CHANNEL_ID, playerId)
    }

    botRequests += 1
    const started = await startDraftFromOpenLobby(db, kv, input.mode)

    botRequests += 1
    await handleDraftCompleteWebhook(db, kv, started.matchId, started.completedDraftState)

    for (let index = 0; index < playerIds.length; index++) {
      botRequests += 1
      await fetchMatchStateSnapshot(db, started.matchId)
    }

    botRequests += 1
    await handleMatchReport(db, kv, input.mode, started.matchId)

    const kvReads = operations.filter(op => op.type === 'get').length
    const kvWrites = operations.filter(op => op.type === 'put').length
    const kvDeletes = operations.filter(op => op.type === 'delete').length
    const kvLists = operations.filter(op => op.type === 'list').length
    const doRequests = estimateDoBilledRequestUnits({
      stateCoordinatorRequests: stateCoordinator.requests(),
      playersPerDraft: scenarioPlayersPerDraft(input.mode),
      draftRoomIncomingMessages: started.draftRoomIncomingMessages,
      lobbyWatchSubscribeMessagesPerConnection: LOBBY_WATCH_SUBSCRIBE_MESSAGES_PER_CONNECTION,
    })

    return {
      draftRoomIncomingMessages: started.draftRoomIncomingMessages,
      usage: {
        workersRequests: botRequests + activityRequests,
        d1RowsRead: sqlTracker.counts.rowsRead,
        d1RowsWritten: sqlTracker.counts.rowsWritten,
        doSqliteRowsRead: stateCoordinator.sqliteRowsRead(),
        doSqliteRowsWritten: stateCoordinator.sqliteRowsWritten(),
        kvReads,
        kvWrites,
        kvDeletes,
        kvLists,
        doRequests,
        doDurationGbSeconds: estimateDoDurationGbSeconds(doRequests),
      },
    }
  }
  finally {
    stateCoordinator.restore()
    sqlTracker.restore()
    sqlite.close()
  }
}

async function simulateMatchCreate(kv: KVNamespace, mode: CapacityScenario): Promise<void> {
  const draftChannelId = await getSystemChannel(kv, 'draft')
  if (!draftChannelId) throw new Error('Expected draft channel to be configured')

  await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  const queue = await getQueueState(kv, mode.mode)

  const hostEntry = buildQueueEntry(HOST_ID, 1)
  const addResult = await addToQueue(kv, mode.mode, hostEntry, { currentState: queue })
  if (addResult.error) throw new Error(addResult.error)

  const lobby = await createLobby(kv, {
    mode: mode.mode,
    guildId: GUILD_ID,
    hostId: HOST_ID,
    channelId: draftChannelId,
    messageId: `message-lobby-open-${mode.id}`,
  })
  await storeUserLobbyMappings(kv, [HOST_ID], lobby.id)
  await storeUserActivityTarget(kv, draftChannelId, [HOST_ID], { kind: 'lobby', id: lobby.id })
}

async function simulateMatchJoin(
  kv: KVNamespace,
  mode: CapacityScenario,
  group: string[],
): Promise<void> {
  const outcome = await joinLobbyAndMaybeStartMatch(
    { env: { KV: kv } },
    mode.mode,
    buildJoinEntries(group),
  )
  if ('error' in outcome) throw new Error(outcome.error)

  await storeUserLobbyMappings(kv, group, outcome.lobby.id)
  await storeUserActivityTarget(kv, outcome.lobby.channelId, group, { kind: 'lobby', id: outcome.lobby.id })
}

async function simulateActivityLaunchSnapshot(
  kv: KVNamespace,
  channelId: string,
  userId: string,
): Promise<void> {
  const storedTarget = await getUserActivityTarget(kv, channelId, userId)
  const queueByMode = new Map<GameMode, Awaited<ReturnType<typeof getQueueState>>>()
  const lobbiesByMode = await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  let selectedLobby: { mode: GameMode, lobby: Awaited<ReturnType<typeof getLobbiesByMode>>[number] } | null = null

  for (let modeIndex = 0; modeIndex < GAME_MODES.length; modeIndex++) {
    const mode = GAME_MODES[modeIndex]!
    const lobbies = lobbiesByMode[modeIndex] ?? []

    for (const lobby of lobbies) {
      if (lobby.channelId !== channelId) continue

      if (lobby.status === 'open') {
        let queue = queueByMode.get(mode)
        if (!queue) {
          queue = await getQueueState(kv, mode)
          queueByMode.set(mode, queue)
        }

        const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
        normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
        if (!selectedLobby) selectedLobby = { mode, lobby }
        if (storedTarget?.kind === 'lobby' && storedTarget.id === lobby.id) selectedLobby = { mode, lobby }
      }
    }
  }

  if (!selectedLobby) return

  const snapshot = await buildOpenLobbySnapshot(kv, selectedLobby.mode, selectedLobby.lobby)
  await resolveLobbyJoinEligibility(undefined, kv, userId, selectedLobby.lobby, snapshot)
}

async function startDraftFromOpenLobby(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: CapacityScenario,
): Promise<{
  matchId: string
  completedDraftState: DraftState
  draftRoomIncomingMessages: number
}> {
  const lobby = await getLobby(kv, mode.mode)
  if (!lobby || lobby.status !== 'open') throw new Error(`Expected open ${mode.mode} lobby before start`)

  const queue = await getQueueState(kv, mode.mode)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  const slots = normalizeLobbySlots(mode.mode, lobby.slots, lobbyQueueEntries)
  const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
  const selectedEntries = slottedEntries.filter((entry): entry is Exclude<(typeof slottedEntries)[number], null> => entry !== null)

  await resolveDraftTimerConfig(kv, lobby.draftConfig)

  const matchId = `match-${mode.id}`
  const seats = buildDraftSeats(mode.mode, slottedEntries)
  if (selectedEntries.length !== seats.length) throw new Error('Seat count did not match selected entries')

  await createDraftMatch(db, { matchId, mode: mode.mode, seats })

  if (lobby.memberPlayerIds.length > 0) {
    await clearQueue(kv, mode.mode, lobby.memberPlayerIds, { currentState: queue })
  }

  await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
  await storeMatchMapping(kv, lobby.channelId, matchId)
  await storeUserMatchMappings(kv, lobby.memberPlayerIds, matchId)
  await storeUserActivityTarget(kv, lobby.channelId, lobby.memberPlayerIds, { kind: 'match', id: matchId })

  const slottedLobby = await setLobbySlots(kv, lobby.id, slots, lobby) ?? { ...lobby, slots }
  await attachLobbyMatch(kv, lobby.id, matchId, slottedLobby)
  await storeMatchMessageMapping(db, `message-lobby-drafting-${mode.id}`, matchId)

  const completedDraft = buildCompletedDraftState(matchId, mode.mode, seats)
  return {
    matchId,
    completedDraftState: completedDraft.state,
    draftRoomIncomingMessages: completedDraft.inputCount,
  }
}

async function handleDraftCompleteWebhook(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  matchId: string,
  state: DraftState,
): Promise<void> {
  const activated = await activateDraftMatch(db, {
    state,
    completedAt: NOW + 5_000,
    hostId: state.seats[0]?.playerId ?? HOST_ID,
  })
  if ('error' in activated) throw new Error(activated.error)

  const lobby = await getLobbyByMatch(kv, matchId)
  if (!lobby) throw new Error('Expected lobby mapping during draft-complete simulation')

  await setLobbyStatus(kv, lobby.id, 'active', lobby)
  await storeMatchMessageMapping(db, `message-lobby-active-${matchId}`, matchId)
}

async function fetchMatchStateSnapshot(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  matchId: string,
): Promise<void> {
  await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
}

async function handleMatchReport(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: CapacityScenario,
  matchId: string,
): Promise<void> {
  const reported = await reportMatch(db, kv, {
    matchId,
    reporterId: HOST_ID,
    placements: buildPlacements(mode),
  })
  if ('error' in reported) throw new Error(reported.error)

  const lobby = await getLobbyByMatch(kv, matchId)
  const guildId = lobby?.guildId ?? null

  if (guildId) {
    const participantIds = reported.participants.map(participant => participant.playerId)
    const rankedPreview = await previewRankedRoles({
      db,
      kv,
      guildId,
      now: NOW + 6_000,
      playerIds: participantIds,
      includePlayerIdentities: false,
    })
    await listRankedRoleMatchUpdateLines({
      kv,
      guildId,
      preview: rankedPreview,
      playerIds: participantIds,
    })
    await syncSeasonPeaksForPlayers(db, {
      playerIds: participantIds,
      playerPreviews: rankedPreview.playerPreviews,
      now: NOW + 6_000,
    })
  }

  if (lobby) {
    await setLobbyStatus(kv, lobby.id, 'completed', lobby)
    await storeMatchMessageMapping(db, `message-lobby-reported-${mode.id}`, matchId)
    await clearLobbyMappings(kv, lobby.memberPlayerIds, lobby.channelId)
    await clearLobbyById(kv, lobby.id)
  }

  const archiveChannelId = await getSystemChannel(kv, 'archive')
  if (archiveChannelId) {
    await storeMatchMessageMapping(db, `message-archive-reported-${mode.id}`, matchId)
  }

  await markLeaderboardsDirty(db, `match-report:${matchId}`)
  await markRankedRolesDirty(kv, `match-report:${matchId}`)
}

function buildCompletedDraftState(
  matchId: string,
  mode: GameMode,
  seats: DraftSeat[],
): { state: DraftState, inputCount: number } {
  const format = getDefaultFormat(mode)
  let state = createDraft(matchId, format, seats, allLeaderIds)
  let inputCount = 0

  state = applyDraftInput(state, { type: 'START' }, format.blindBans)
  inputCount += 1

  while (state.status !== 'complete') {
    const step = state.steps[state.currentStepIndex]
    if (!step) throw new Error('Expected a current draft step while completing the draft')

    const activeSeatIndices = step.seats === 'all'
      ? Array.from({ length: state.seats.length }, (_value, index) => index)
      : [...step.seats]

    if (step.action === 'ban') {
      const reserved = new Set<string>()
      for (const seatIndex of activeSeatIndices) {
        if (state.submissions[seatIndex]) continue
        const civIds = pickAvailableCivs(state.availableCivIds, step.count, reserved)
        for (const civId of civIds) reserved.add(civId)
        state = applyDraftInput(state, { type: 'BAN', seatIndex, civIds }, format.blindBans)
        inputCount += 1
      }
      continue
    }

    const currentStepIndex = state.currentStepIndex
    for (const seatIndex of activeSeatIndices) {
      const picksMade = state.submissions[seatIndex]?.length ?? 0
      if (picksMade >= step.count) continue

      const alreadyChosen = new Set(Object.values(state.submissions).flat())
      const [civId] = pickAvailableCivs(state.availableCivIds, 1, alreadyChosen)
      if (!civId) throw new Error('Expected a civ to be available for the next pick')

      state = applyDraftInput(state, { type: 'PICK', seatIndex, civId }, format.blindBans)
      inputCount += 1
      if (state.status === 'complete' || state.currentStepIndex !== currentStepIndex) break
    }
  }

  return { state, inputCount }
}

function applyDraftInput(
  state: DraftState,
  input: DraftInput,
  blindBans: boolean,
): DraftState {
  const result = processDraftInput(state, input, blindBans)
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

async function seedRatedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: CapacityScenario,
  backgroundRatedPlayers: number,
): Promise<void> {
  const playerIds = [
    ...scenarioPlayerIds(mode),
    ...Array.from({ length: backgroundRatedPlayers }, (_value, index) => `seed-${mode.id}-${index + 1}`),
  ]
  const leaderboardMode = toLeaderboardMode(mode.mode)

  await db.insert(players).values(playerIds.map((playerId, index) => ({
    id: playerId,
    displayName: playerId.toUpperCase(),
    avatarUrl: null,
    createdAt: NOW + index,
  })))

  await db.insert(playerRatings).values(playerIds.map((playerId, index) => ({
    playerId,
    mode: leaderboardMode,
    mu: 40 - index,
    sigma: 6,
    gamesPlayed: 10,
    wins: Math.max(0, 6 - (index % 4)),
    lastPlayedAt: NOW + 10_000 + index,
  })))
}

function buildJoinEntries(group: string[]): QueueEntry[] {
  return group.map((playerId, index) => ({
    playerId,
    displayName: `Player ${playerId}`,
    avatarUrl: null,
    joinedAt: index + 2,
    partyIds: group.filter(candidate => candidate !== playerId),
  }))
}

function buildDraftSeats(
  mode: GameMode,
  slottedEntries: ReturnType<typeof mapLobbySlotsToEntries>,
): DraftSeat[] {
  const seats: DraftSeat[] = []

  for (let index = 0; index < slottedEntries.length; index++) {
    const entry = slottedEntries[index]
    if (!entry) continue
    const team = slotToTeamIndex(mode, index)
    seats.push({
      playerId: entry.playerId,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl ?? null,
      team: team ?? undefined,
    })
  }

  return seats
}

function buildPlacements(mode: CapacityScenario): string {
  if (mode.mode !== 'ffa') return 'A'
  return scenarioPlayerIds(mode).map(playerId => `<@${playerId}>`).join('\n')
}

function buildQueueEntry(playerId: string, joinedAt: number): QueueEntry {
  return {
    playerId,
    displayName: `Player ${playerId}`,
    avatarUrl: null,
    joinedAt,
  }
}

function pickAvailableCivs(
  availableCivIds: string[],
  count: number,
  blocked: Set<string>,
): string[] {
  const picked: string[] = []

  for (const civId of availableCivIds) {
    if (blocked.has(civId)) continue
    picked.push(civId)
    if (picked.length >= count) return picked
  }

  throw new Error(`Expected ${count} available civs, found ${picked.length}`)
}

function scenarioPlayerIds(mode: CapacityScenario): string[] {
  return [...new Set([HOST_ID, ...mode.joinGroups.flat()])]
}

function scenarioPlayersPerDraft(mode: CapacityScenario): number {
  return scenarioPlayerIds(mode).length
}

function printReports(reports: ScenarioReport[]): void {
  console.log('\n[capacity] assumptions')
  console.table(reports.map(report => ({
    mode: report.mode.label,
    players: scenarioPlayersPerDraft(report.mode),
    draftMsgs: report.draftRoomIncomingMessages,
  })))
  console.log('[capacity] globals', {
    lobbyWatchMsgsPerConnection: LOBBY_WATCH_SUBSCRIBE_MESSAGES_PER_CONNECTION,
    doWebsocketBillingRatio: DO_WEBSOCKET_BILLING_RATIO,
    estimatedDoGbSecondsPerRequest: ESTIMATED_DO_GB_SECONDS_PER_REQUEST,
  })

  console.log('\n[capacity] measured per draft usage')
  console.table(reports.map(report => ({
    mode: report.mode.label,
    workersRequests: report.model.perDraft.workersRequests,
    d1RowsRead: report.model.perDraft.d1RowsReadBase,
    d1RowsWritten: report.model.perDraft.d1RowsWritten,
    doSqliteRowsRead: report.model.perDraft.doSqliteRowsRead,
    doSqliteRowsWritten: report.model.perDraft.doSqliteRowsWritten,
    kvReads: report.model.perDraft.kvReads,
    kvWrites: report.model.perDraft.kvWrites,
    doRequests: report.model.perDraft.doRequests,
  })))

  console.log('\n[capacity] plan ceilings')
  console.table(reports.flatMap((report) => {
    const playersPerDraft = scenarioPlayersPerDraft(report.mode)
    const freeBottleneck = report.freeBreakpoints[0]
    const paidBottleneck = report.paidBreakpoints[0]

    return [
      {
        mode: report.mode.label,
        plan: 'free',
        playsPerDay: report.freeCapacityPlaysPerDay,
        draftsPerDay: report.freeCapacityPlaysPerDay / playersPerDraft,
        bottleneck: freeBottleneck?.metric ?? 'unknown',
      },
      {
        mode: report.mode.label,
        plan: '$5 included',
        playsPerDay: report.paidIncludedCapacityPlaysPerDay,
        draftsPerDay: report.paidIncludedCapacityPlaysPerDay / playersPerDraft,
        bottleneck: paidBottleneck?.metric ?? 'unknown',
      },
      {
        mode: report.mode.label,
        plan: '$10 target',
        playsPerDay: report.paidTenDollarCapacityPlaysPerDay,
        draftsPerDay: report.paidTenDollarCapacityPlaysPerDay / playersPerDraft,
        bottleneck: '',
      },
    ]
  }))

  console.log('\n[capacity] metric breakpoints')
  console.table(reports.flatMap((report) => {
    const playersPerDraft = scenarioPlayersPerDraft(report.mode)
    const freeRows = report.mode.id === 'duel-ranked'
      ? report.freeBreakpoints
      : report.freeBreakpoints.slice(0, 3)
    const paidRows = report.mode.id === 'duel-ranked'
      ? report.paidBreakpoints
      : report.paidBreakpoints.slice(0, 3)

    return [
      ...freeRows.map((row, index) => ({
        mode: report.mode.label,
        plan: 'free',
        rank: index + 1,
        metric: row.metric,
        playsPerDay: row.playsPerDay,
        draftsPerDay: row.playsPerDay / playersPerDraft,
      })),
      ...paidRows.map((row, index) => ({
        mode: report.mode.label,
        plan: '$5 included',
        rank: index + 1,
        metric: row.metric,
        playsPerDay: row.playsPerDay,
        draftsPerDay: row.playsPerDay / playersPerDraft,
      })),
    ]
  }))
}

function estimateDoBilledRequestUnits(input: {
  stateCoordinatorRequests: number
  playersPerDraft: number
  draftRoomIncomingMessages: number
  lobbyWatchSubscribeMessagesPerConnection: number
}): number {
  const draftRoomWebsocketConnects = input.playersPerDraft
  const lobbyWatchWebsocketConnects = input.playersPerDraft
  const lobbyWatchIncomingMessages = input.playersPerDraft * input.lobbyWatchSubscribeMessagesPerConnection

  const billedDraftMessages = Math.ceil(input.draftRoomIncomingMessages / DO_WEBSOCKET_BILLING_RATIO)
  const billedLobbyWatchMessages = Math.ceil(lobbyWatchIncomingMessages / DO_WEBSOCKET_BILLING_RATIO)

  return (
    DO_CREATE_ROOM_REQUESTS_PER_DRAFT
    + draftRoomWebsocketConnects
    + lobbyWatchWebsocketConnects
    + billedDraftMessages
    + billedLobbyWatchMessages
    + input.stateCoordinatorRequests
  )
}

function estimateDoDurationGbSeconds(doRequests: number): number {
  return Number((doRequests * ESTIMATED_DO_GB_SECONDS_PER_REQUEST).toFixed(4))
}

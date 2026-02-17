/* eslint-disable no-console */
import type { DraftSeat, DraftState, GameMode, QueueEntry } from '@civup/game'
import { playerRatings, players } from '@civup/db'
import {
  allLeaderIds,
  createDraft,
  getDefaultFormat,
  isDraftError,
  processDraftInput,
} from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import {
  getMatchForChannel,
  storeMatchMapping,
} from '../../src/services/activity.ts'
import {
  getServerDraftTimerDefaults,
  resolveDraftTimerConfig,
} from '../../src/services/config.ts'
import { markLeaderboardsDirty } from '../../src/services/leaderboard-message.ts'
import {
  clearLobby,
  createLobby,
  getLobby,
  getLobbyByChannel,
  getLobbyByMatch,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  sameLobbySlots,
  setLobbySlots,
  setLobbyStatus,
  upsertLobby,
} from '../../src/services/lobby.ts'
import { storeMatchMessageMapping } from '../../src/services/match-message.ts'
import {
  activateDraftMatch,
  createDraftMatch,
  reportMatch,
} from '../../src/services/match.ts'
import {
  addToQueue,
  clearQueue,
  getPlayerQueueMode,
  getQueueState,
} from '../../src/services/queue.ts'
import { createStateStore } from '../../src/services/state-store.ts'
import {
  getSystemChannel,
  setSystemChannel,
} from '../../src/services/system-channels.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { installStateCoordinatorHarness } from '../helpers/state-coordinator-harness.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'
import type {
  CapacityModel,
  OverageRatesPerMillion,
  UsageLimits,
} from './capacity/model.ts'
import {
  estimateDailyUsage,
  estimateOverageUsd,
  findMaxPlaysPerDay,
  findMaxPlaysPerDayForOverageBudget,
  findMetricBreakpoints,
} from './capacity/model.ts'

interface SimulationResult {
  usage: {
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
}

const DAILY_PLAY_SCENARIOS = [100, 200, 1000] as const
const PLAYERS_PER_DRAFT = 2

const DO_WEBSOCKET_BILLING_RATIO = 20
const DO_CREATE_ROOM_REQUESTS_PER_DRAFT = 1
const LOBBY_WATCH_SUBSCRIBE_MESSAGES_PER_CONNECTION = 3
const ESTIMATED_DO_GB_SECONDS_PER_REQUEST = 0.0025

const SIMULATED_DRAFT_ACTIONS: Array<Parameters<typeof processDraftInput>[1]> = [
  { type: 'START' },
  {
    type: 'BAN',
    seatIndex: 0,
    civIds: [allLeaderIds[0]!, allLeaderIds[1]!, allLeaderIds[2]!],
  },
  {
    type: 'BAN',
    seatIndex: 1,
    civIds: [allLeaderIds[3]!, allLeaderIds[4]!, allLeaderIds[5]!],
  },
  { type: 'PICK', seatIndex: 0, civId: allLeaderIds[6]! },
  { type: 'PICK', seatIndex: 1, civId: allLeaderIds[7]! },
]

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

describe('1v1 capacity model', () => {
  test('prints free vs paid capacity projections', async () => {
    const baseline = await simulateOneVOneDraft({
      leaderboardRows: 0,
    })
    const withOneLeaderboardRow = await simulateOneVOneDraft({
      leaderboardRows: 1,
    })

    const d1RowsReadPerLeaderboardPlayer = withOneLeaderboardRow.usage.d1RowsRead - baseline.usage.d1RowsRead
    const model: CapacityModel = {
      perDraft: {
        workersRequests: baseline.usage.workersRequests,
        d1RowsReadBase: baseline.usage.d1RowsRead,
        d1RowsReadPerLeaderboardPlayer,
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

    const scenarioRows = DAILY_PLAY_SCENARIOS.map((playsPerDay) => {
      const usage = estimateDailyUsage(model, playsPerDay, PLAYERS_PER_DRAFT)
      return {
        playsPerDay,
        draftsPerDay1v1: playsPerDay / PLAYERS_PER_DRAFT,
        workersRequests: usage.workersRequests,
        d1RowsRead: usage.d1RowsRead,
        d1RowsWritten: usage.d1RowsWritten,
        doSqliteRowsRead: usage.doSqliteRowsRead,
        doSqliteRowsWritten: usage.doSqliteRowsWritten,
        kvReads: usage.kvReads,
        kvWrites: usage.kvWrites,
        kvDeletes: usage.kvDeletes,
        kvLists: usage.kvLists,
        doRequests: usage.doRequests,
        doDurationGbSeconds: usage.doDurationGbSeconds,
      }
    })

    const freeCapacityPlaysPerDay = findMaxPlaysPerDay({
      model,
      limits: FREE_DAILY_LIMITS,
      periodDays: 1,
      playersPerDraft: PLAYERS_PER_DRAFT,
    })

    const paidIncludedCapacityPlaysPerDay = findMaxPlaysPerDay({
      model,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
      playersPerDraft: PLAYERS_PER_DRAFT,
    })

    const paidTenDollarCapacityPlaysPerDay = findMaxPlaysPerDayForOverageBudget({
      model,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
      playersPerDraft: PLAYERS_PER_DRAFT,
      overageRatesPerMillion: PAID_OVERAGE_RATES_PER_MILLION,
      overageBudgetUsd: PAID_EXTRA_OVERAGE_BUDGET_USD,
    })

    const paidTenDollarOverageUsd = estimateOverageUsd({
      model,
      playsPerDay: paidTenDollarCapacityPlaysPerDay,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
      playersPerDraft: PLAYERS_PER_DRAFT,
      overageRatesPerMillion: PAID_OVERAGE_RATES_PER_MILLION,
    })

    const freeBreakpoints = findMetricBreakpoints({
      model,
      limits: FREE_DAILY_LIMITS,
      periodDays: 1,
      playersPerDraft: PLAYERS_PER_DRAFT,
    })
    const paidBreakpoints = findMetricBreakpoints({
      model,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
      playersPerDraft: PLAYERS_PER_DRAFT,
    })

    const freeBottleneck = freeBreakpoints[0]!
    const paidBottleneck = paidBreakpoints[0]!

    if (SHOULD_PRINT_REPORT) {
      console.log('\n[capacity] assumptions')
      console.table([
        {
          playersPerDraft: PLAYERS_PER_DRAFT,
          draftRoomIncomingMessages: SIMULATED_DRAFT_ACTIONS.length,
          lobbyWatchSubscribeMessagesPerConnection: LOBBY_WATCH_SUBSCRIBE_MESSAGES_PER_CONNECTION,
          doWebsocketBillingRatio: DO_WEBSOCKET_BILLING_RATIO,
          estimatedDoGbSecondsPerRequest: ESTIMATED_DO_GB_SECONDS_PER_REQUEST,
        },
      ])

      console.log('\n[capacity] measured per draft usage')
      console.table([
        {
          workersRequests: model.perDraft.workersRequests,
          d1RowsReadBase: model.perDraft.d1RowsReadBase,
          d1RowsReadPerLeaderboardPlayer: model.perDraft.d1RowsReadPerLeaderboardPlayer,
          d1RowsWritten: model.perDraft.d1RowsWritten,
          doSqliteRowsRead: model.perDraft.doSqliteRowsRead,
          doSqliteRowsWritten: model.perDraft.doSqliteRowsWritten,
          kvReads: model.perDraft.kvReads,
          kvWrites: model.perDraft.kvWrites,
          kvDeletes: model.perDraft.kvDeletes,
          kvLists: model.perDraft.kvLists,
          doRequests: model.perDraft.doRequests,
          doDurationGbSeconds: model.perDraft.doDurationGbSeconds,
        },
      ])

      console.log('\n[capacity] scenario usage by daily plays')
      console.table(scenarioRows)

      console.log('\n[capacity] plan ceilings')
      console.table([
        {
          plan: 'free',
          playsPerDay: freeCapacityPlaysPerDay,
          draftsPerDay1v1: freeCapacityPlaysPerDay / PLAYERS_PER_DRAFT,
          bottleneck: freeBottleneck.metric,
        },
        {
          plan: '$5 included',
          playsPerDay: paidIncludedCapacityPlaysPerDay,
          draftsPerDay1v1: paidIncludedCapacityPlaysPerDay / PLAYERS_PER_DRAFT,
          bottleneck: paidBottleneck.metric,
        },
        {
          plan: '$10 target',
          playsPerDay: paidTenDollarCapacityPlaysPerDay,
          draftsPerDay1v1: paidTenDollarCapacityPlaysPerDay / PLAYERS_PER_DRAFT,
          bottleneck: `$${PAID_EXTRA_OVERAGE_BUDGET_USD.toFixed(2)} monthly overage budget`,
        },
      ])

      console.log('\n[capacity] bottleneck breakpoints by metric')
      console.table([
        ...freeBreakpoints.map((row, index) => ({
          plan: 'free',
          rank: index + 1,
          metric: row.metric,
          playsPerDay: row.playsPerDay,
          draftsPerDay1v1: row.draftsPerDay1v1,
        })),
        ...paidBreakpoints.map((row, index) => ({
          plan: '$5 included',
          rank: index + 1,
          metric: row.metric,
          playsPerDay: row.playsPerDay,
          draftsPerDay1v1: row.draftsPerDay1v1,
        })),
      ])
    }

    expect(model.perDraft.kvWrites).toBeGreaterThanOrEqual(0)
    expect(model.perDraft.d1RowsWritten).toBeGreaterThan(0)
    expect(freeCapacityPlaysPerDay).toBeGreaterThan(0)
    expect(paidIncludedCapacityPlaysPerDay).toBeGreaterThan(0)
    expect(paidTenDollarCapacityPlaysPerDay).toBeGreaterThanOrEqual(paidIncludedCapacityPlaysPerDay)
    expect(paidTenDollarOverageUsd).toBeLessThanOrEqual(PAID_EXTRA_OVERAGE_BUDGET_USD)
  })
})

async function simulateOneVOneDraft(input: {
  leaderboardRows: number
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
    await setSystemChannel(kv, 'draft', 'channel-draft')
    await setSystemChannel(kv, 'archive', 'channel-archive')
    await setSystemChannel(kv, 'leaderboard', 'channel-leaderboard')

    if (input.leaderboardRows > 0) {
      await seedLeaderboardRows(db, input.leaderboardRows)
    }

    resetOperations()
    sqlTracker.reset()

    botRequests += 1
    await simulateMatchCreate(kv)

    botRequests += 1
    await simulateMatchJoin(kv)

    activityRequests += 2

    for (const _userId of ['p1', 'p2']) {
      await callActivityBotApi(async () => {
        await lookupMatchForChannel(kv, 'channel-draft')
      }, () => {
        botRequests += 1
        activityRequests += 1
      })

      await callActivityBotApi(async () => {
        await lookupLobbyForChannel(kv, 'channel-draft')
      }, () => {
        botRequests += 1
        activityRequests += 1
      })
    }

    const started = await callActivityBotApi(
      async () => startDraftFromOpenLobby(db, kv),
      () => {
        botRequests += 1
        activityRequests += 1
      },
    )

    await callActivityBotApi(async () => {
      await lookupLobbyForChannel(kv, 'channel-draft')
    }, () => {
      botRequests += 1
      activityRequests += 1
    })

    await callActivityBotApi(async () => {
      await lookupLobbyForUser(kv, 'p2')
    }, () => {
      botRequests += 1
      activityRequests += 1
    })

    await callActivityBotApi(async () => {
      await lookupMatchForChannel(kv, 'channel-draft')
    }, () => {
      botRequests += 1
      activityRequests += 1
    })

    botRequests += 1
    await handleDraftCompleteWebhook(db, kv, started.matchId, started.seats)

    await callActivityBotApi(async () => {
      await handleMatchReport(db, kv, started.matchId)
    }, () => {
      botRequests += 1
      activityRequests += 1
    })

    activityRequests += 2

    const kvReads = operations.filter(op => op.type === 'get').length
    const kvWrites = operations.filter(op => op.type === 'put').length
    const kvDeletes = operations.filter(op => op.type === 'delete').length
    const kvLists = operations.filter(op => op.type === 'list').length
    const coordinatorRequests = stateCoordinator.requests()
    const doRequests = estimateDoBilledRequestUnits({
      stateCoordinatorRequests: coordinatorRequests,
      playersPerDraft: PLAYERS_PER_DRAFT,
      draftRoomIncomingMessages: SIMULATED_DRAFT_ACTIONS.length,
      lobbyWatchSubscribeMessagesPerConnection: LOBBY_WATCH_SUBSCRIBE_MESSAGES_PER_CONNECTION,
    })

    return {
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

async function simulateMatchCreate(kv: KVNamespace): Promise<void> {
  const mode: GameMode = '1v1'

  await getSystemChannel(kv, 'draft')
  await getLobby(kv, mode)
  await getQueueState(kv, mode)

  const hostEntry = queueEntry('p1', 'Host', 1)
  const addResult = await addToQueue(kv, mode, hostEntry)
  if (addResult.error) throw new Error(addResult.error)

  await getQueueState(kv, mode)
  await createLobby(kv, {
    mode,
    hostId: hostEntry.playerId,
    channelId: 'channel-draft',
    messageId: 'message-lobby-open',
  })
}

async function simulateMatchJoin(kv: KVNamespace): Promise<void> {
  const outcome = await joinLobbyAndMaybeStartMatch(
    { env: { KV: kv } },
    '1v1',
    'p2',
    'Guest',
    '',
    'channel-draft',
  )
  if ('error' in outcome) throw new Error(outcome.error)
}

async function startDraftFromOpenLobby(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
): Promise<{ matchId: string, seats: DraftSeat[] }> {
  const mode: GameMode = '1v1'
  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.status !== 'open') throw new Error('Expected open 1v1 lobby before start')

  const queue = await getQueueState(kv, mode)
  const slots = normalizeLobbySlots(mode, lobby.slots, queue.entries)
  const slottedEntries = mapLobbySlotsToEntries(slots, queue.entries)
  const selectedEntries = slottedEntries.filter((entry): entry is Exclude<(typeof slottedEntries)[number], null> => entry !== null)

  await resolveDraftTimerConfig(kv, lobby.draftConfig)

  const matchId = 'match-1'
  const seats = selectedEntries.map((entry, team): DraftSeat => ({
    playerId: entry.playerId,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl ?? null,
    team,
  }))

  await createDraftMatch(db, { matchId, mode, seats })

  if (queue.entries.length > 0) {
    await clearQueue(kv, mode, queue.entries.map(entry => entry.playerId))
  }

  await storeMatchMapping(kv, lobby.channelId, matchId)

  const attachedLobby = await setLobbySlots(kv, mode, slots)
  const nextLobbyBase = attachedLobby ?? { ...lobby, slots }

  await upsertLobby(kv, {
    ...nextLobbyBase,
    status: 'drafting',
    matchId,
    updatedAt: Date.now(),
    revision: nextLobbyBase.revision + 1,
  })

  await storeMatchMessageMapping(db, 'message-lobby-drafting', matchId)

  return { matchId, seats }
}

async function handleDraftCompleteWebhook(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  matchId: string,
  seats: DraftSeat[],
): Promise<void> {
  const state = buildCompletedDraftState(matchId, seats)

  const activated = await activateDraftMatch(db, {
    state,
    completedAt: Date.now(),
    hostId: seats[0]!.playerId,
  })

  if ('error' in activated) throw new Error(activated.error)

  const lobby = await getLobbyByMatch(kv, matchId)
  if (!lobby) throw new Error('Expected lobby mapping during draft-complete webhook simulation')

  await setLobbyStatus(kv, lobby.mode, 'active', lobby)
  await storeMatchMessageMapping(db, 'message-lobby-active', matchId)
}

async function handleMatchReport(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  matchId: string,
): Promise<void> {
  const reported = await reportMatch(db, kv, {
    matchId,
    reporterId: 'p1',
    placements: 'A',
  })

  if ('error' in reported) throw new Error(reported.error)

  const lobby = await getLobbyByMatch(kv, matchId)
  if (lobby) {
    await setLobbyStatus(kv, lobby.mode, 'completed', lobby)
    await storeMatchMessageMapping(db, 'message-lobby-reported', matchId)
    await clearLobby(kv, lobby.mode)
  }

  const archiveChannelId = await getSystemChannel(kv, 'archive')
  if (archiveChannelId) {
    await storeMatchMessageMapping(db, 'message-archive-reported', matchId)
  }

  await markLeaderboardsDirty(db, `match-report:${matchId}`)
}

function buildCompletedDraftState(matchId: string, seats: DraftSeat[]): DraftState {
  const format = getDefaultFormat('1v1')
  let state = createDraft(matchId, format, seats, allLeaderIds)

  for (const action of SIMULATED_DRAFT_ACTIONS) {
    state = applyDraftInput(state, action, format.blindBans)
  }

  if (state.status !== 'complete') {
    throw new Error(`Expected completed draft state, got ${state.status}`)
  }

  return state
}

function applyDraftInput(
  state: DraftState,
  input: Parameters<typeof processDraftInput>[1],
  blindBans: boolean,
): DraftState {
  const result = processDraftInput(state, input, blindBans)
  if (isDraftError(result)) throw new Error(result.error)
  return result.state
}

async function lookupMatchForChannel(kv: KVNamespace, channelId: string): Promise<string | null> {
  return getMatchForChannel(kv, channelId)
}

async function lookupLobbyForChannel(kv: KVNamespace, channelId: string): Promise<unknown | null> {
  const lobby = await getLobbyByChannel(kv, channelId)
  if (lobby?.status === 'open') return buildOpenLobbySnapshot(kv, lobby.mode, lobby)
  return null
}

async function lookupLobbyForUser(kv: KVNamespace, userId: string): Promise<unknown | null> {
  const mode = await getPlayerQueueMode(kv, userId)
  if (!mode) return null

  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.status !== 'open') return null

  return buildOpenLobbySnapshot(kv, mode, lobby)
}

async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: {
    hostId: string
    status: string
    slots: (string | null)[]
    draftConfig: {
      banTimerSeconds: number | null
      pickTimerSeconds: number | null
    }
  },
): Promise<unknown> {
  const queue = await getQueueState(kv, mode)
  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, queue.entries)

  if (sameLobbySlots(normalizedSlots, lobby.slots)) {
    return buildOpenLobbySnapshotFromParts(kv, mode, queue.entries, normalizedSlots)
  }

  const updatedLobby = await setLobbySlots(kv, mode, normalizedSlots)
  const resolvedLobby = updatedLobby ?? {
    ...lobby,
    slots: normalizedSlots,
  }

  return buildOpenLobbySnapshotFromParts(kv, mode, queue.entries, resolvedLobby.slots)
}

async function buildOpenLobbySnapshotFromParts(
  kv: KVNamespace,
  _mode: GameMode,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  slots: (string | null)[],
): Promise<unknown> {
  mapLobbySlotsToEntries(slots, queueEntries)
  await getServerDraftTimerDefaults(kv)
  return null
}

async function seedLeaderboardRows(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  count: number,
): Promise<void> {
  const now = Date.now()
  const playerRows = Array.from({ length: count }, (_, index) => ({
    id: `seed-player-${index + 1}`,
    displayName: `Seed Player ${index + 1}`,
    avatarUrl: null,
    createdAt: now,
  }))

  if (playerRows.length > 0) {
    await db.insert(players).values(playerRows)
    await db.insert(playerRatings).values(playerRows.map((player, index) => ({
      playerId: player.id,
      mode: 'duel',
      mu: 25 + (index % 7),
      sigma: 8,
      gamesPlayed: 10,
      wins: 5,
      lastPlayedAt: now,
    })))
  }
}

function queueEntry(playerId: string, displayName: string, joinedAt: number): QueueEntry {
  return {
    playerId,
    displayName,
    avatarUrl: null,
    joinedAt,
  }
}

async function callActivityBotApi<T>(
  fn: () => Promise<T>,
  increment: () => void,
): Promise<T> {
  increment()
  return fn()
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

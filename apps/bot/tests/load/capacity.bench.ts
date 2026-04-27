/* eslint-disable no-console */
import type { DraftInput, DraftSeat, DraftState, GameMode, QueueEntry } from '@civup/game'
import type { CapacityModel, DailyUsage, MetricBreakpoint, OverageRatesPerMillion, UsageLimits } from './capacity/model.ts'
import type { CapacityScenario, CapacitySnapshot, CapacitySnapshotBreakpoint, ScenarioReport, SimulationResult, UsageSample } from './capacity/types.ts'
import { readFile as readFileText, writeFile as writeFileText } from 'node:fs/promises'
import { matches, matchParticipants, playerRatings, players } from '@civup/db'
import {
  allLeaderIds,
  createDraft,
  getDefaultFormat,
  isDraftError,
  isTeamMode,
  processDraftInput,
  slotToTeamIndex,
  swapSeatPicks,
  toLeaderboardMode,
} from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { findBlockingDraftMatchIdsForPlayers, joinLobbyAndMaybeStartMatch } from '../../src/commands/match/shared.ts'
import { buildActivityLaunchSnapshot, selectActivityTargetForUser } from '../../src/routes/activity.ts'
import { getLobbyBalanceSnapshot } from '../../src/routes/lobby/snapshot.ts'
import { getLobbyForUser, getMatchForUser } from '../../src/services/activity/index.ts'
import { resolveDraftTimerConfig } from '../../src/services/config/index.ts'
import { markLeaderboardsDirty, refreshDirtyLeaderboards } from '../../src/services/leaderboard/message.ts'
import { ensureLeaderboardModeSnapshots } from '../../src/services/leaderboard/snapshot.ts'
import {
  createLobby,
  filterQueueEntriesForLobby,
  getLobby,
  getLobbyById,
  getTestLobbyRuntime,
  mapLobbySlotsToEntries,
  normalizeLobbySlots,
  pruneInactiveOpenLobbies,
  setLobbyDraftConfig,
  setLobbySlots,
  setLobbyStatus,
  startTestSessionDraft,
} from '../helpers/lobby-runtime.ts'
import { syncLobbyDerivedState } from '../../src/services/lobby/live-snapshot.ts'
import { pruneAbandonedMatches } from '../../src/services/match/cleanup.ts'
import { activateDraftMatch, reportMatch } from '../../src/services/match/index.ts'
import { storeMatchMessageMapping } from '../../src/services/match/message.ts'
import { clearRankedRolesDirtyState, getRankedRolesDirtyState, listRankedRoleConfigGuildIds, listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { startSeason, syncSeasonPeaksForPlayers } from '../../src/services/season/index.ts'
import { getOpenSessionLobbyProjectionHostedBy, getSessionLobbyProjectionByMatch } from '../../src/services/session/index.ts'
import { getSystemChannel, setSystemChannel } from '../../src/services/system/channels.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'
import {
  addUsage,
  estimateDailyUsage,
  estimateOverageUsd,
  findMaxPlaysPerDay,
  findMaxPlaysPerDayForOverageBudget,
  findMetricBreakpoints,
  multiplyUsage,
} from './capacity/model.ts'

const CHANNEL_ID = 'channel-draft'
const GUILD_ID = 'guild-1'
const HOST_ID = 'p1'
const ACTIVITY_SECRET = 'capacity-test-secret'

const CAPACITY_SCENARIOS: CapacityScenario[] = [
  {
    id: 'duel-ranked',
    label: '1v1',
    mode: '1v1',
    joinGroups: [['p2']],
  },
  {
    id: 'duel-ranked-plus-spectators',
    label: '1v1+2spec',
    mode: '1v1',
    joinGroups: [['p2']],
    spectatorIds: ['spec-1', 'spec-2'],
  },
  {
    id: 'duo-ranked',
    label: '2v2',
    mode: '2v2',
    joinGroups: [['p2'], ['p3', 'p4']],
  },
  {
    id: 'squad-ranked',
    label: '3v3',
    mode: '3v3',
    joinGroups: [['p2', 'p3'], ['p4', 'p5', 'p6']],
  },
  {
    id: 'teamer-ranked',
    label: '4v4',
    mode: '4v4',
    joinGroups: [['p2', 'p3', 'p4'], ['p5', 'p6', 'p7', 'p8']],
  },
  {
    id: 'ffa-eight-player',
    label: 'ffa8',
    mode: 'ffa',
    joinGroups: [['p2'], ['p3'], ['p4'], ['p5'], ['p6'], ['p7'], ['p8']],
  },
]

// SessionSocketServer keeps connections in memory, so model every incoming websocket message as billed.
const DO_WEBSOCKET_BILLING_RATIO = 1
const DO_CREATE_ROOM_REQUESTS_PER_DRAFT = 1
const LOBBY_WATCH_INCOMING_MESSAGES_PER_CONNECTION = 4
const ESTIMATED_DO_GB_SECONDS_PER_REQUEST = 0.0025
const AVERAGE_ACCEPTED_SWAPS_PER_TEAM_DRAFT = 0.5
const ACCEPTED_SWAP_DRAFT_ROOM_INCOMING_MESSAGES = 2
const TARGET_ARCHITECTURE_MODEL = 'target-session-do-v3-low-kv-do-sqlite-overview'
const TARGET_SESSION_SOCKET_CONNECTIONS_PER_VIEWER = 1
const TARGET_SESSION_DO_SQL_READS_PER_COMMAND = 1
const TARGET_SESSION_DO_SQL_WRITES_PER_COMMAND = 1
const TARGET_SESSION_DO_SQL_READS_PER_SOCKET_CONNECT = 1
const TARGET_SESSION_DO_SQL_WRITES_PER_SOCKET_CONNECT = 0
const TARGET_SESSION_DO_SQL_READS_PER_DRAFT_MESSAGE = 1
const TARGET_SESSION_DO_SQL_WRITES_PER_DRAFT_MESSAGE = 1
const TARGET_ACTIVITY_DO_SQL_READS_PER_FEED_CONNECT = 1
const TARGET_ACTIVITY_DO_SQL_READS_PER_SESSION_UPDATE = 1
const TARGET_ACTIVITY_DO_SQL_WRITES_PER_SESSION_UPDATE = 1
const TARGET_DIRECTORY_READS_PER_VIEWER_LAUNCH = 2
const TARGET_DIRECTORY_READS_PER_JOIN_GROUP = 1
const TARGET_DIRECTORY_WRITES_PER_SESSION_CREATE = 1
const TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_JOIN = 1
const TARGET_DIRECTORY_WRITES_PER_OPEN_LOBBY_MUTATION = 1
const TARGET_DIRECTORY_WRITES_PER_DRAFT_START = 1
const TARGET_DIRECTORY_WRITES_PER_REPORT = 1
const TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_REPORT_CLEANUP = 1
const LEADERBOARD_CRON_RUNS_PER_DAY = 24 * 60 / 2
const INACTIVE_LOBBY_CLEANUP_CRON_RUNS_PER_DAY = 24
const RANKED_ROLE_CRON_RUNS_PER_DAY = 1

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
const PAID_SIX_DOLLAR_TARGET_MONTHLY_PRICE_USD = 6
const PAID_TARGET_MONTHLY_PRICE_USD = 10
const PAID_SIX_DOLLAR_EXTRA_OVERAGE_BUDGET_USD = PAID_SIX_DOLLAR_TARGET_MONTHLY_PRICE_USD - PAID_BASE_MONTHLY_PRICE_USD
const PAID_EXTRA_OVERAGE_BUDGET_USD = PAID_TARGET_MONTHLY_PRICE_USD - PAID_BASE_MONTHLY_PRICE_USD

const DAYS_PER_MONTH = 30
const SHOULD_PRINT_REPORT = Bun.env.CIVUP_CAPACITY_REPORT === '1'
const CAPACITY_STABILITY_SAMPLES = 3
const CAPACITY_SNAPSHOT_FILE = new URL('./capacity.snapshot.json', import.meta.url)
const CAPACITY_SNAPSHOT_PATH = 'tests/load/capacity.snapshot.json'
const NOW = 1_700_000_000_000

describe('capacity models', () => {
  test('prints current ranked lifecycle capacity projections', { timeout: 20_000 }, async () => {
    const leaderboardCronRunUsage = await measureStableValue(CAPACITY_STABILITY_SAMPLES, measureLeaderboardCronRunUsage)
    const inactiveLobbyCleanupCronRunUsage = await measureStableValue(CAPACITY_STABILITY_SAMPLES, measureInactiveLobbyCleanupCronRunUsage)
    const rankedRoleCronRunUsage = await measureStableValue(CAPACITY_STABILITY_SAMPLES, measureRankedRoleCronRunUsage)
    const leaderboardCronBackgroundUsage = multiplyUsage(leaderboardCronRunUsage, LEADERBOARD_CRON_RUNS_PER_DAY)
    const inactiveLobbyCleanupBackgroundUsage = multiplyUsage(inactiveLobbyCleanupCronRunUsage, INACTIVE_LOBBY_CLEANUP_CRON_RUNS_PER_DAY)
    const rankedRoleCronBackgroundUsage = multiplyUsage(rankedRoleCronRunUsage, RANKED_ROLE_CRON_RUNS_PER_DAY)
    const currentBackgroundCronUsage = addUsage(
      addUsage(leaderboardCronBackgroundUsage, inactiveLobbyCleanupBackgroundUsage),
      rankedRoleCronBackgroundUsage,
    )
    const backgroundCronUsage = projectBackgroundUsageToTargetArchitecture(currentBackgroundCronUsage)
    const reports: ScenarioReport[] = []
    for (const mode of CAPACITY_SCENARIOS) {
      reports.push(await buildScenarioReport(mode, backgroundCronUsage))
    }

    const snapshotStatus = await writeCapacitySnapshot(reports)

    if (SHOULD_PRINT_REPORT) printReports(reports)
    if (SHOULD_PRINT_REPORT) console.log(`\n[capacity] snapshot ${snapshotStatus}: ${CAPACITY_SNAPSHOT_PATH}`)

    expect(reports).toHaveLength(CAPACITY_SCENARIOS.length)
    for (const report of reports) {
      expect(report.model.perDraft.workersRequests).toBeGreaterThan(0)
      expect(report.model.perDraft.d1RowsWritten).toBeGreaterThan(0)
      expect(report.draftRoomIncomingMessagesWithSelectionPreviews).toBeGreaterThanOrEqual(report.draftRoomIncomingMessages)
      expect(report.draftRoomIncomingMessagesWithTeamPickPreviews).toBe(report.draftRoomIncomingMessagesWithSelectionPreviews)
      expect(report.model.backgroundDaily?.kvLists ?? 0).toBe(0)
      if (report.mode.id === 'duel-ranked') expect(report.freeCapacityPlaysPerDay / scenarioPlayersPerDraft(report.mode)).toBeGreaterThanOrEqual(1_000)
      expect(report.freeCapacityPlaysPerDay).toBeGreaterThan(0)
      expect(report.paidIncludedCapacityPlaysPerDay).toBeGreaterThan(0)
      expect(report.paidSixDollarCapacityPlaysPerDay).toBeGreaterThanOrEqual(report.paidIncludedCapacityPlaysPerDay)
      expect(report.paidSixDollarOverageUsd).toBeLessThanOrEqual(PAID_SIX_DOLLAR_EXTRA_OVERAGE_BUDGET_USD)
      expect(report.paidTenDollarCapacityPlaysPerDay).toBeGreaterThanOrEqual(report.paidIncludedCapacityPlaysPerDay)
      expect(report.paidTenDollarOverageUsd).toBeLessThanOrEqual(PAID_EXTRA_OVERAGE_BUDGET_USD)
    }
  })
})

async function buildScenarioReport(
  mode: CapacityScenario,
  leaderboardCronBackgroundUsage: DailyUsage,
): Promise<ScenarioReport> {
  const coreBaseline = await measureStableValue(CAPACITY_STABILITY_SAMPLES, () => simulateScenarioLifecycle({
    mode,
    backgroundRatedPlayers: 0,
    includeOpenLobbyChurn: false,
  }))
  const baseline = await measureStableValue(CAPACITY_STABILITY_SAMPLES, () => simulateScenarioLifecycle({
    mode,
    backgroundRatedPlayers: 0,
    includeOpenLobbyChurn: true,
  }))
  const modeledCurrentBaseline = await applyTeamSwapBlend(mode, baseline, {
    backgroundRatedPlayers: 0,
    includeOpenLobbyChurn: true,
  })
  const withOneBackgroundPlayer = await measureStableValue(CAPACITY_STABILITY_SAMPLES, () => simulateScenarioLifecycle({
    mode,
    backgroundRatedPlayers: 1,
    includeOpenLobbyChurn: true,
  }))
  const modeledCurrentWithOneBackgroundPlayer = await applyTeamSwapBlend(mode, withOneBackgroundPlayer, {
    backgroundRatedPlayers: 1,
    includeOpenLobbyChurn: true,
  })
  const projectedCoreBaseline = projectSimulationResultToTargetArchitecture(mode, coreBaseline)
  const projectedBaseline = projectSimulationResultToTargetArchitecture(mode, baseline)
  const modeledBaseline = projectSimulationResultToTargetArchitecture(mode, modeledCurrentBaseline)
  const modeledWithOneBackgroundPlayer = projectSimulationResultToTargetArchitecture(mode, modeledCurrentWithOneBackgroundPlayer)
  const openLobbyChurnPerDraft = subtractUsage(projectedBaseline.usage, projectedCoreBaseline.usage)
  const corePerDraft = subtractUsage(modeledBaseline.usage, openLobbyChurnPerDraft)

  const model: CapacityModel = {
    perDraft: {
      workersRequests: modeledBaseline.usage.workersRequests,
      botWorkerRequests: modeledBaseline.usage.botWorkerRequests,
      activityWorkerRequests: modeledBaseline.usage.activityWorkerRequests,
      d1RowsReadBase: modeledBaseline.usage.d1RowsRead,
      d1RowsReadPerLeaderboardPlayer: modeledWithOneBackgroundPlayer.usage.d1RowsRead - modeledBaseline.usage.d1RowsRead,
      d1RowsWritten: modeledBaseline.usage.d1RowsWritten,
      doSqliteRowsRead: modeledBaseline.usage.doSqliteRowsRead,
      doSqliteRowsWritten: modeledBaseline.usage.doSqliteRowsWritten,
      kvReads: modeledBaseline.usage.kvReads,
      kvWrites: modeledBaseline.usage.kvWrites,
      kvDeletes: modeledBaseline.usage.kvDeletes,
      kvLists: modeledBaseline.usage.kvLists,
      doRequests: modeledBaseline.usage.doRequests,
      doRequestsRaw: modeledBaseline.usage.doRequestsRaw,
      doDurationGbSeconds: modeledBaseline.usage.doDurationGbSeconds,
    },
    backgroundDaily: leaderboardCronBackgroundUsage,
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
  const paidSixDollarCapacityPlaysPerDay = findMaxPlaysPerDayForOverageBudget({
    model,
    limits: PAID_MONTHLY_LIMITS,
    periodDays: DAYS_PER_MONTH,
    playersPerDraft,
    overageRatesPerMillion: PAID_OVERAGE_RATES_PER_MILLION,
    overageBudgetUsd: PAID_SIX_DOLLAR_EXTRA_OVERAGE_BUDGET_USD,
  })
  const paidSixDollarOverageUsd = estimateOverageUsd({
    model,
    playsPerDay: paidSixDollarCapacityPlaysPerDay,
    limits: PAID_MONTHLY_LIMITS,
    periodDays: DAYS_PER_MONTH,
    playersPerDraft,
    overageRatesPerMillion: PAID_OVERAGE_RATES_PER_MILLION,
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
    corePerDraft,
    openLobbyChurnPerDraft,
    draftRoomIncomingMessages: modeledBaseline.draftRoomIncomingMessages,
    draftRoomIncomingMessagesWithSelectionPreviews: modeledBaseline.draftRoomIncomingMessagesWithSelectionPreviews,
    draftRoomIncomingMessagesWithTeamPickPreviews: modeledBaseline.draftRoomIncomingMessagesWithTeamPickPreviews,
    openLobbyMutationRequests: modeledBaseline.openLobbyMutationRequests,
    selectedLobbyPushUpdates: modeledBaseline.selectedLobbyPushUpdates,
    freeCapacityPlaysPerDay,
    paidIncludedCapacityPlaysPerDay,
    paidSixDollarCapacityPlaysPerDay,
    paidSixDollarOverageUsd,
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

async function measureLeaderboardCronRunUsage(): Promise<DailyUsage> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

  try {
    resetOperations()
    sqlTracker.reset()

    await refreshDirtyLeaderboards(db, kv, 'token')

    const kvReads = operations.filter(op => op.type === 'get').length
    const kvWrites = operations.filter(op => op.type === 'put').length
    const kvDeletes = operations.filter(op => op.type === 'delete').length
    const kvLists = operations.filter(op => op.type === 'list').length
    const doRequests = 0

    return {
      workersRequests: 1,
      botWorkerRequests: 1,
      activityWorkerRequests: 0,
      d1RowsRead: sqlTracker.counts.rowsRead,
      d1RowsWritten: sqlTracker.counts.rowsWritten,
      doSqliteRowsRead: 0,
      doSqliteRowsWritten: 0,
      kvReads,
      kvWrites,
      kvDeletes,
      kvLists,
      doRequests,
      doRequestsRaw: doRequests,
      doDurationGbSeconds: estimateDoDurationGbSeconds(doRequests),
    }
  }
  finally {
    sqlTracker.restore()
    sqlite.close()
  }
}

async function measureInactiveLobbyCleanupCronRunUsage(): Promise<DailyUsage> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

  try {
    resetOperations()
    sqlTracker.reset()

    await pruneInactiveOpenLobbies(kv, 'token')
    await pruneAbandonedMatches(db, kv)

    const kvReads = operations.filter(op => op.type === 'get').length
    const kvWrites = operations.filter(op => op.type === 'put').length
    const kvDeletes = operations.filter(op => op.type === 'delete').length
    const kvLists = operations.filter(op => op.type === 'list').length
    const doRequests = 0

    return {
      workersRequests: 1,
      botWorkerRequests: 1,
      activityWorkerRequests: 0,
      d1RowsRead: sqlTracker.counts.rowsRead,
      d1RowsWritten: sqlTracker.counts.rowsWritten,
      doSqliteRowsRead: 0,
      doSqliteRowsWritten: 0,
      kvReads,
      kvWrites,
      kvDeletes,
      kvLists,
      doRequests,
      doRequestsRaw: doRequests,
      doDurationGbSeconds: estimateDoDurationGbSeconds(doRequests),
    }
  }
  finally {
    sqlTracker.restore()
    sqlite.close()
  }
}

async function measureRankedRoleCronRunUsage(): Promise<DailyUsage> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

  try {
    await seedRankedRoleCronState(db, kv)

    await syncRankedRoles({
      db,
      kv,
      guildId: GUILD_ID,
      token: 'token',
      applyDiscord: true,
      advanceDemotionWindow: true,
      now: NOW,
    })

    resetOperations()
    sqlTracker.reset()

    const guildIds = await listRankedRoleConfigGuildIds(kv)
    for (const guildId of guildIds) {
      await syncRankedRoles({
        db,
        kv,
        guildId,
        token: 'token',
        applyDiscord: true,
        advanceDemotionWindow: true,
      })
    }
    if (await getRankedRolesDirtyState(kv)) await clearRankedRolesDirtyState(kv)

    const kvReads = operations.filter(op => op.type === 'get').length
    const kvWrites = operations.filter(op => op.type === 'put').length
    const kvDeletes = operations.filter(op => op.type === 'delete').length
    const kvLists = operations.filter(op => op.type === 'list').length
    const doRequests = 0

    return {
      workersRequests: 1,
      botWorkerRequests: 1,
      activityWorkerRequests: 0,
      d1RowsRead: sqlTracker.counts.rowsRead,
      d1RowsWritten: sqlTracker.counts.rowsWritten,
      doSqliteRowsRead: 0,
      doSqliteRowsWritten: 0,
      kvReads,
      kvWrites,
      kvDeletes,
      kvLists,
      doRequests,
      doRequestsRaw: doRequests,
      doDurationGbSeconds: estimateDoDurationGbSeconds(doRequests),
    }
  }
  finally {
    sqlTracker.restore()
    sqlite.close()
  }
}

async function seedRankedRoleCronState(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
): Promise<void> {
  const playerIds = Array.from({ length: 8 }, (_value, index) => `ranked-role-cron-${index + 1}`)

  await setRankedRoleCurrentRoles(kv, GUILD_ID, {
    tier5: '11111111111111111',
    tier4: '22222222222222222',
    tier3: '33333333333333333',
    tier2: '44444444444444444',
    tier1: '55555555555555555',
  })

  await db.insert(players).values(playerIds.map((playerId, index) => ({
    id: playerId,
    displayName: playerId.toUpperCase(),
    avatarUrl: null,
    createdAt: NOW + index,
  })))

  await db.insert(playerRatings).values(playerIds.map((playerId, index) => ({
    playerId,
    mode: 'ffa',
    mu: 40 - index,
    sigma: 6,
    gamesPlayed: 10,
    wins: Math.max(0, 6 - (index % 4)),
    lastPlayedAt: NOW + 10_000 + index,
  })))
}

async function simulateScenarioLifecycle(input: {
  mode: CapacityScenario
  backgroundRatedPlayers: number
  includeOpenLobbyChurn: boolean
  acceptedSwaps?: number
}): Promise<SimulationResult> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv, operations, resetOperations, runWithoutTracking: runKvWithoutTracking } = createTrackedKv({ trackReads: true })

  let botRequests = 0
  let activityRequests = 0

  try {
    await setSystemChannel(kv, 'draft', CHANNEL_ID)
    await setSystemChannel(kv, 'archive', 'channel-archive')
    await setSystemChannel(kv, 'leaderboard', 'channel-leaderboard')
    await startSeason(db, { now: NOW, kv })
    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedRatedPlayers(db, input.mode, input.backgroundRatedPlayers)
    await ensureLeaderboardModeSnapshots(db, kv)
    await syncRankedRoles({ db, kv, guildId: GUILD_ID, now: NOW + 1_000 })
    await markRankedRolesDirty(kv, 'steady-state-preexisting-dirty-flag')

    resetOperations()
    sqlTracker.reset()

    const runUnmetered = async <T>(callback: () => Promise<T>): Promise<T> =>
      runKvWithoutTracking(() =>
        sqlTracker.runWithoutTracking(callback),
      )

    botRequests += 1
    await simulateMatchCreate(db, kv, input.mode)
    const queuedPlayerIds = [HOST_ID]
    await runUnmetered(() => assertOpenCapacityState(db, kv, input.mode.mode, queuedPlayerIds))

    for (const group of input.mode.joinGroups) {
      botRequests += 1
      await simulateMatchJoin(db, kv, input.mode, group)
      queuedPlayerIds.push(...group)
      await runUnmetered(() => assertOpenCapacityState(db, kv, input.mode.mode, queuedPlayerIds))
    }

    const playerIds = scenarioPlayerIds(input.mode)
    const viewerIds = scenarioViewerIds(input.mode)
    activityRequests += viewerIds.length
    for (const playerId of viewerIds) {
      botRequests += 1
      await simulateActivityLaunchSnapshot(db, kv, ACTIVITY_SECRET, CHANNEL_ID, playerId)
    }

    // Each viewer opens the bot-owned Activity feed through the activity proxy.
    activityRequests += viewerIds.length

    const spectatorIds = input.mode.spectatorIds ?? []
    activityRequests += spectatorIds.length
    for (const spectatorId of spectatorIds) {
      botRequests += 1
      await simulateSpectatorLobbySelection(kv, input.mode, spectatorId)
    }

    const openLobbyMutationRequests = input.includeOpenLobbyChurn
      ? await simulateOpenLobbyChurn(kv, input.mode)
      : 0
    activityRequests += openLobbyMutationRequests
    botRequests += openLobbyMutationRequests
    const selectedLobbyPushUpdates = viewerIds.length * openLobbyMutationRequests
    await runUnmetered(() => assertOpenCapacityState(db, kv, input.mode.mode, scenarioPlayerIds(input.mode)))

    activityRequests += 1
    botRequests += 1
    const started = await startDraftFromOpenLobby(db, kv, input.mode)
    await runUnmetered(() => assertDraftingCapacityState(db, kv, input.mode.mode, started.matchId, playerIds))
    let completedDraftState = started.completedDraftState
    let draftRoomIncomingMessages = started.draftRoomIncomingMessages
    let draftRoomIncomingMessagesWithSelectionPreviews = started.draftRoomIncomingMessagesWithSelectionPreviews
    let draftRoomIncomingMessagesWithTeamPickPreviews = started.draftRoomIncomingMessagesWithTeamPickPreviews

    botRequests += 1
    await handleDraftCompleteLifecycleSync(db, kv, started.matchId, completedDraftState)
    await runUnmetered(() => assertActiveCapacityState(db, kv, started.matchId, playerIds))

    const acceptedSwaps = isTeamMode(input.mode.mode) ? Math.max(0, Math.trunc(input.acceptedSwaps ?? 0)) : 0
    for (let index = 0; index < acceptedSwaps; index++) {
      completedDraftState = applyAcceptedTeamSwap(completedDraftState)
      botRequests += 1
      await handleDraftCompleteLifecycleSync(db, kv, started.matchId, completedDraftState)
      await runUnmetered(() => assertActiveCapacityState(db, kv, started.matchId, playerIds))
      draftRoomIncomingMessages += ACCEPTED_SWAP_DRAFT_ROOM_INCOMING_MESSAGES
      draftRoomIncomingMessagesWithSelectionPreviews += ACCEPTED_SWAP_DRAFT_ROOM_INCOMING_MESSAGES
      draftRoomIncomingMessagesWithTeamPickPreviews += ACCEPTED_SWAP_DRAFT_ROOM_INCOMING_MESSAGES
    }

    if (isTeamMode(input.mode.mode)) {
      botRequests += 1
      await handleDraftCompleteLifecycleSync(db, kv, started.matchId, completedDraftState, { finalized: true })
      await runUnmetered(() => assertActiveCapacityState(db, kv, started.matchId, playerIds))
    }

    // Each viewer reconnects through the activity proxy to the draft room after match handoff.
    activityRequests += viewerIds.length

    for (let index = 0; index < playerIds.length; index++) {
      activityRequests += 1
      botRequests += 1
      await fetchMatchStateSnapshot(db, started.matchId)
    }

    activityRequests += 1
    botRequests += 1
    await handleMatchReport(db, kv, input.mode, started.matchId)
    await runUnmetered(() => assertCompletedCapacityState(db, kv, started.matchId, playerIds))

    const kvReads = operations.filter(op => op.type === 'get').length
    const kvWrites = operations.filter(op => op.type === 'put').length
    const kvDeletes = operations.filter(op => op.type === 'delete').length
    const kvLists = operations.filter(op => op.type === 'list').length
    const doRequestsRaw = estimateDoRawRequests({
      viewerCount: viewerIds.length,
      draftRoomIncomingMessages,
      lobbyWatchIncomingMessagesPerConnection: LOBBY_WATCH_INCOMING_MESSAGES_PER_CONNECTION,
    })
    const doRequests = estimateDoBilledRequestUnits({
      viewerCount: viewerIds.length,
      draftRoomIncomingMessages,
      lobbyWatchIncomingMessagesPerConnection: LOBBY_WATCH_INCOMING_MESSAGES_PER_CONNECTION,
    })

    return {
      draftRoomIncomingMessages,
      draftRoomIncomingMessagesWithSelectionPreviews,
      draftRoomIncomingMessagesWithTeamPickPreviews,
      openLobbyMutationRequests,
      selectedLobbyPushUpdates,
      usage: {
        workersRequests: botRequests + activityRequests,
        botWorkerRequests: botRequests,
        activityWorkerRequests: activityRequests,
        d1RowsRead: sqlTracker.counts.rowsRead,
        d1RowsWritten: sqlTracker.counts.rowsWritten,
        doSqliteRowsRead: 0,
        doSqliteRowsWritten: 0,
        kvReads,
        kvWrites,
        kvDeletes,
        kvLists,
        doRequests,
        doRequestsRaw,
        doDurationGbSeconds: estimateDoDurationGbSeconds(doRequestsRaw),
      },
    }
  }
  finally {
    sqlTracker.restore()
    sqlite.close()
  }
}

async function simulateMatchCreate(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: CapacityScenario,
): Promise<void> {
  const draftChannelId = await getSystemChannel(kv, 'draft')
  if (!draftChannelId) throw new Error('Expected draft channel to be configured')

  await getOpenSessionLobbyProjectionHostedBy(db, HOST_ID)
  await findBlockingDraftMatchIdsForPlayers(db, [HOST_ID])

  const hostEntry = buildQueueEntry(HOST_ID, 1)

  const lobby = await createLobby(kv, {
    mode: mode.mode,
    guildId: GUILD_ID,
    hostId: HOST_ID,
    channelId: draftChannelId,
    messageId: `message-lobby-open-${mode.id}`,
    queueEntries: [hostEntry],
    db,
  })
}

async function simulateMatchJoin(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: CapacityScenario,
  group: string[],
): Promise<void> {
  const liveMatchIdByPlayer = await findBlockingDraftMatchIdsForPlayers(db, group)
  const runtime = await getTestLobbyRuntime(kv, db)
  const outcome = await joinLobbyAndMaybeStartMatch(
    { env: { DB: runtime.d1, KV: kv, SessionDO: runtime.sessionNamespace } },
    mode.mode,
    buildJoinEntries(group),
    { liveMatchPlayerIds: new Set(liveMatchIdByPlayer.keys()) },
  )
  if ('error' in outcome) throw new Error(outcome.error)

}

async function simulateActivityLaunchSnapshot(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  activitySecret: string,
  channelId: string,
  userId: string,
): Promise<void> {
  const runtime = await getTestLobbyRuntime(kv, db)
  await buildActivityLaunchSnapshot(undefined, activitySecret, kv, channelId, userId, {
    db: runtime.d1,
    sessionNamespace: runtime.sessionNamespace,
  })
}

async function simulateSpectatorLobbySelection(kv: KVNamespace, mode: CapacityScenario, spectatorId: string): Promise<void> {
  const lobby = await getLobby(kv, mode.mode)
  if (!lobby || lobby.status !== 'open') throw new Error(`Expected open ${mode.mode} lobby before spectator selection`)
  const runtime = await getTestLobbyRuntime(kv)
  const result = await selectActivityTargetForUser(undefined, undefined, kv, lobby.channelId, spectatorId, { kind: 'lobby', id: lobby.id }, {
    db: runtime.d1,
    sessionNamespace: runtime.sessionNamespace,
  })
  if (!result.ok) throw new Error(result.error)
}

async function simulateOpenLobbyChurn(kv: KVNamespace, mode: CapacityScenario): Promise<number> {
  let botRequests = 0

  botRequests += 1
  await simulateOpenLobbyConfigEdit(kv, mode)

  botRequests += 1
  await simulateOpenLobbyConfigEdit(kv, mode)

  return botRequests
}

async function simulateOpenLobbyConfigEdit(kv: KVNamespace, mode: CapacityScenario): Promise<void> {
  const lobby = await getLobby(kv, mode.mode)
  if (!lobby || lobby.status !== 'open') throw new Error(`Expected open ${mode.mode} lobby before config edit`)

  const updatedLobby = await setLobbyDraftConfig(kv, lobby.id, {
    ...lobby.draftConfig,
    banTimerSeconds: (lobby.draftConfig.banTimerSeconds ?? 30) + 1,
  }, lobby) ?? lobby

  const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode.mode, updatedLobby.draftConfig.redDeath)
  const queueEntries = filterQueueEntriesForLobby(updatedLobby, [])
  const slots = normalizeLobbySlots(mode.mode, updatedLobby.slots, queueEntries)
  await syncLobbyDerivedState(kv, updatedLobby, { queueEntries, slots, balanceSnapshot })
}

async function assertOpenCapacityState(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: GameMode,
  expectedPlayerIds: string[],
): Promise<void> {
  const lobby = await getLobby(kv, mode)

  expect(lobby).not.toBeNull()
  if (!lobby) throw new Error(`Expected open ${mode} lobby during capacity simulation`)

  expect(lobby.status).toBe('open')
  expect(lobby.memberPlayerIds).toEqual(expectedPlayerIds)
  expect(new Set(lobby.memberPlayerIds).size).toBe(lobby.memberPlayerIds.length)
  expect(normalizeLobbySlots(mode, lobby.slots, filterQueueEntriesForLobby(lobby, []))).toEqual(lobby.slots)

  for (const playerId of expectedPlayerIds) {
    expect(await getLobbyForUser(db, playerId)).toBe(lobby.id)
    expect(await getMatchForUser(db, playerId)).toBeNull()
  }
}

async function assertDraftingCapacityState(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: GameMode,
  matchId: string,
  expectedPlayerIds: string[],
): Promise<void> {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  const lobby = await getSessionLobbyProjectionByMatch(db, matchId)

  expect(match?.status).toBe('drafting')
  expect(participants.map(participant => participant.playerId)).toEqual(expectedPlayerIds)
  expect(lobby?.status).toBe('drafting')

  for (const playerId of expectedPlayerIds) {
    expect(await getLobbyForUser(db, playerId)).toBeNull()
    expect(await getMatchForUser(db, playerId)).toBe(matchId)
  }
}

async function assertActiveCapacityState(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  matchId: string,
  expectedPlayerIds: string[],
): Promise<void> {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  const lobby = await getSessionLobbyProjectionByMatch(db, matchId)

  expect(match?.status).toBe('active')
  expect(participants.map(participant => participant.playerId)).toEqual(expectedPlayerIds)
  expect(participants.every(participant => participant.civId != null)).toBe(true)
  expect(lobby?.status).toBe('active')

  for (const playerId of expectedPlayerIds) {
    expect(await getLobbyForUser(db, playerId)).toBeNull()
    expect(await getMatchForUser(db, playerId)).toBe(matchId)
  }
}

async function assertCompletedCapacityState(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  matchId: string,
  expectedPlayerIds: string[],
): Promise<void> {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))

  expect(match?.status).toBe('completed')
  expect(participants.map(participant => participant.playerId)).toEqual(expectedPlayerIds)
  expect(participants.every(participant => participant.civId != null && participant.placement != null)).toBe(true)
  expect((await getLobbyById(kv, matchId))?.status).toBe('completed')

  for (const playerId of expectedPlayerIds) {
    expect(await getLobbyForUser(db, playerId)).toBeNull()
    expect(await getMatchForUser(db, playerId)).toBeNull()
  }
}

async function startDraftFromOpenLobby(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  mode: CapacityScenario,
): Promise<{
  matchId: string
  completedDraftState: DraftState
  draftRoomIncomingMessages: number
  draftRoomIncomingMessagesWithSelectionPreviews: number
  draftRoomIncomingMessagesWithTeamPickPreviews: number
}> {
  const lobby = await getLobby(kv, mode.mode)
  if (!lobby || lobby.status !== 'open') throw new Error(`Expected open ${mode.mode} lobby before start`)

  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, [])
  const slots = normalizeLobbySlots(mode.mode, lobby.slots, lobbyQueueEntries)
  const slottedEntries = mapLobbySlotsToEntries(slots, lobbyQueueEntries)
  const selectedEntries = slottedEntries.filter((entry): entry is Exclude<(typeof slottedEntries)[number], null> => entry !== null)

  await resolveDraftTimerConfig(kv, lobby.draftConfig)

  const matchId = lobby.id
  const seats = buildDraftSeats(mode.mode, slottedEntries)
  if (selectedEntries.length !== seats.length) throw new Error('Seat count did not match selected entries')

  const slottedLobby = await setLobbySlots(kv, lobby.id, slots, lobby) ?? { ...lobby, slots }
  const draftingLobby = await startTestSessionDraft(kv, lobby.id, slottedLobby, { db })
  if (!draftingLobby) throw new Error('Expected lobby to transition to drafting during capacity simulation')
  await syncLobbyDerivedState(kv, draftingLobby)
  await storeMatchMessageMapping(db, `message-lobby-drafting-${mode.id}`, matchId)

  const completedDraft = buildCompletedDraftState(matchId, mode.mode, seats)
  return {
    matchId,
    completedDraftState: completedDraft.state,
    draftRoomIncomingMessages: completedDraft.inputCount,
    draftRoomIncomingMessagesWithSelectionPreviews: completedDraft.inputCountWithSelectionPreviews,
    draftRoomIncomingMessagesWithTeamPickPreviews: completedDraft.inputCountWithTeamPickPreviews,
  }
}

async function handleDraftCompleteLifecycleSync(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  matchId: string,
  state: DraftState,
  options: {
    finalized?: boolean
  } = {},
): Promise<void> {
  const activated = await activateDraftMatch(db, {
    state,
    completedAt: NOW + 5_000,
    hostId: state.seats[0]?.playerId ?? HOST_ID,
  })
  if ('error' in activated) throw new Error(activated.error)
  if (activated.alreadyActive && options.finalized !== true) return

  const lobby = await getLobbyById(kv, matchId)
  if (!lobby) throw new Error('Expected lobby mapping during draft-complete simulation')

  if (activated.alreadyActive && options.finalized === true) {
    await storeMatchMessageMapping(db, `message-lobby-finalized-${matchId}`, matchId)
    return
  }

  const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', lobby) ?? lobby
  await syncLobbyDerivedState(kv, activeLobby)
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
  const runtime = await getTestLobbyRuntime(kv, db)
  const reported = await reportMatch(db, kv, {
    matchId,
    reporterId: HOST_ID,
    placements: buildPlacements(mode),
  }, { sessionNamespace: runtime.sessionNamespace })
  if ('error' in reported) throw new Error(reported.error)

  const lobby = await getSessionLobbyProjectionByMatch(db, matchId)
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
    await storeMatchMessageMapping(db, `message-lobby-reported-${mode.id}`, matchId)
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
): {
  state: DraftState
  inputCount: number
  inputCountWithSelectionPreviews: number
  inputCountWithTeamPickPreviews: number
} {
  const format = getDefaultFormat(mode)
  let state = createDraft(matchId, format, seats, allLeaderIds)
  let inputCount = 0
  let selectionPreviewInputCount = 0

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
        selectionPreviewInputCount += 1
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

      selectionPreviewInputCount += 1
      state = applyDraftInput(state, { type: 'PICK', seatIndex, civId }, format.blindBans)
      inputCount += 1
      if (state.status === 'complete' || state.currentStepIndex !== currentStepIndex) break
    }
  }

  return {
    state,
    inputCount,
    inputCountWithSelectionPreviews: inputCount + selectionPreviewInputCount,
    inputCountWithTeamPickPreviews: inputCount + selectionPreviewInputCount,
  }
}

async function applyTeamSwapBlend(
  mode: CapacityScenario,
  base: SimulationResult,
  input: {
    backgroundRatedPlayers: number
    includeOpenLobbyChurn: boolean
  },
): Promise<SimulationResult> {
  if (!isTeamMode(mode.mode) || AVERAGE_ACCEPTED_SWAPS_PER_TEAM_DRAFT <= 0) return base

  const withAcceptedSwap = await measureStableValue(CAPACITY_STABILITY_SAMPLES, () => simulateScenarioLifecycle({
    mode,
    backgroundRatedPlayers: input.backgroundRatedPlayers,
    includeOpenLobbyChurn: input.includeOpenLobbyChurn,
    acceptedSwaps: 1,
  }))

  return blendSimulationResult(base, withAcceptedSwap, AVERAGE_ACCEPTED_SWAPS_PER_TEAM_DRAFT)
}

function blendSimulationResult(
  base: SimulationResult,
  withAcceptedSwap: SimulationResult,
  acceptedSwapRate: number,
): SimulationResult {
  return {
    usage: blendUsageSample(base.usage, withAcceptedSwap.usage, acceptedSwapRate),
    draftRoomIncomingMessages: blendMetric(base.draftRoomIncomingMessages, withAcceptedSwap.draftRoomIncomingMessages, acceptedSwapRate),
    draftRoomIncomingMessagesWithSelectionPreviews: blendMetric(base.draftRoomIncomingMessagesWithSelectionPreviews, withAcceptedSwap.draftRoomIncomingMessagesWithSelectionPreviews, acceptedSwapRate),
    draftRoomIncomingMessagesWithTeamPickPreviews: blendMetric(base.draftRoomIncomingMessagesWithTeamPickPreviews, withAcceptedSwap.draftRoomIncomingMessagesWithTeamPickPreviews, acceptedSwapRate),
    openLobbyMutationRequests: blendMetric(base.openLobbyMutationRequests, withAcceptedSwap.openLobbyMutationRequests, acceptedSwapRate),
    selectedLobbyPushUpdates: blendMetric(base.selectedLobbyPushUpdates, withAcceptedSwap.selectedLobbyPushUpdates, acceptedSwapRate),
  }
}

function blendUsageSample(base: UsageSample, withAcceptedSwap: UsageSample, acceptedSwapRate: number): UsageSample {
  return {
    workersRequests: blendMetric(base.workersRequests, withAcceptedSwap.workersRequests, acceptedSwapRate),
    botWorkerRequests: blendMetric(base.botWorkerRequests, withAcceptedSwap.botWorkerRequests, acceptedSwapRate),
    activityWorkerRequests: blendMetric(base.activityWorkerRequests, withAcceptedSwap.activityWorkerRequests, acceptedSwapRate),
    d1RowsRead: blendMetric(base.d1RowsRead, withAcceptedSwap.d1RowsRead, acceptedSwapRate),
    d1RowsWritten: blendMetric(base.d1RowsWritten, withAcceptedSwap.d1RowsWritten, acceptedSwapRate),
    doSqliteRowsRead: blendMetric(base.doSqliteRowsRead, withAcceptedSwap.doSqliteRowsRead, acceptedSwapRate),
    doSqliteRowsWritten: blendMetric(base.doSqliteRowsWritten, withAcceptedSwap.doSqliteRowsWritten, acceptedSwapRate),
    kvReads: blendMetric(base.kvReads, withAcceptedSwap.kvReads, acceptedSwapRate),
    kvWrites: blendMetric(base.kvWrites, withAcceptedSwap.kvWrites, acceptedSwapRate),
    kvDeletes: blendMetric(base.kvDeletes, withAcceptedSwap.kvDeletes, acceptedSwapRate),
    kvLists: blendMetric(base.kvLists, withAcceptedSwap.kvLists, acceptedSwapRate),
    doRequests: blendMetric(base.doRequests, withAcceptedSwap.doRequests, acceptedSwapRate),
    doRequestsRaw: blendMetric(base.doRequestsRaw, withAcceptedSwap.doRequestsRaw, acceptedSwapRate),
    doDurationGbSeconds: blendMetric(base.doDurationGbSeconds, withAcceptedSwap.doDurationGbSeconds, acceptedSwapRate),
  }
}

function blendMetric(base: number, withAcceptedSwap: number, acceptedSwapRate: number): number {
  return roundSnapshotNumber(base + (withAcceptedSwap - base) * acceptedSwapRate)
}

function projectBackgroundUsageToTargetArchitecture(current: DailyUsage): DailyUsage {
  return {
    ...current,
    workersRequests: current.botWorkerRequests + current.activityWorkerRequests,
    doSqliteRowsRead: 0,
    doSqliteRowsWritten: 0,
    kvDeletes: 0,
    kvLists: 0,
    doRequests: 0,
    doRequestsRaw: 0,
    doDurationGbSeconds: 0,
  }
}

function projectSimulationResultToTargetArchitecture(
  mode: CapacityScenario,
  current: SimulationResult,
): SimulationResult {
  const playerCount = scenarioPlayersPerDraft(mode)
  const viewerCount = scenarioViewerIds(mode).length
  const spectatorCount = mode.spectatorIds?.length ?? 0
  const averageAcceptedSwaps = isTeamMode(mode.mode) ? AVERAGE_ACCEPTED_SWAPS_PER_TEAM_DRAFT : 0
  const lifecycleSyncBotRequests = 1 + averageAcceptedSwaps + (isTeamMode(mode.mode) ? 1 : 0)
  const sessionCommandRequests = estimateTargetSessionCommandRequests(mode, current.openLobbyMutationRequests)
  const activityFeedSessionUpdates = sessionCommandRequests + lifecycleSyncBotRequests
  const activityFeedConnections = viewerCount
  const removedBotRequests = lifecycleSyncBotRequests + playerCount + spectatorCount
  const removedActivityRequests = viewerCount + viewerCount + playerCount + spectatorCount
  const removedPostDraftSnapshotRowsRead = playerCount * (1 + playerCount)

  const botWorkerRequests = Math.max(0, roundSnapshotNumber(current.usage.botWorkerRequests - removedBotRequests))
  const activityWorkerRequests = Math.max(0, roundSnapshotNumber(current.usage.activityWorkerRequests - removedActivityRequests))
  const sessionSocketConnections = viewerCount * TARGET_SESSION_SOCKET_CONNECTIONS_PER_VIEWER
  const doRequestsRaw = sessionCommandRequests + sessionSocketConnections + current.draftRoomIncomingMessages + activityFeedSessionUpdates + activityFeedConnections
  const doRequests = sessionCommandRequests
    + sessionSocketConnections
    + Math.ceil(current.draftRoomIncomingMessages / DO_WEBSOCKET_BILLING_RATIO)
    + activityFeedSessionUpdates
    + activityFeedConnections

  return {
    ...current,
    usage: {
      workersRequests: botWorkerRequests + activityWorkerRequests,
      botWorkerRequests,
      activityWorkerRequests,
      d1RowsRead: Math.max(0, roundSnapshotNumber(
        current.usage.d1RowsRead
        - removedPostDraftSnapshotRowsRead
        + viewerCount * TARGET_DIRECTORY_READS_PER_VIEWER_LAUNCH
        + mode.joinGroups.length * TARGET_DIRECTORY_READS_PER_JOIN_GROUP,
      )),
      d1RowsWritten: roundSnapshotNumber(
        current.usage.d1RowsWritten
        + TARGET_DIRECTORY_WRITES_PER_SESSION_CREATE
        + playerCount * TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_JOIN
        + current.openLobbyMutationRequests * TARGET_DIRECTORY_WRITES_PER_OPEN_LOBBY_MUTATION
        + TARGET_DIRECTORY_WRITES_PER_DRAFT_START
        + TARGET_DIRECTORY_WRITES_PER_REPORT
        + playerCount * TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_REPORT_CLEANUP,
      ),
      doSqliteRowsRead: roundSnapshotNumber(
        sessionCommandRequests * TARGET_SESSION_DO_SQL_READS_PER_COMMAND
        + sessionSocketConnections * TARGET_SESSION_DO_SQL_READS_PER_SOCKET_CONNECT
        + current.draftRoomIncomingMessages * TARGET_SESSION_DO_SQL_READS_PER_DRAFT_MESSAGE
        + activityFeedConnections * TARGET_ACTIVITY_DO_SQL_READS_PER_FEED_CONNECT
        + activityFeedSessionUpdates * TARGET_ACTIVITY_DO_SQL_READS_PER_SESSION_UPDATE,
      ),
      doSqliteRowsWritten: roundSnapshotNumber(
        sessionCommandRequests * TARGET_SESSION_DO_SQL_WRITES_PER_COMMAND
        + sessionSocketConnections * TARGET_SESSION_DO_SQL_WRITES_PER_SOCKET_CONNECT
        + current.draftRoomIncomingMessages * TARGET_SESSION_DO_SQL_WRITES_PER_DRAFT_MESSAGE
        + activityFeedSessionUpdates * TARGET_ACTIVITY_DO_SQL_WRITES_PER_SESSION_UPDATE,
      ),
      kvReads: current.usage.kvReads,
      kvWrites: current.usage.kvWrites,
      kvDeletes: 0,
      kvLists: 0,
      doRequests,
      doRequestsRaw,
      doDurationGbSeconds: estimateDoDurationGbSeconds(doRequestsRaw),
    },
  }
}

function estimateTargetSessionCommandRequests(mode: CapacityScenario, openLobbyMutationRequests: number): number {
  return 1
    + mode.joinGroups.length
    + openLobbyMutationRequests
    + 1
    + 1
}

function applyAcceptedTeamSwap(state: DraftState): DraftState {
  const teammateSeatsByTeam = new Map<number, number[]>()
  for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
    const team = state.seats[seatIndex]?.team
    if (team == null) continue
    const seatIndices = teammateSeatsByTeam.get(team) ?? []
    seatIndices.push(seatIndex)
    teammateSeatsByTeam.set(team, seatIndices)
  }

  for (const seatIndices of teammateSeatsByTeam.values()) {
    if (seatIndices.length < 2) continue
    const [fromSeat, toSeat] = seatIndices
    if (fromSeat == null || toSeat == null) continue

    const swappedPicks = swapSeatPicks(state, fromSeat, toSeat)
    if ('error' in swappedPicks) continue

    return {
      ...state,
      picks: swappedPicks,
    }
  }

  throw new Error(`Expected an accepted teammate swap to be available for ${state.matchId}`)
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

function scenarioViewerIds(mode: CapacityScenario): string[] {
  return [...new Set([...scenarioPlayerIds(mode), ...(mode.spectatorIds ?? [])])]
}

function scenarioPlayersPerDraft(mode: CapacityScenario): number {
  return scenarioPlayerIds(mode).length
}

async function measureStableValue<T>(samples: number, measure: () => Promise<T>): Promise<T> {
  const values: T[] = []

  for (let index = 0; index < samples; index++) {
    values.push(await withFixedNow(NOW, measure))
  }

  return medianSampleValue(values)
}

async function withFixedNow<T>(now: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now
  Date.now = () => now

  try {
    return await run()
  }
  finally {
    Date.now = originalNow
  }
}

function medianSampleValue<T>(values: T[]): T {
  const first = values[0]
  if (first == null) throw new Error('Expected at least one capacity measurement sample')

  if (typeof first === 'number') return medianNumber(values as number[]) as T
  if (typeof first === 'object') {
    return Object.fromEntries(
      Object.keys(first as Record<string, unknown>).map(key => [
        key,
        medianSampleValue(values.map(value => (value as Record<string, unknown>)[key]) as T[]),
      ]),
    ) as T
  }

  throw new Error(`Unsupported capacity measurement sample type: ${typeof first}`)
}

function medianNumber(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted[Math.floor(sorted.length / 2)]
  if (middle == null) throw new Error('Expected at least one numeric capacity measurement sample')
  return roundSnapshotNumber(middle)
}

async function writeCapacitySnapshot(reports: ScenarioReport[]): Promise<'updated' | 'unchanged'> {
  const snapshot = buildCapacitySnapshot(reports)
  const nextText = `${JSON.stringify(snapshot, null, 2)}\n`
  const currentText = await readSnapshotText(readFileText)

  if (currentText === nextText) return 'unchanged'

  await writeFileText(CAPACITY_SNAPSHOT_FILE, nextText, 'utf8')
  return 'updated'
}

function buildCapacitySnapshot(reports: ScenarioReport[]): CapacitySnapshot {
  const backgroundDailyUsage = reports[0]?.model.backgroundDaily

  return {
    version: 4,
    globals: {
      stabilitySamples: CAPACITY_STABILITY_SAMPLES,
      leaderboardCronRunsPerDay: LEADERBOARD_CRON_RUNS_PER_DAY,
      inactiveLobbyCleanupCronRunsPerDay: INACTIVE_LOBBY_CLEANUP_CRON_RUNS_PER_DAY,
      rankedRoleCronRunsPerDay: RANKED_ROLE_CRON_RUNS_PER_DAY,
      architectureModel: TARGET_ARCHITECTURE_MODEL,
      lobbyWatchMsgsPerConnection: LOBBY_WATCH_INCOMING_MESSAGES_PER_CONNECTION,
      doWebsocketBillingRatio: DO_WEBSOCKET_BILLING_RATIO,
      estimatedDoGbSecondsPerRequest: ESTIMATED_DO_GB_SECONDS_PER_REQUEST,
      sessionSocketConnectionsPerViewer: TARGET_SESSION_SOCKET_CONNECTIONS_PER_VIEWER,
      sessionDoSqlReadsPerCommand: TARGET_SESSION_DO_SQL_READS_PER_COMMAND,
      sessionDoSqlWritesPerCommand: TARGET_SESSION_DO_SQL_WRITES_PER_COMMAND,
      sessionDoSqlReadsPerSocketConnect: TARGET_SESSION_DO_SQL_READS_PER_SOCKET_CONNECT,
      sessionDoSqlWritesPerSocketConnect: TARGET_SESSION_DO_SQL_WRITES_PER_SOCKET_CONNECT,
      sessionDoSqlReadsPerDraftMessage: TARGET_SESSION_DO_SQL_READS_PER_DRAFT_MESSAGE,
      sessionDoSqlWritesPerDraftMessage: TARGET_SESSION_DO_SQL_WRITES_PER_DRAFT_MESSAGE,
      directoryReadsPerViewerLaunch: TARGET_DIRECTORY_READS_PER_VIEWER_LAUNCH,
      directoryReadsPerJoinGroup: TARGET_DIRECTORY_READS_PER_JOIN_GROUP,
      directoryWritesPerSessionCreate: TARGET_DIRECTORY_WRITES_PER_SESSION_CREATE,
      directoryWritesPerParticipantJoin: TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_JOIN,
      directoryWritesPerOpenLobbyMutation: TARGET_DIRECTORY_WRITES_PER_OPEN_LOBBY_MUTATION,
      directoryWritesPerDraftStart: TARGET_DIRECTORY_WRITES_PER_DRAFT_START,
      directoryWritesPerReport: TARGET_DIRECTORY_WRITES_PER_REPORT,
      directoryWritesPerParticipantReportCleanup: TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_REPORT_CLEANUP,
      averageAcceptedSwapsPerTeamDraft: AVERAGE_ACCEPTED_SWAPS_PER_TEAM_DRAFT,
    },
    backgroundDailyUsage: backgroundDailyUsage ? roundNumericRecord(backgroundDailyUsage) : null,
    scenarios: reports.map((report) => {
      const players = scenarioPlayersPerDraft(report.mode)

      return {
        id: report.mode.id,
        label: report.mode.label,
        players,
        viewers: scenarioViewerIds(report.mode).length,
        lobbyMutations: report.openLobbyMutationRequests,
        selectedLobbyPushUpdates: report.selectedLobbyPushUpdates,
        draftMessages: report.draftRoomIncomingMessages,
        previewMessages: report.draftRoomIncomingMessagesWithSelectionPreviews,
        teamPreviewMessages: report.draftRoomIncomingMessagesWithTeamPickPreviews,
        corePerDraft: roundNumericRecord(report.corePerDraft),
        openLobbyChurnPerDraft: roundNumericRecord(report.openLobbyChurnPerDraft),
        perDraft: roundNumericRecord(report.model.perDraft),
        capacity: {
          free: {
            playsPerDay: report.freeCapacityPlaysPerDay,
            draftsPerDay: roundSnapshotNumber(report.freeCapacityPlaysPerDay / players),
            bottleneck: report.freeBreakpoints[0]?.metric ?? 'unknown',
          },
          paidIncluded: {
            playsPerDay: report.paidIncludedCapacityPlaysPerDay,
            draftsPerDay: roundSnapshotNumber(report.paidIncludedCapacityPlaysPerDay / players),
            bottleneck: report.paidBreakpoints[0]?.metric ?? 'unknown',
          },
          paid6: {
            playsPerDay: report.paidSixDollarCapacityPlaysPerDay,
            draftsPerDay: roundSnapshotNumber(report.paidSixDollarCapacityPlaysPerDay / players),
            overageUsd: roundSnapshotNumber(report.paidSixDollarOverageUsd),
          },
          paid10: {
            playsPerDay: report.paidTenDollarCapacityPlaysPerDay,
            draftsPerDay: roundSnapshotNumber(report.paidTenDollarCapacityPlaysPerDay / players),
            overageUsd: roundSnapshotNumber(report.paidTenDollarOverageUsd),
          },
        },
        breakpoints: {
          free: toSnapshotBreakpoints(report.freeBreakpoints, players),
          paidIncluded: toSnapshotBreakpoints(report.paidBreakpoints, players),
        },
      }
    }),
  }
}

function toSnapshotBreakpoints(
  breakpoints: MetricBreakpoint[],
  playersPerDraft: number,
): CapacitySnapshotBreakpoint[] {
  return breakpoints.slice(0, 3).map(row => ({
    metric: row.metric,
    playsPerDay: row.playsPerDay,
    draftsPerDay: roundSnapshotNumber(row.playsPerDay / playersPerDraft),
  }))
}

function roundNumericRecord<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record as Record<string, number>).map(([key, value]) => [key, roundSnapshotNumber(value)]),
  ) as T
}

function roundSnapshotNumber(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(4))
}

async function readSnapshotText(read: typeof readFileText): Promise<string | null> {
  try {
    return await read(CAPACITY_SNAPSHOT_FILE, 'utf8')
  }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function printReports(reports: ScenarioReport[]): void {
  const backgroundDailyUsage = reports[0]?.model.backgroundDaily

  console.log('\n[capacity] assumptions')
  console.table(reports.map(report => ({
    mode: report.mode.label,
    players: scenarioPlayersPerDraft(report.mode),
    viewers: scenarioViewerIds(report.mode).length,
    lobbyMutations: report.openLobbyMutationRequests,
    selectedLobbyPushUpdates: report.selectedLobbyPushUpdates,
    draftMsgs: report.draftRoomIncomingMessages,
    previewMsgs: report.draftRoomIncomingMessagesWithSelectionPreviews,
    teamPreviewMsgs: report.draftRoomIncomingMessagesWithTeamPickPreviews,
  })))
  console.log('[capacity] globals', {
    stabilitySamples: CAPACITY_STABILITY_SAMPLES,
    leaderboardCronRunsPerDay: LEADERBOARD_CRON_RUNS_PER_DAY,
    inactiveLobbyCleanupCronRunsPerDay: INACTIVE_LOBBY_CLEANUP_CRON_RUNS_PER_DAY,
    rankedRoleCronRunsPerDay: RANKED_ROLE_CRON_RUNS_PER_DAY,
    architectureModel: TARGET_ARCHITECTURE_MODEL,
    lobbyWatchMsgsPerConnection: LOBBY_WATCH_INCOMING_MESSAGES_PER_CONNECTION,
    doWebsocketBillingRatio: DO_WEBSOCKET_BILLING_RATIO,
    estimatedDoGbSecondsPerRequest: ESTIMATED_DO_GB_SECONDS_PER_REQUEST,
    sessionSocketConnectionsPerViewer: TARGET_SESSION_SOCKET_CONNECTIONS_PER_VIEWER,
    sessionDoSqlReadsPerCommand: TARGET_SESSION_DO_SQL_READS_PER_COMMAND,
    sessionDoSqlWritesPerCommand: TARGET_SESSION_DO_SQL_WRITES_PER_COMMAND,
    sessionDoSqlReadsPerSocketConnect: TARGET_SESSION_DO_SQL_READS_PER_SOCKET_CONNECT,
    sessionDoSqlWritesPerSocketConnect: TARGET_SESSION_DO_SQL_WRITES_PER_SOCKET_CONNECT,
    sessionDoSqlReadsPerDraftMessage: TARGET_SESSION_DO_SQL_READS_PER_DRAFT_MESSAGE,
    sessionDoSqlWritesPerDraftMessage: TARGET_SESSION_DO_SQL_WRITES_PER_DRAFT_MESSAGE,
    directoryReadsPerViewerLaunch: TARGET_DIRECTORY_READS_PER_VIEWER_LAUNCH,
    directoryReadsPerJoinGroup: TARGET_DIRECTORY_READS_PER_JOIN_GROUP,
    directoryWritesPerSessionCreate: TARGET_DIRECTORY_WRITES_PER_SESSION_CREATE,
    directoryWritesPerParticipantJoin: TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_JOIN,
    directoryWritesPerOpenLobbyMutation: TARGET_DIRECTORY_WRITES_PER_OPEN_LOBBY_MUTATION,
    directoryWritesPerDraftStart: TARGET_DIRECTORY_WRITES_PER_DRAFT_START,
    directoryWritesPerReport: TARGET_DIRECTORY_WRITES_PER_REPORT,
    directoryWritesPerParticipantReportCleanup: TARGET_DIRECTORY_WRITES_PER_PARTICIPANT_REPORT_CLEANUP,
  })

  if (backgroundDailyUsage) {
    console.log('\n[capacity] background daily usage')
    console.table([{
      ...backgroundDailyUsage,
      workersRequests: backgroundDailyUsage.workersRequests,
      botWorkerRequests: backgroundDailyUsage.botWorkerRequests,
      activityWorkerRequests: backgroundDailyUsage.activityWorkerRequests,
      doRequestsRaw: backgroundDailyUsage.doRequestsRaw,
      doDurationGbSeconds: roundForReport(backgroundDailyUsage.doDurationGbSeconds),
    }])
  }

  console.log('\n[capacity] core lifecycle vs modeled lobby churn')
  console.table(reports.map(report => ({
    mode: report.mode.label,
    coreWorkers: report.corePerDraft.workersRequests,
    churnWorkers: report.openLobbyChurnPerDraft.workersRequests,
    churnActivityWorkers: report.openLobbyChurnPerDraft.activityWorkerRequests,
    coreDoReqBilled: report.corePerDraft.doRequests,
    churnDoReqBilled: report.openLobbyChurnPerDraft.doRequests,
    totalDoReqBilled: report.model.perDraft.doRequests,
    totalDoReqRaw: report.model.perDraft.doRequestsRaw,
    churnKvReads: report.openLobbyChurnPerDraft.kvReads,
    churnKvLists: report.openLobbyChurnPerDraft.kvLists,
    churnDoSqlReads: report.openLobbyChurnPerDraft.doSqliteRowsRead,
  })))

  console.log('\n[capacity] measured per draft usage')
  console.table(reports.map(report => ({
    mode: report.mode.label,
    workersRequests: report.model.perDraft.workersRequests,
    botWorkerRequests: report.model.perDraft.botWorkerRequests,
    activityWorkerRequests: report.model.perDraft.activityWorkerRequests,
    d1RowsReadBase: report.model.perDraft.d1RowsReadBase,
    d1RowsReadPerRatedPlayer: report.model.perDraft.d1RowsReadPerLeaderboardPlayer,
    d1RowsWritten: report.model.perDraft.d1RowsWritten,
    doSqliteRowsRead: report.model.perDraft.doSqliteRowsRead,
    doSqliteRowsWritten: report.model.perDraft.doSqliteRowsWritten,
    kvReads: report.model.perDraft.kvReads,
    kvLists: report.model.perDraft.kvLists,
    kvWrites: report.model.perDraft.kvWrites,
    doReqBilled: report.model.perDraft.doRequests,
    doReqRaw: report.model.perDraft.doRequestsRaw,
    doDurationGbSeconds: roundForReport(report.model.perDraft.doDurationGbSeconds),
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
        draftsPerDay: roundForReport(report.freeCapacityPlaysPerDay / playersPerDraft),
        bottleneck: freeBottleneck?.metric ?? 'unknown',
      },
      {
        mode: report.mode.label,
        plan: '$5 included',
        playsPerDay: report.paidIncludedCapacityPlaysPerDay,
        draftsPerDay: roundForReport(report.paidIncludedCapacityPlaysPerDay / playersPerDraft),
        bottleneck: paidBottleneck?.metric ?? 'unknown',
      },
      {
        mode: report.mode.label,
        plan: '$6 target',
        playsPerDay: report.paidSixDollarCapacityPlaysPerDay,
        draftsPerDay: roundForReport(report.paidSixDollarCapacityPlaysPerDay / playersPerDraft),
        bottleneck: '',
      },
      {
        mode: report.mode.label,
        plan: '$10 target',
        playsPerDay: report.paidTenDollarCapacityPlaysPerDay,
        draftsPerDay: roundForReport(report.paidTenDollarCapacityPlaysPerDay / playersPerDraft),
        bottleneck: '',
      },
    ]
  }))

  console.log('\n[capacity] projected usage at plan ceilings')
  console.table(reports.flatMap((report) => {
    const freeUsage = projectUsageAtCapacity(report, report.freeCapacityPlaysPerDay, 1)
    const paidUsage = projectUsageAtCapacity(report, report.paidIncludedCapacityPlaysPerDay, DAYS_PER_MONTH)
    const paidSixDollarUsage = projectUsageAtCapacity(report, report.paidSixDollarCapacityPlaysPerDay, DAYS_PER_MONTH)
    const paidTenDollarUsage = projectUsageAtCapacity(report, report.paidTenDollarCapacityPlaysPerDay, DAYS_PER_MONTH)

    return [
      {
        mode: report.mode.label,
        plan: 'free',
        playsPerDay: report.freeCapacityPlaysPerDay,
        workersRequests: freeUsage.workersRequests,
        d1RowsRead: freeUsage.d1RowsRead,
        doSqliteRowsRead: freeUsage.doSqliteRowsRead,
        doSqliteRowsWritten: freeUsage.doSqliteRowsWritten,
        doReqBilled: freeUsage.doRequests,
        doReqRaw: freeUsage.doRequestsRaw,
        doDurationGbSeconds: roundForReport(freeUsage.doDurationGbSeconds),
      },
      {
        mode: report.mode.label,
        plan: '$5 included',
        playsPerDay: report.paidIncludedCapacityPlaysPerDay,
        workersRequests: paidUsage.workersRequests,
        d1RowsRead: paidUsage.d1RowsRead,
        doSqliteRowsRead: paidUsage.doSqliteRowsRead,
        doSqliteRowsWritten: paidUsage.doSqliteRowsWritten,
        doReqBilled: paidUsage.doRequests,
        doReqRaw: paidUsage.doRequestsRaw,
        doDurationGbSeconds: roundForReport(paidUsage.doDurationGbSeconds),
      },
      {
        mode: report.mode.label,
        plan: '$6 target',
        playsPerDay: report.paidSixDollarCapacityPlaysPerDay,
        workersRequests: paidSixDollarUsage.workersRequests,
        d1RowsRead: paidSixDollarUsage.d1RowsRead,
        doSqliteRowsRead: paidSixDollarUsage.doSqliteRowsRead,
        doSqliteRowsWritten: paidSixDollarUsage.doSqliteRowsWritten,
        doReqBilled: paidSixDollarUsage.doRequests,
        doReqRaw: paidSixDollarUsage.doRequestsRaw,
        doDurationGbSeconds: roundForReport(paidSixDollarUsage.doDurationGbSeconds),
      },
      {
        mode: report.mode.label,
        plan: '$10 target',
        playsPerDay: report.paidTenDollarCapacityPlaysPerDay,
        workersRequests: paidTenDollarUsage.workersRequests,
        d1RowsRead: paidTenDollarUsage.d1RowsRead,
        doSqliteRowsRead: paidTenDollarUsage.doSqliteRowsRead,
        doSqliteRowsWritten: paidTenDollarUsage.doSqliteRowsWritten,
        doReqBilled: paidTenDollarUsage.doRequests,
        doReqRaw: paidTenDollarUsage.doRequestsRaw,
        doDurationGbSeconds: roundForReport(paidTenDollarUsage.doDurationGbSeconds),
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
        draftsPerDay: roundForReport(row.playsPerDay / playersPerDraft),
      })),
      ...paidRows.map((row, index) => ({
        mode: report.mode.label,
        plan: '$5 included',
        rank: index + 1,
        metric: row.metric,
        playsPerDay: row.playsPerDay,
        draftsPerDay: roundForReport(row.playsPerDay / playersPerDraft),
      })),
    ]
  }))
}

function roundForReport(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(1))
}

function subtractUsage(total: UsageSample, base: UsageSample): UsageSample {
  return {
    workersRequests: total.workersRequests - base.workersRequests,
    botWorkerRequests: total.botWorkerRequests - base.botWorkerRequests,
    activityWorkerRequests: total.activityWorkerRequests - base.activityWorkerRequests,
    d1RowsRead: total.d1RowsRead - base.d1RowsRead,
    d1RowsWritten: total.d1RowsWritten - base.d1RowsWritten,
    doSqliteRowsRead: total.doSqliteRowsRead - base.doSqliteRowsRead,
    doSqliteRowsWritten: total.doSqliteRowsWritten - base.doSqliteRowsWritten,
    kvReads: total.kvReads - base.kvReads,
    kvWrites: total.kvWrites - base.kvWrites,
    kvDeletes: total.kvDeletes - base.kvDeletes,
    kvLists: total.kvLists - base.kvLists,
    doRequests: total.doRequests - base.doRequests,
    doRequestsRaw: total.doRequestsRaw - base.doRequestsRaw,
    doDurationGbSeconds: Number((total.doDurationGbSeconds - base.doDurationGbSeconds).toFixed(4)),
  }
}

function estimateDoRawRequests(input: {
  viewerCount: number
  draftRoomIncomingMessages: number
  lobbyWatchIncomingMessagesPerConnection: number
}): number {
  const draftRoomWebsocketConnects = input.viewerCount
  const lobbyWatchWebsocketConnects = input.viewerCount
  const lobbyWatchIncomingMessages = input.viewerCount * input.lobbyWatchIncomingMessagesPerConnection

  return (
    DO_CREATE_ROOM_REQUESTS_PER_DRAFT
    + draftRoomWebsocketConnects
    + lobbyWatchWebsocketConnects
    + input.draftRoomIncomingMessages
    + lobbyWatchIncomingMessages
  )
}

function estimateDoBilledRequestUnits(input: {
  viewerCount: number
  draftRoomIncomingMessages: number
  lobbyWatchIncomingMessagesPerConnection: number
}): number {
  const draftRoomWebsocketConnects = input.viewerCount
  const lobbyWatchWebsocketConnects = input.viewerCount
  const lobbyWatchIncomingMessages = input.viewerCount * input.lobbyWatchIncomingMessagesPerConnection

  const billedDraftMessages = Math.ceil(input.draftRoomIncomingMessages / DO_WEBSOCKET_BILLING_RATIO)
  const billedLobbyWatchMessages = Math.ceil(lobbyWatchIncomingMessages / DO_WEBSOCKET_BILLING_RATIO)

  return (
    DO_CREATE_ROOM_REQUESTS_PER_DRAFT
    + draftRoomWebsocketConnects
    + lobbyWatchWebsocketConnects
    + billedDraftMessages
    + billedLobbyWatchMessages
  )
}

function estimateDoDurationGbSeconds(doRequestsRaw: number): number {
  return Number((doRequestsRaw * ESTIMATED_DO_GB_SECONDS_PER_REQUEST).toFixed(4))
}

function projectUsageAtCapacity(
  report: ScenarioReport,
  playsPerDay: number,
  periodDays: number,
) {
  const dailyUsage = estimateDailyUsage(
    report.model,
    playsPerDay,
    scenarioPlayersPerDraft(report.mode),
  )
  return periodDays === 1 ? dailyUsage : multiplyUsage(dailyUsage, periodDays)
}

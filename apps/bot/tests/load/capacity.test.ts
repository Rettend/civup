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
import { markLeaderboardsDirty } from '../../src/services/leaderboard-message.ts'
import {
  getMatchForChannel,
  storeMatchMapping,
} from '../../src/services/activity.ts'
import {
  getServerDraftTimerDefaults,
  resolveDraftTimerConfig,
} from '../../src/services/config.ts'
import {
  clearLobbyByMatch,
  createLobby,
  getLobbyByChannel,
  getLobby,
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
import { createTrackedKv } from '../helpers/tracked-kv.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'

interface UsageLimits {
  workersRequests: number
  d1RowsRead: number
  d1RowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

interface PerDraftUsage {
  workersRequests: number
  d1RowsReadBase: number
  d1RowsReadPerLeaderboardPlayer: number
  d1RowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

interface DailyUsage {
  workersRequests: number
  d1RowsRead: number
  d1RowsWritten: number
  kvReads: number
  kvWrites: number
  kvDeletes: number
  kvLists: number
  doRequests: number
  doDurationGbSeconds: number
}

interface SimulationResult {
  usage: {
    workersRequests: number
    d1RowsRead: number
    d1RowsWritten: number
    kvReads: number
    kvWrites: number
    kvDeletes: number
    kvLists: number
    doRequests: number
    doDurationGbSeconds: number
  }
}

interface CapacityModel {
  perDraft: PerDraftUsage
  lobbyPollCycles: number
}

interface MetricBreakpoint {
  metric: keyof UsageLimits
  playersPerDay: number
  draftsPerDay: number
  limit: number
  usageAtBreakpoint: number
}

const DAILY_PLAYER_SCENARIOS = [100, 200, 1000] as const
const PLAYERS_PER_DRAFT = 2
const LOBBY_POLL_INTERVAL_SECONDS = 3
const AVERAGE_LOBBY_WAIT_SECONDS = 60
const LOBBY_POLL_CYCLES = Math.max(0, Math.round(AVERAGE_LOBBY_WAIT_SECONDS / LOBBY_POLL_INTERVAL_SECONDS))

const DO_REQUESTS_PER_DRAFT = {
  createRoom: 1,
  websocketConnects: 2,
  gameplayMessages: 5,
}
const ASSUMED_DO_DURATION_GB_SECONDS_PER_DRAFT = 2

const FREE_DAILY_LIMITS: UsageLimits = {
  workersRequests: 100_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
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
  kvReads: 10_000_000,
  kvWrites: 1_000_000,
  kvDeletes: 1_000_000,
  kvLists: 1_000_000,
  doRequests: 1_000_000,
  doDurationGbSeconds: 400_000,
}

const DAYS_PER_MONTH = 30
const SHOULD_PRINT_REPORT = Bun.env.CIVUP_CAPACITY_REPORT === '1'

describe('1v1 capacity model', () => {
  test('prints free vs paid capacity projections', async () => {
    const baseline = await simulateOneVOneDraft({
      lobbyPollCycles: LOBBY_POLL_CYCLES,
      leaderboardRows: 0,
    })
    const withOneLeaderboardRow = await simulateOneVOneDraft({
      lobbyPollCycles: LOBBY_POLL_CYCLES,
      leaderboardRows: 1,
    })

    const d1RowsReadPerLeaderboardPlayer = withOneLeaderboardRow.usage.d1RowsRead - baseline.usage.d1RowsRead
    const model: CapacityModel = {
      lobbyPollCycles: LOBBY_POLL_CYCLES,
      perDraft: {
        workersRequests: baseline.usage.workersRequests,
        d1RowsReadBase: baseline.usage.d1RowsRead,
        d1RowsReadPerLeaderboardPlayer,
        d1RowsWritten: baseline.usage.d1RowsWritten,
        kvReads: baseline.usage.kvReads,
        kvWrites: baseline.usage.kvWrites,
        kvDeletes: baseline.usage.kvDeletes,
        kvLists: baseline.usage.kvLists,
        doRequests: baseline.usage.doRequests,
        doDurationGbSeconds: baseline.usage.doDurationGbSeconds,
      },
    }

    const scenarioRows = DAILY_PLAYER_SCENARIOS.map((playersPerDay) => {
      const usage = estimateDailyUsage(model, playersPerDay)
      return {
        playersPerDay,
        draftsPerDay: playersPerDay / PLAYERS_PER_DRAFT,
        workersRequests: usage.workersRequests,
        d1RowsRead: usage.d1RowsRead,
        d1RowsWritten: usage.d1RowsWritten,
        kvReads: usage.kvReads,
        kvWrites: usage.kvWrites,
        kvDeletes: usage.kvDeletes,
        kvLists: usage.kvLists,
        doRequests: usage.doRequests,
        doDurationGbSeconds: usage.doDurationGbSeconds,
      }
    })

    const freeCapacityPlayersPerDay = findMaxPlayersPerDay({
      model,
      limits: FREE_DAILY_LIMITS,
      periodDays: 1,
    })

    const paidCapacityPlayersPerDay = findMaxPlayersPerDay({
      model,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
    })

    const freeBreakpoints = findMetricBreakpoints({
      model,
      limits: FREE_DAILY_LIMITS,
      periodDays: 1,
    })
    const paidBreakpoints = findMetricBreakpoints({
      model,
      limits: PAID_MONTHLY_LIMITS,
      periodDays: DAYS_PER_MONTH,
    })

    const freeBottleneck = freeBreakpoints[0]!
    const paidBottleneck = paidBreakpoints[0]!

    if (SHOULD_PRINT_REPORT) {
      console.log('\n[capacity] assumptions')
      console.table([
        {
          playersPerDraft: PLAYERS_PER_DRAFT,
          lobbyPollIntervalSeconds: LOBBY_POLL_INTERVAL_SECONDS,
          averageLobbyWaitSeconds: AVERAGE_LOBBY_WAIT_SECONDS,
          lobbyPollCycles: model.lobbyPollCycles,
          doRequestsPerDraft: model.perDraft.doRequests,
          doDurationGbSecondsPerDraft: model.perDraft.doDurationGbSeconds,
        },
      ])

      console.log('\n[capacity] measured per draft usage')
      console.table([
        {
          workersRequests: model.perDraft.workersRequests,
          d1RowsReadBase: model.perDraft.d1RowsReadBase,
          d1RowsReadPerLeaderboardPlayer: model.perDraft.d1RowsReadPerLeaderboardPlayer,
          d1RowsWritten: model.perDraft.d1RowsWritten,
          kvReads: model.perDraft.kvReads,
          kvWrites: model.perDraft.kvWrites,
          kvDeletes: model.perDraft.kvDeletes,
          kvLists: model.perDraft.kvLists,
          doRequests: model.perDraft.doRequests,
          doDurationGbSeconds: model.perDraft.doDurationGbSeconds,
        },
      ])

      console.log('\n[capacity] scenario usage by daily players')
      console.table(scenarioRows)

      console.log('\n[capacity] plan ceilings')
      console.table([
        {
          plan: 'free',
          playersPerDay: freeCapacityPlayersPerDay,
          draftsPerDay: freeCapacityPlayersPerDay / PLAYERS_PER_DRAFT,
          bottleneck: freeBottleneck.metric,
        },
        {
          plan: '$5 included',
          playersPerDay: paidCapacityPlayersPerDay,
          draftsPerDay: paidCapacityPlayersPerDay / PLAYERS_PER_DRAFT,
          bottleneck: paidBottleneck.metric,
        },
      ])

      console.log('\n[capacity] bottleneck breakpoints by metric')
      console.table([
        ...freeBreakpoints.map((row, index) => ({
          plan: 'free',
          rank: index + 1,
          metric: row.metric,
          playersPerDay: row.playersPerDay,
          draftsPerDay: row.draftsPerDay,
        })),
        ...paidBreakpoints.map((row, index) => ({
          plan: '$5 included',
          rank: index + 1,
          metric: row.metric,
          playersPerDay: row.playersPerDay,
          draftsPerDay: row.draftsPerDay,
        })),
      ])
    }

    expect(model.perDraft.kvWrites).toBeGreaterThan(0)
    expect(model.perDraft.d1RowsWritten).toBeGreaterThan(0)
    expect(freeCapacityPlayersPerDay).toBeGreaterThan(0)
    expect(paidCapacityPlayersPerDay).toBeGreaterThan(0)
  })
})

async function simulateOneVOneDraft(input: {
  lobbyPollCycles: number
  leaderboardRows: number
}): Promise<SimulationResult> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv: rawKv, operations, resetOperations } = createTrackedKv({ trackReads: true })
  const stateCoordinator = installStateCoordinatorHarness()
  const kv = createStateStore({
    KV: rawKv,
    PARTY_HOST: stateCoordinator.host,
    STATE_KV_SECRET: stateCoordinator.secret,
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

    for (let poll = 0; poll < input.lobbyPollCycles; poll++) {
      for (const _userId of ['p1', 'p2']) {
        await callActivityBotApi(async () => {
          await lookupLobbyForChannel(kv, 'channel-draft')
        }, () => {
          botRequests += 1
          activityRequests += 1
        })
      }
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

    return {
      usage: {
        workersRequests: botRequests + activityRequests + coordinatorRequests,
        d1RowsRead: sqlTracker.counts.rowsRead,
        d1RowsWritten: sqlTracker.counts.rowsWritten,
        kvReads,
        kvWrites,
        kvDeletes,
        kvLists,
        doRequests: DO_REQUESTS_PER_DRAFT.createRoom + DO_REQUESTS_PER_DRAFT.websocketConnects + DO_REQUESTS_PER_DRAFT.gameplayMessages + coordinatorRequests,
        doDurationGbSeconds: ASSUMED_DO_DURATION_GB_SECONDS_PER_DRAFT,
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

  await storeMatchMessageMapping(kv, 'message-lobby-drafting', matchId)

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

  await setLobbyStatus(kv, lobby.mode, 'active')
  await storeMatchMessageMapping(kv, 'message-lobby-active', matchId)
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
    await setLobbyStatus(kv, lobby.mode, 'completed')
    await storeMatchMessageMapping(kv, 'message-lobby-reported', matchId)
    await clearLobbyByMatch(kv, matchId)
  }

  const archiveChannelId = await getSystemChannel(kv, 'archive')
  if (archiveChannelId) {
    await storeMatchMessageMapping(kv, 'message-archive-reported', matchId)
  }

  await markLeaderboardsDirty(kv, `match-report:${matchId}`)
}

function buildCompletedDraftState(matchId: string, seats: DraftSeat[]): DraftState {
  const format = getDefaultFormat('1v1')
  let state = createDraft(matchId, format, seats, allLeaderIds)

  state = applyDraftInput(state, { type: 'START' }, format.blindBans)
  state = applyDraftInput(state, { type: 'BAN', seatIndex: 0, civIds: [
    allLeaderIds[0]!,
    allLeaderIds[1]!,
    allLeaderIds[2]!,
  ] }, format.blindBans)
  state = applyDraftInput(state, { type: 'BAN', seatIndex: 1, civIds: [
    allLeaderIds[3]!,
    allLeaderIds[4]!,
    allLeaderIds[5]!,
  ] }, format.blindBans)
  state = applyDraftInput(state, { type: 'PICK', seatIndex: 0, civId: allLeaderIds[6]! }, format.blindBans)
  state = applyDraftInput(state, { type: 'PICK', seatIndex: 1, civId: allLeaderIds[7]! }, format.blindBans)

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

interface StateCoordinatorHarness {
  host: string
  secret: string
  requests: () => number
  restore: () => void
}

function installStateCoordinatorHarness(): StateCoordinatorHarness {
  const host = 'https://state-coordinator.test'
  const secret = 'capacity-test-secret'
  const storage = new Map<string, { value: string, expiresAt: number | null }>()
  let requestCount = 0

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url)

    if (requestUrl.origin !== host || requestUrl.pathname !== '/parties/state/global') {
      return originalFetch(input as any, init)
    }

    requestCount += 1
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const providedSecret = resolveHeader(init?.headers, 'X-CivUp-State-Secret')
    if (providedSecret !== secret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const rawBody = typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.text()
        : ''

    let payload: {
      op?: string
      key?: unknown
      type?: unknown
      value?: unknown
      expirationTtl?: unknown
      prefix?: unknown
    }
    try {
      payload = JSON.parse(rawBody) as typeof payload
    }
    catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (payload.op === 'get') {
      const key = typeof payload.key === 'string' ? payload.key : null
      if (!key) return jsonError('Invalid key')
      const value = getValue(storage, key)
      if (value == null) return jsonResponse({ value: null })
      if (payload.type === 'json') {
        try {
          return jsonResponse({ value: JSON.parse(value) })
        }
        catch {
          return jsonResponse({ value: null })
        }
      }
      return jsonResponse({ value })
    }

    if (payload.op === 'put') {
      const key = typeof payload.key === 'string' ? payload.key : null
      const value = typeof payload.value === 'string' ? payload.value : null
      if (!key) return jsonError('Invalid key')
      if (value == null) return jsonError('Invalid value')

      const ttlSeconds = typeof payload.expirationTtl === 'number' && Number.isFinite(payload.expirationTtl)
        ? Math.max(0, Math.round(payload.expirationTtl))
        : 0
      const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null
      storage.set(key, { value, expiresAt })
      return jsonResponse({ ok: true })
    }

    if (payload.op === 'delete') {
      const key = typeof payload.key === 'string' ? payload.key : null
      if (!key) return jsonError('Invalid key')
      storage.delete(key)
      return jsonResponse({ ok: true })
    }

    if (payload.op === 'list') {
      const prefix = typeof payload.prefix === 'string' ? payload.prefix : ''
      const keys: { name: string }[] = []
      for (const key of storage.keys()) {
        const value = getValue(storage, key)
        if (value == null) continue
        if (!key.startsWith(prefix)) continue
        keys.push({ name: key })
      }
      return jsonResponse({
        keys,
        list_complete: true,
        cursor: '',
      })
    }

    return jsonError('Unknown operation')
  }

  return {
    host,
    secret,
    requests: () => requestCount,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function resolveHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null

  const target = name.toLowerCase()
  if (headers instanceof Headers) {
    return headers.get(name)
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([headerName]) => headerName.toLowerCase() === target)
    return entry?.[1] ?? null
  }

  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}

function getValue(storage: Map<string, { value: string, expiresAt: number | null }>, key: string): string | null {
  const stored = storage.get(key)
  if (!stored) return null
  if (stored.expiresAt != null && stored.expiresAt <= Date.now()) {
    storage.delete(key)
    return null
  }
  return stored.value
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}

function estimateDailyUsage(model: CapacityModel, playersPerDay: number): DailyUsage {
  const draftsPerDay = playersPerDay / PLAYERS_PER_DRAFT
  const d1RowsReadPerDraft = model.perDraft.d1RowsReadBase + model.perDraft.d1RowsReadPerLeaderboardPlayer * playersPerDay

  return {
    workersRequests: Math.ceil(draftsPerDay * model.perDraft.workersRequests),
    d1RowsRead: Math.ceil(draftsPerDay * d1RowsReadPerDraft),
    d1RowsWritten: Math.ceil(draftsPerDay * model.perDraft.d1RowsWritten),
    kvReads: Math.ceil(draftsPerDay * model.perDraft.kvReads),
    kvWrites: Math.ceil(draftsPerDay * model.perDraft.kvWrites),
    kvDeletes: Math.ceil(draftsPerDay * model.perDraft.kvDeletes),
    kvLists: Math.ceil(draftsPerDay * model.perDraft.kvLists),
    doRequests: Math.ceil(draftsPerDay * model.perDraft.doRequests),
    doDurationGbSeconds: Math.ceil(draftsPerDay * model.perDraft.doDurationGbSeconds),
  }
}

function multiplyDailyUsage(usage: DailyUsage, days: number): DailyUsage {
  return {
    workersRequests: usage.workersRequests * days,
    d1RowsRead: usage.d1RowsRead * days,
    d1RowsWritten: usage.d1RowsWritten * days,
    kvReads: usage.kvReads * days,
    kvWrites: usage.kvWrites * days,
    kvDeletes: usage.kvDeletes * days,
    kvLists: usage.kvLists * days,
    doRequests: usage.doRequests * days,
    doDurationGbSeconds: usage.doDurationGbSeconds * days,
  }
}

function findMaxPlayersPerDay(input: {
  model: CapacityModel
  limits: UsageLimits
  periodDays: number
}): number {
  let low = 0
  let high = 200_000

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const daily = estimateDailyUsage(input.model, mid)
    const usage = input.periodDays === 1 ? daily : multiplyDailyUsage(daily, input.periodDays)

    if (fitsLimits(usage, input.limits)) {
      low = mid
    }
    else {
      high = mid - 1
    }
  }

  return low
}

function findMetricBreakpoints(input: {
  model: CapacityModel
  limits: UsageLimits
  periodDays: number
}): MetricBreakpoint[] {
  const metrics = Object.keys(input.limits) as (keyof UsageLimits)[]

  return metrics
    .map((metric) => {
      const playersPerDay = findMaxPlayersPerDayByMetric({
        model: input.model,
        metric,
        limit: input.limits[metric],
        periodDays: input.periodDays,
      })
      const daily = estimateDailyUsage(input.model, playersPerDay)
      const usage = input.periodDays === 1 ? daily : multiplyDailyUsage(daily, input.periodDays)

      return {
        metric,
        playersPerDay,
        draftsPerDay: playersPerDay / PLAYERS_PER_DRAFT,
        limit: input.limits[metric],
        usageAtBreakpoint: usage[metric],
      }
    })
    .sort((a, b) => {
      if (a.playersPerDay === b.playersPerDay) return a.metric.localeCompare(b.metric)
      return a.playersPerDay - b.playersPerDay
    })
}

function findMaxPlayersPerDayByMetric(input: {
  model: CapacityModel
  metric: keyof UsageLimits
  limit: number
  periodDays: number
}): number {
  let low = 0
  let high = 200_000

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    const daily = estimateDailyUsage(input.model, mid)
    const usage = input.periodDays === 1 ? daily : multiplyDailyUsage(daily, input.periodDays)

    if (usage[input.metric] <= input.limit) {
      low = mid
    }
    else {
      high = mid - 1
    }
  }

  return low
}

function fitsLimits(usage: DailyUsage, limits: UsageLimits): boolean {
  return (
    usage.workersRequests <= limits.workersRequests
    && usage.d1RowsRead <= limits.d1RowsRead
    && usage.d1RowsWritten <= limits.d1RowsWritten
    && usage.kvReads <= limits.kvReads
    && usage.kvWrites <= limits.kvWrites
    && usage.kvDeletes <= limits.kvDeletes
    && usage.kvLists <= limits.kvLists
    && usage.doRequests <= limits.doRequests
    && usage.doDurationGbSeconds <= limits.doDurationGbSeconds
  )
}

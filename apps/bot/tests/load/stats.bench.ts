/* eslint-disable no-console */
import type { GameMode, LeaderboardMode } from '@civup/game'
import { readFile as readFileText, writeFile as writeFileText } from 'node:fs/promises'
import { matches, matchParticipants, playerRatings, players, seasons } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { playerCardEmbed } from '../../src/embeds/player-card.ts'
import { getPlayerStatsRankProfile } from '../../src/services/player/rank.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'
import { trackSqlite } from '../helpers/tracked-sqlite.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const SHOULD_PRINT_REPORT = Bun.env.CIVUP_STATS_REPORT === '1'
const STATS_SNAPSHOT_FILE = new URL('./stats.snapshot.json', import.meta.url)
const STATS_SNAPSHOT_PATH = 'tests/load/stats.snapshot.json'
const NOW = 1_700_000_000_000
const GUILD_ID = 'guild-1'
const ACTIVE_SEASON_ID = 'season-1'
const HERO_ID = '100010000000000099'
const STATS_WARMUP_SAMPLES = 1
const STATS_STABILITY_SAMPLES = 3
const LEADERBOARD_PLAYERS_PER_MODE = 250
const COMMON_PLAYER_POOL_SIZE = 24
const INSERT_BATCH_SIZE = 100

const KNOWN_LEADER_IDS = [
  'japan-hojo-tokimune',
  'babylon-hammurabi',
  'rome-trajan',
  'macedon-alexander',
  'greece-pericles',
  'egypt-cleopatra',
] as const

const STATS_SCENARIOS = [
  { id: 'duel-150', label: 'Duel', gameMode: '1v1', matchCount: 150, participantsPerMatch: 2, leaderboardMode: 'duel' },
  { id: 'duo-150', label: '2v2', gameMode: '2v2', matchCount: 150, participantsPerMatch: 4, leaderboardMode: 'duo' },
  { id: 'ffa-150', label: 'FFA8', gameMode: 'ffa', matchCount: 150, participantsPerMatch: 8, leaderboardMode: 'ffa' },
  { id: 'sixes-120', label: '6v6', gameMode: '6v6', matchCount: 120, participantsPerMatch: 12, leaderboardMode: 'squad' },
] as const satisfies readonly StatsBenchmarkScenario[]

interface StatsBenchmarkScenario {
  id: string
  label: string
  gameMode: GameMode
  matchCount: number
  participantsPerMatch: number
  leaderboardMode: LeaderboardMode
}

interface StatsCallMetrics {
  rankProfileMs: number
  embedMs: number
  totalMs: number
  sqlRowsRead: {
    rankProfile: number
    embed: number
    total: number
  }
  kvOps: {
    gets: number
    puts: number
    deletes: number
    lists: number
  }
}

interface StatsOutputSummary {
  fieldCount: number
  jsonBytes: number
  topLeadersLines: number
  commonTeammatesLines: number
  commonOpponentsLines: number
  recentMatchesLines: number
}

interface StatsScenarioReport {
  id: string
  label: string
  gameMode: GameMode
  leaderboardMode: LeaderboardMode
  matchCount: number
  participantsPerMatch: number
  leaderboardPlayersPerMode: number
  cold: StatsCallMetrics
  warm: StatsCallMetrics
  output: StatsOutputSummary
}

interface StatsSnapshot {
  version: number
  globals: {
    warmupSamples: number
    stabilitySamples: number
    leaderboardPlayersPerMode: number
    modeFilter: 'all'
  }
  scenarios: Array<{
    id: string
    label: string
    gameMode: GameMode
    leaderboardMode: LeaderboardMode
    matchCount: number
    participantsPerMatch: number
    leaderboardPlayersPerMode: number
    output: StatsOutputSummary
    cold: StatsSnapshotPhase
    warm: StatsSnapshotPhase
  }>
}

interface StatsSnapshotPhase {
  sqlRowsRead: StatsCallMetrics['sqlRowsRead']
  kvOps: StatsCallMetrics['kvOps']
}

describe('stats benchmarks', () => {
  test('prints current stats performance baselines', { timeout: 30_000 }, async () => {
    const reports: StatsScenarioReport[] = []

    for (const scenario of STATS_SCENARIOS) {
      reports.push(await measureStableScenario(scenario))
    }

    const snapshotStatus = await writeStatsSnapshot(reports)

    if (SHOULD_PRINT_REPORT) printReports(reports)
    if (SHOULD_PRINT_REPORT) console.log(`\n[stats] snapshot ${snapshotStatus}: ${STATS_SNAPSHOT_PATH}`)

    expect(reports).toHaveLength(STATS_SCENARIOS.length)
    for (const report of reports) {
      expect(report.cold.totalMs).toBeGreaterThan(0)
      expect(report.warm.totalMs).toBeGreaterThan(0)
      expect(report.cold.sqlRowsRead.total).toBeGreaterThan(0)
      expect(report.warm.sqlRowsRead.total).toBeGreaterThan(0)
      expect(report.output.fieldCount).toBeGreaterThan(0)
      expect(report.output.topLeadersLines).toBeGreaterThan(0)
      expect(report.output.commonOpponentsLines).toBeGreaterThan(0)
      expect(report.output.recentMatchesLines).toBeGreaterThan(0)
    }
  })
})

async function measureStableScenario(scenario: StatsBenchmarkScenario): Promise<StatsScenarioReport> {
  for (let index = 0; index < STATS_WARMUP_SAMPLES; index += 1) {
    await measureScenarioSample(scenario)
  }

  const samples: Array<{
    cold: StatsCallMetrics
    warm: StatsCallMetrics
    output: StatsOutputSummary
  }> = []

  for (let index = 0; index < STATS_STABILITY_SAMPLES; index += 1) {
    samples.push(await measureScenarioSample(scenario))
  }

  const [first] = samples
  if (!first) throw new Error(`Expected at least one stats benchmark sample for ${scenario.id}`)

  return {
    id: scenario.id,
    label: scenario.label,
    gameMode: scenario.gameMode,
    leaderboardMode: scenario.leaderboardMode,
    matchCount: scenario.matchCount,
    participantsPerMatch: scenario.participantsPerMatch,
    leaderboardPlayersPerMode: LEADERBOARD_PLAYERS_PER_MODE,
    cold: summarizeMetrics(samples.map(sample => sample.cold)),
    warm: summarizeMetrics(samples.map(sample => sample.warm)),
    output: first.output,
  }
}

async function measureScenarioSample(scenario: StatsBenchmarkScenario): Promise<{
  cold: StatsCallMetrics
  warm: StatsCallMetrics
  output: StatsOutputSummary
}> {
  const { db, sqlite } = await createTestDatabase()
  const sqlTracker = trackSqlite(sqlite)
  const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

  try {
    await seedStatsBenchmarkScenario(db, kv, scenario)

    const cold = await measureStatsCall({
      db,
      kv,
      sqlTracker,
      operations,
      resetOperations,
    })
    const warm = await measureStatsCall({
      db,
      kv,
      sqlTracker,
      operations,
      resetOperations,
    })

    return {
      cold: cold.metrics,
      warm: warm.metrics,
      output: warm.output,
    }
  }
  finally {
    sqlTracker.restore()
    sqlite.close()
  }
}

async function measureStatsCall(input: {
  db: Awaited<ReturnType<typeof createTestDatabase>>['db']
  kv: KVNamespace
  sqlTracker: ReturnType<typeof trackSqlite>
  operations: ReturnType<typeof createTrackedKv>['operations']
  resetOperations: () => void
}): Promise<{ metrics: StatsCallMetrics, output: StatsOutputSummary }> {
  const rankProfile = await measureBlock(input, async () => {
    return await getPlayerStatsRankProfile(input.db, input.kv, GUILD_ID, HERO_ID)
  })
  const embed = await measureBlock(input, async () => {
    const built = await playerCardEmbed(input.db, HERO_ID, 'all', {
      rankProfile: rankProfile.result.rankProfile,
      ratingRows: rankProfile.result.ratingRows,
    })
    return built.toJSON()
  })

  return {
    metrics: {
      rankProfileMs: rankProfile.elapsedMs,
      embedMs: embed.elapsedMs,
      totalMs: rankProfile.elapsedMs + embed.elapsedMs,
      sqlRowsRead: {
        rankProfile: rankProfile.sqlRowsRead,
        embed: embed.sqlRowsRead,
        total: rankProfile.sqlRowsRead + embed.sqlRowsRead,
      },
      kvOps: {
        gets: rankProfile.kvOps.gets + embed.kvOps.gets,
        puts: rankProfile.kvOps.puts + embed.kvOps.puts,
        deletes: rankProfile.kvOps.deletes + embed.kvOps.deletes,
        lists: rankProfile.kvOps.lists + embed.kvOps.lists,
      },
    },
    output: summarizeOutput(embed.result),
  }
}

async function measureBlock<T>(
  input: {
    sqlTracker: ReturnType<typeof trackSqlite>
    operations: ReturnType<typeof createTrackedKv>['operations']
    resetOperations: () => void
  },
  action: () => Promise<T>,
): Promise<{ result: T, elapsedMs: number, sqlRowsRead: number, kvOps: StatsCallMetrics['kvOps'] }> {
  input.sqlTracker.reset()
  input.resetOperations()

  const startedAt = performance.now()
  const result = await action()
  const elapsedMs = performance.now() - startedAt

  return {
    result,
    elapsedMs,
    sqlRowsRead: input.sqlTracker.counts.rowsRead,
    kvOps: countKvOperations(input.operations),
  }
}

async function seedStatsBenchmarkScenario(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  kv: KVNamespace,
  scenario: StatsBenchmarkScenario,
): Promise<void> {
  await setRankedRoleCurrentRoles(kv, GUILD_ID, {
    tier5: '11111111111111111',
    tier4: '22222222222222222',
    tier3: '33333333333333333',
    tier2: '44444444444444444',
    tier1: '55555555555555555',
  })

  await db.insert(seasons).values({
    id: ACTIVE_SEASON_ID,
    seasonNumber: 1,
    name: 'Season 1',
    startsAt: NOW - 30 * 86_400_000,
    endsAt: null,
    active: true,
    softReset: true,
  })

  const allPlayerRows = new Map<string, { id: string, displayName: string, avatarUrl: string | null, createdAt: number }>()
  const allRatingRows = new Map<string, { playerId: string, mode: LeaderboardMode, mu: number, sigma: number, gamesPlayed: number, wins: number, lastPlayedAt: number }>()
  const matchRows: Array<{
    id: string
    gameMode: GameMode
    status: 'completed'
    isOld: boolean
    seasonId: string
    draftData: null
    createdAt: number
    completedAt: number
  }> = []
  const participantRows: Array<{
    matchId: string
    playerId: string
    team: number | null
    civId: string | null
    placement: number
    ratingBeforeMu: number | null
    ratingBeforeSigma: number | null
    ratingAfterMu: number | null
    ratingAfterSigma: number | null
  }> = []

  addPlayerRow(allPlayerRows, HERO_ID, 'Hero')
  for (const mode of LEADERBOARD_MODES) {
    addRatingRow(allRatingRows, {
      playerId: HERO_ID,
      mode,
      mu: 38,
      sigma: 6,
      gamesPlayed: Math.max(20, scenario.matchCount),
      wins: Math.max(12, Math.floor(scenario.matchCount * 0.55)),
      lastPlayedAt: NOW,
    })
  }

  for (const mode of LEADERBOARD_MODES) {
    for (let index = 1; index <= LEADERBOARD_PLAYERS_PER_MODE; index += 1) {
      const playerId = playerIdFor(`${mode}-lb`, index)
      addPlayerRow(allPlayerRows, playerId, `${mode.toUpperCase()} Ladder ${index}`)
      addRatingRow(allRatingRows, {
        playerId,
        mode,
        mu: 25 + ((LEADERBOARD_PLAYERS_PER_MODE - index) * 0.04),
        sigma: 7 + ((index % 5) * 0.1),
        gamesPlayed: 12 + (index % 30),
        wins: 6 + (index % 18),
        lastPlayedAt: NOW - (index * 1_000),
      })
    }
  }

  const teammatePool = Array.from({ length: COMMON_PLAYER_POOL_SIZE }, (_value, index) => {
    const playerId = playerIdFor(`${scenario.id}-ally`, index + 1)
    addPlayerRow(allPlayerRows, playerId, `${scenario.label} Ally ${index + 1}`)
    return playerId
  })
  const opponentPool = Array.from({ length: COMMON_PLAYER_POOL_SIZE * 2 }, (_value, index) => {
    const playerId = playerIdFor(`${scenario.id}-opp`, index + 1)
    addPlayerRow(allPlayerRows, playerId, `${scenario.label} Opp ${index + 1}`)
    return playerId
  })

  for (let matchIndex = 0; matchIndex < scenario.matchCount; matchIndex += 1) {
    const matchId = `${scenario.id}-${String(matchIndex + 1).padStart(4, '0')}`
    const completedAt = NOW - ((scenario.matchCount - matchIndex) * 60_000)
    const heroWon = matchIndex % 2 === 0

    matchRows.push({
      id: matchId,
      gameMode: scenario.gameMode,
      status: 'completed',
      isOld: false,
      seasonId: ACTIVE_SEASON_ID,
      draftData: null,
      createdAt: completedAt - 10_000,
      completedAt,
    })

    participantRows.push(...buildScenarioParticipants({
      scenario,
      matchId,
      matchIndex,
      heroWon,
      teammatePool,
      opponentPool,
    }))
  }

  await insertBatches(db, players, [...allPlayerRows.values()])
  await insertBatches(db, playerRatings, [...allRatingRows.values()])
  await insertBatches(db, matches, matchRows)
  await insertBatches(db, matchParticipants, participantRows)
}

function buildScenarioParticipants(input: {
  scenario: StatsBenchmarkScenario
  matchId: string
  matchIndex: number
  heroWon: boolean
  teammatePool: string[]
  opponentPool: string[]
}): Array<{
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}> {
  const heroLeaderId = KNOWN_LEADER_IDS[input.matchIndex % KNOWN_LEADER_IDS.length] ?? KNOWN_LEADER_IDS[0]

  if (input.scenario.gameMode === '1v1') {
    const opponentId = cyclePick(input.opponentPool, input.matchIndex)
    const heroPlacement = input.heroWon ? 1 : 2
    const opponentPlacement = input.heroWon ? 2 : 1
    return [
      buildParticipantRow(input.matchId, HERO_ID, 0, heroPlacement, heroLeaderId, input.matchIndex),
      buildParticipantRow(input.matchId, opponentId, 1, opponentPlacement, null, input.matchIndex),
    ]
  }

  if (input.scenario.gameMode === 'ffa') {
    const heroPlacement = input.heroWon ? 1 : 4
    const placements = input.heroWon ? [2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 5, 6, 7, 8]
    const rows = [buildParticipantRow(input.matchId, HERO_ID, null, heroPlacement, heroLeaderId, input.matchIndex)]

    for (let index = 0; index < input.scenario.participantsPerMatch - 1; index += 1) {
      rows.push(buildParticipantRow(
        input.matchId,
        cyclePick(input.opponentPool, input.matchIndex * 3 + index),
        null,
        placements[index] ?? index + 2,
        null,
        input.matchIndex,
      ))
    }

    return rows
  }

  const teamSize = input.scenario.participantsPerMatch / 2
  const heroPlacement = input.heroWon ? 1 : 2
  const opponentPlacement = input.heroWon ? 2 : 1
  const rows = [buildParticipantRow(input.matchId, HERO_ID, 0, heroPlacement, heroLeaderId, input.matchIndex)]

  for (let index = 0; index < teamSize - 1; index += 1) {
    rows.push(buildParticipantRow(
      input.matchId,
      cyclePick(input.teammatePool, input.matchIndex + index),
      0,
      heroPlacement,
      null,
      input.matchIndex,
    ))
  }

  for (let index = 0; index < teamSize; index += 1) {
    rows.push(buildParticipantRow(
      input.matchId,
      cyclePick(input.opponentPool, input.matchIndex * 2 + index),
      1,
      opponentPlacement,
      null,
      input.matchIndex,
    ))
  }

  return rows
}

function buildParticipantRow(
  matchId: string,
  playerId: string,
  team: number | null,
  placement: number,
  civId: string | null,
  matchIndex: number,
): {
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
} {
  const beforeMu = 30 + (matchIndex % 6)
  const afterMu = beforeMu + (placement === 1 ? 1.15 : -0.85)

  return {
    matchId,
    playerId,
    team,
    civId,
    placement,
    ratingBeforeMu: playerId === HERO_ID ? beforeMu : null,
    ratingBeforeSigma: playerId === HERO_ID ? 6 : null,
    ratingAfterMu: playerId === HERO_ID ? afterMu : null,
    ratingAfterSigma: playerId === HERO_ID ? 5.8 : null,
  }
}

function summarizeMetrics(samples: StatsCallMetrics[]): StatsCallMetrics {
  return {
    rankProfileMs: median(samples.map(sample => sample.rankProfileMs)),
    embedMs: median(samples.map(sample => sample.embedMs)),
    totalMs: median(samples.map(sample => sample.totalMs)),
    sqlRowsRead: {
      rankProfile: median(samples.map(sample => sample.sqlRowsRead.rankProfile)),
      embed: median(samples.map(sample => sample.sqlRowsRead.embed)),
      total: median(samples.map(sample => sample.sqlRowsRead.total)),
    },
    kvOps: {
      gets: median(samples.map(sample => sample.kvOps.gets)),
      puts: median(samples.map(sample => sample.kvOps.puts)),
      deletes: median(samples.map(sample => sample.kvOps.deletes)),
      lists: median(samples.map(sample => sample.kvOps.lists)),
    },
  }
}

function summarizeOutput(embed: {
  fields?: Array<{ name: string, value: string }>
}): StatsOutputSummary {
  const fields = embed.fields ?? []
  return {
    fieldCount: fields.length,
    jsonBytes: JSON.stringify(embed).length,
    topLeadersLines: countFieldLines(fields, 'Top Leaders'),
    commonTeammatesLines: countFieldLines(fields, 'Common Teammates'),
    commonOpponentsLines: countFieldLines(fields, 'Common Opponents'),
    recentMatchesLines: countFieldLines(fields, 'Recent Matches'),
  }
}

function countFieldLines(fields: Array<{ name: string, value: string }>, prefix: string): number {
  const field = fields.find(entry => entry.name === prefix || entry.name.startsWith(`${prefix} (`))
  if (!field) return 0
  return field.value.split('\n').filter(line => line.trim().length > 0).length
}

function countKvOperations(operations: ReturnType<typeof createTrackedKv>['operations']): StatsCallMetrics['kvOps'] {
  return {
    gets: operations.filter(op => op.type === 'get').length,
    puts: operations.filter(op => op.type === 'put').length,
    deletes: operations.filter(op => op.type === 'delete').length,
    lists: operations.filter(op => op.type === 'list').length,
  }
}

async function writeStatsSnapshot(reports: StatsScenarioReport[]): Promise<'updated' | 'unchanged'> {
  const snapshot = buildStatsSnapshot(reports)
  const nextText = `${JSON.stringify(snapshot, null, 2)}\n`
  const currentText = await readSnapshotText(readFileText)

  if (currentText === nextText) return 'unchanged'

  await writeFileText(STATS_SNAPSHOT_FILE, nextText, 'utf8')
  return 'updated'
}

function buildStatsSnapshot(reports: StatsScenarioReport[]): StatsSnapshot {
  return {
    version: 1,
    globals: {
      warmupSamples: STATS_WARMUP_SAMPLES,
      stabilitySamples: STATS_STABILITY_SAMPLES,
      leaderboardPlayersPerMode: LEADERBOARD_PLAYERS_PER_MODE,
      modeFilter: 'all',
    },
    scenarios: reports.map(report => ({
      id: report.id,
      label: report.label,
      gameMode: report.gameMode,
      leaderboardMode: report.leaderboardMode,
      matchCount: report.matchCount,
      participantsPerMatch: report.participantsPerMatch,
      leaderboardPlayersPerMode: report.leaderboardPlayersPerMode,
      output: roundOutputSummary(report.output),
      cold: toSnapshotPhase(report.cold),
      warm: toSnapshotPhase(report.warm),
    })),
  }
}

function toSnapshotPhase(metrics: StatsCallMetrics): StatsSnapshotPhase {
  return {
    sqlRowsRead: {
      rankProfile: roundSnapshotNumber(metrics.sqlRowsRead.rankProfile),
      embed: roundSnapshotNumber(metrics.sqlRowsRead.embed),
      total: roundSnapshotNumber(metrics.sqlRowsRead.total),
    },
    kvOps: {
      gets: roundSnapshotNumber(metrics.kvOps.gets),
      puts: roundSnapshotNumber(metrics.kvOps.puts),
      deletes: roundSnapshotNumber(metrics.kvOps.deletes),
      lists: roundSnapshotNumber(metrics.kvOps.lists),
    },
  }
}

function roundOutputSummary(summary: StatsOutputSummary): StatsOutputSummary {
  return {
    fieldCount: roundSnapshotNumber(summary.fieldCount),
    jsonBytes: roundSnapshotNumber(summary.jsonBytes),
    topLeadersLines: roundSnapshotNumber(summary.topLeadersLines),
    commonTeammatesLines: roundSnapshotNumber(summary.commonTeammatesLines),
    commonOpponentsLines: roundSnapshotNumber(summary.commonOpponentsLines),
    recentMatchesLines: roundSnapshotNumber(summary.recentMatchesLines),
  }
}

function roundSnapshotNumber(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(4))
}

async function readSnapshotText(read: typeof readFileText): Promise<string | null> {
  try {
    return await read(STATS_SNAPSHOT_FILE, 'utf8')
  }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function printReports(reports: StatsScenarioReport[]): void {
  console.log('\n[stats] scenarios')
  console.table(reports.map(report => ({
    scenario: report.label,
    matches: report.matchCount,
    playersPerMatch: report.participantsPerMatch,
    ladderPlayers: report.leaderboardPlayersPerMode,
    coldMs: roundSnapshotNumber(report.cold.totalMs),
    warmMs: roundSnapshotNumber(report.warm.totalMs),
    coldRows: report.cold.sqlRowsRead.total,
    warmRows: report.warm.sqlRowsRead.total,
    coldKvGets: report.cold.kvOps.gets,
    warmKvGets: report.warm.kvOps.gets,
    payloadBytes: report.output.jsonBytes,
  })))

  console.log('\n[stats] breakdown')
  console.table(reports.map(report => ({
    scenario: report.label,
    coldRankMs: roundSnapshotNumber(report.cold.rankProfileMs),
    coldEmbedMs: roundSnapshotNumber(report.cold.embedMs),
    warmRankMs: roundSnapshotNumber(report.warm.rankProfileMs),
    warmEmbedMs: roundSnapshotNumber(report.warm.embedMs),
    coldRankRows: report.cold.sqlRowsRead.rankProfile,
    coldEmbedRows: report.cold.sqlRowsRead.embed,
    warmRankRows: report.warm.sqlRowsRead.rankProfile,
    warmEmbedRows: report.warm.sqlRowsRead.embed,
    commonTeammates: report.output.commonTeammatesLines,
    commonOpponents: report.output.commonOpponentsLines,
  })))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted[Math.floor(sorted.length / 2)]
  if (middle == null) throw new Error('Expected at least one numeric stats benchmark sample')
  return roundSnapshotNumber(middle)
}

function addPlayerRow(
  rows: Map<string, { id: string, displayName: string, avatarUrl: string | null, createdAt: number }>,
  playerId: string,
  displayName: string,
): void {
  if (rows.has(playerId)) return
  rows.set(playerId, {
    id: playerId,
    displayName,
    avatarUrl: null,
    createdAt: NOW,
  })
}

function addRatingRow(
  rows: Map<string, { playerId: string, mode: LeaderboardMode, mu: number, sigma: number, gamesPlayed: number, wins: number, lastPlayedAt: number }>,
  row: { playerId: string, mode: LeaderboardMode, mu: number, sigma: number, gamesPlayed: number, wins: number, lastPlayedAt: number },
): void {
  rows.set(`${row.playerId}:${row.mode}`, row)
}

async function insertBatches<T extends object>(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  table: Parameters<Awaited<ReturnType<typeof createTestDatabase>>['db']['insert']>[0],
  rows: T[],
): Promise<void> {
  for (const batch of chunk(rows, INSERT_BATCH_SIZE)) {
    if (batch.length === 0) continue
    await db.insert(table).values(batch)
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function cyclePick(values: string[], index: number): string {
  const value = values[index % values.length]
  if (!value) throw new Error('Expected a non-empty participant pool')
  return value
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}

/* eslint-disable no-console */
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { calculateFfaRatings, createRating, displayRating, predictWinProbabilities } from '../packages/rating/src/index.ts'

interface CliOptions {
  command: 'summary' | 'help'
  outDir: string
  json: boolean
  games: number
  replicates: number
  seed: number
}

interface SimPlayer {
  id: string
  circleId: number
  hiddenDisplay: number
  visible: ReturnType<typeof createRating>
  gamesPlayed: number
  wins: number
  placementTotal: number
}

interface MatchStat {
  favoriteProbability: number
}

interface PlayerSample {
  gamesPlayed: number
  observedAveragePlacement: number
  observedWinRate: number
  displayRating: number
  hiddenDisplay: number
}

interface FfaSimulationResult {
  players: PlayerSample[]
  matches: MatchStat[]
}

interface BandSummary {
  label: string
  samples: number
  median: number | null
  p10: number | null
  p90: number | null
}

interface Summary {
  assumptions: string
  samples: number
  gamesP10: number | null
  gamesP90: number | null
  favorite20PlusShare: number
  favorite30PlusShare: number
  averagePlacementBands: BandSummary[]
  hiddenSkillBands: BandSummary[]
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT_DIR = resolve(repoRoot, 'tmp', 'rating-ffa-sim')
const DEFAULT_SEED = 20260408
const DEFAULT_GAMES = 100
const DEFAULT_REPLICATES = 12

const POPULATION_SIZE = 128
const CIRCLE_SIZE = 16
const LOBBY_SIZE = 8
const SAME_CIRCLE_SHARE = 0.72
const PERFORMANCE_STD_DEV = 135
const CIRCLE_SKILL_STD_DEV = 95
const PLAYER_SKILL_STD_DEV = 135

const AVERAGE_PLACEMENT_BANDS = [
  { label: '< 3.75', low: null, high: 3.75 },
  { label: '3.75-4.25', low: 3.75, high: 4.25 },
  { label: '4.25-4.75', low: 4.25, high: 4.75 },
  { label: '4.75-5.25', low: 4.75, high: 5.25 },
  { label: '>= 5.25', low: 5.25, high: null },
] as const

const HIDDEN_SKILL_BANDS = [
  { label: '< 900', low: null, high: 900 },
  { label: '900-1000', low: 900, high: 1000 },
  { label: '1000-1100', low: 1000, high: 1100 },
  { label: '1100-1200', low: 1100, high: 1200 },
  { label: '>= 1200', low: 1200, high: null },
] as const

const args = parseCli(Bun.argv.slice(2))

if (args.command === 'help') {
  printUsage()
  process.exit(0)
}

await mkdir(args.outDir, { recursive: true })

console.log('[sim] running FFA open-lobby rating sim')
console.log(`[sim] games=${args.games} replicates=${args.replicates} seed=${args.seed}`)

const results: FfaSimulationResult[] = []

for (let replicate = 0; replicate < args.replicates; replicate++) {
  const seed = mixSeed(args.seed, replicate)
  results.push(simulateRun(args.games, seed))
}

const summary = summarizeRuns(results)
const markdown = renderMarkdown(summary, args)
const payload = {
  generatedAt: new Date().toISOString(),
  args,
  summary,
}

await Bun.write(resolve(args.outDir, 'summary.md'), markdown)
await Bun.write(resolve(args.outDir, 'summary.json'), `${JSON.stringify(payload, null, 2)}\n`)

if (args.json) {
  console.log(JSON.stringify(payload, null, 2))
}
else {
  console.log(markdown)
}

console.log(`[sim] wrote ${resolve(args.outDir, 'summary.md')}`)
console.log(`[sim] wrote ${resolve(args.outDir, 'summary.json')}`)

function parseCli(values: string[]): CliOptions {
  const first = values[0]
  const command = first === 'help'
    ? 'help'
    : 'summary'
  const rest = first === 'summary' || first === 'help'
    ? values.slice(1)
    : values
  const options = new Map<string, string>()
  let json = false

  for (let index = 0; index < rest.length; index++) {
    const current = rest[index]
    if (!current?.startsWith('--')) continue
    const key = current.slice(2)
    if (key === 'json') {
      json = true
      continue
    }
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options.set(key, value)
    index += 1
  }

  return {
    command,
    outDir: resolve(options.get('out-dir') ?? DEFAULT_OUT_DIR),
    json,
    games: normalizePositiveInteger(options.get('games'), DEFAULT_GAMES),
    replicates: normalizePositiveInteger(options.get('replicates'), DEFAULT_REPLICATES),
    seed: normalizePositiveInteger(options.get('seed'), DEFAULT_SEED),
  }
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  bun scripts/rating-ffa-sim.ts summary [--games 100] [--replicates 12] [--seed 20260408] [--out-dir tmp/rating-ffa-sim] [--json]',
    '  bun scripts/rating-ffa-sim.ts help',
    '',
    'Notes:',
    '  - Simulates fixed 8-player FFA lobbies with repeated circles and some mixed lobbies.',
    '  - Results are generated from hidden skill plus per-game performance variance.',
    '  - Default summaries use a 100-game cap per player.',
  ].join('\n'))
}

function normalizePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function mixSeed(baseSeed: number, replicate: number): number {
  return (baseSeed + (replicate * 65537)) >>> 0
}

function simulateRun(gamesPerPlayer: number, seed: number): FfaSimulationResult {
  const random = createLcg(seed)
  const players: SimPlayer[] = []
  const circlePlayerIds = new Map<number, string[]>()
  const circleSkillById = new Map<number, number>()

  for (let playerIndex = 0; playerIndex < POPULATION_SIZE; playerIndex++) {
    const circleId = Math.floor(playerIndex / CIRCLE_SIZE)
    const circleBaseSkill = circleSkillById.get(circleId) ?? (1000 + sampleNormal(random, 0, CIRCLE_SKILL_STD_DEV))
    circleSkillById.set(circleId, circleBaseSkill)
    const hiddenDisplay = clamp(Math.round(circleBaseSkill + sampleNormal(random, 0, PLAYER_SKILL_STD_DEV)), 650, 1650)
    const playerId = `ffa-p${String(playerIndex + 1).padStart(4, '0')}`
    players.push({
      id: playerId,
      circleId,
      hiddenDisplay,
      visible: createRating(playerId),
      gamesPlayed: 0,
      wins: 0,
      placementTotal: 0,
    })
    const currentCirclePlayers = circlePlayerIds.get(circleId) ?? []
    currentCirclePlayers.push(playerId)
    circlePlayerIds.set(circleId, currentCirclePlayers)
  }

  const playerById = new Map(players.map(player => [player.id, player]))
  const matchStats: MatchStat[] = []

  while (players.some(player => player.gamesPlayed < gamesPerPlayer)) {
    const available = players.filter(player => player.gamesPlayed < gamesPerPlayer)
    if (available.length < LOBBY_SIZE) break

    const selected = buildLobby(circlePlayerIds, playerById, gamesPerPlayer, random)
    if (selected.length !== LOBBY_SIZE) throw new Error('Could not form full FFA lobby')

    const visibleProbabilities = predictWinProbabilities(selected.map(player => [player.visible]))
    matchStats.push({
      favoriteProbability: visibleProbabilities.reduce((best, current) => Math.max(best, current ?? 0), 0),
    })

    const ordered = selected
      .map(player => ({
        player,
        performance: player.hiddenDisplay + sampleNormal(random, 0, PERFORMANCE_STD_DEV),
      }))
      .sort((left, right) => right.performance - left.performance)

    const entries = ordered.map((entry, index) => ({
      player: entry.player.visible,
      placement: index + 1,
    }))
    const updates = calculateFfaRatings(entries)
    const updateByPlayerId = new Map(updates.map(update => [update.playerId, update]))

    for (let index = 0; index < ordered.length; index++) {
      const player = ordered[index]!.player
      const update = updateByPlayerId.get(player.id)
      if (!update) throw new Error(`Missing FFA update for ${player.id}`)

      player.visible = { playerId: player.id, mu: update.after.mu, sigma: update.after.sigma }
      player.gamesPlayed += 1
      player.placementTotal += index + 1
      if (index === 0) player.wins += 1
    }
  }

  return {
    players: players
      .filter(player => player.gamesPlayed > 0)
      .map((player): PlayerSample => ({
        gamesPlayed: player.gamesPlayed,
        observedAveragePlacement: player.placementTotal / player.gamesPlayed,
        observedWinRate: player.wins / player.gamesPlayed,
        displayRating: Math.round(displayRating(player.visible.mu, player.visible.sigma)),
        hiddenDisplay: player.hiddenDisplay,
      })),
    matches: matchStats,
  }
}

function buildLobby(
  circlePlayerIds: Map<number, string[]>,
  playerById: Map<string, SimPlayer>,
  gamesPerPlayer: number,
  random: () => number,
): SimPlayer[] {
  if (random() < SAME_CIRCLE_SHARE) {
    const circleId = pickCircleId(circlePlayerIds, playerById, gamesPerPlayer, LOBBY_SIZE, random)
    if (circleId != null) {
      return pickManyWeighted(
        getAvailablePlayers(circlePlayerIds, playerById, circleId, gamesPerPlayer),
        LOBBY_SIZE,
        player => Math.max(1, gamesPerPlayer - player.gamesPlayed),
        random,
      )
    }
  }

  const playersPerCircle = LOBBY_SIZE / 2
  const firstCircleId = pickCircleId(circlePlayerIds, playerById, gamesPerPlayer, playersPerCircle, random)
  const secondCircleId = pickSecondCircleId(circlePlayerIds, playerById, gamesPerPlayer, playersPerCircle, firstCircleId, random)

  if (firstCircleId != null && secondCircleId != null) {
    return [
      ...pickManyWeighted(
        getAvailablePlayers(circlePlayerIds, playerById, firstCircleId, gamesPerPlayer),
        playersPerCircle,
        player => Math.max(1, gamesPerPlayer - player.gamesPlayed),
        random,
      ),
      ...pickManyWeighted(
        getAvailablePlayers(circlePlayerIds, playerById, secondCircleId, gamesPerPlayer),
        playersPerCircle,
        player => Math.max(1, gamesPerPlayer - player.gamesPlayed),
        random,
      ),
    ]
  }

  return pickManyWeighted(
    [...playerById.values()].filter(player => player.gamesPlayed < gamesPerPlayer),
    LOBBY_SIZE,
    player => Math.max(1, gamesPerPlayer - player.gamesPlayed),
    random,
  )
}

function getAvailablePlayers(
  circlePlayerIds: Map<number, string[]>,
  playerById: Map<string, SimPlayer>,
  circleId: number,
  gamesPerPlayer: number,
): SimPlayer[] {
  return (circlePlayerIds.get(circleId) ?? [])
    .map(playerId => playerById.get(playerId))
    .filter((player): player is SimPlayer => player != null && player.gamesPlayed < gamesPerPlayer)
}

function pickCircleId(
  circlePlayerIds: Map<number, string[]>,
  playerById: Map<string, SimPlayer>,
  gamesPerPlayer: number,
  requiredPlayers: number,
  random: () => number,
): number | null {
  const candidates = [...circlePlayerIds.entries()]
    .map(([circleId, playerIds]) => ({
      circleId,
      weight: playerIds.reduce((total, playerId) => {
        const player = playerById.get(playerId)
        if (!player || player.gamesPlayed >= gamesPerPlayer) return total
        return total + Math.max(1, gamesPerPlayer - player.gamesPlayed)
      }, 0),
      available: playerIds.filter((playerId) => {
        const player = playerById.get(playerId)
        return player != null && player.gamesPlayed < gamesPerPlayer
      }).length,
    }))
    .filter(circle => circle.available >= requiredPlayers && circle.weight > 0)

  const picked = pickWeighted(candidates, circle => circle.weight, random)
  return picked?.circleId ?? null
}

function pickSecondCircleId(
  circlePlayerIds: Map<number, string[]>,
  playerById: Map<string, SimPlayer>,
  gamesPerPlayer: number,
  requiredPlayers: number,
  excludedCircleId: number | null,
  random: () => number,
): number | null {
  const candidates = [...circlePlayerIds.entries()]
    .filter(([circleId]) => circleId !== excludedCircleId)
    .map(([circleId, playerIds]) => ({
      circleId,
      weight: playerIds.reduce((total, playerId) => {
        const player = playerById.get(playerId)
        if (!player || player.gamesPlayed >= gamesPerPlayer) return total
        return total + Math.max(1, gamesPerPlayer - player.gamesPlayed)
      }, 0),
      available: playerIds.filter((playerId) => {
        const player = playerById.get(playerId)
        return player != null && player.gamesPlayed < gamesPerPlayer
      }).length,
    }))
    .filter(circle => circle.available >= requiredPlayers && circle.weight > 0)

  const picked = pickWeighted(candidates, circle => circle.weight, random)
  return picked?.circleId ?? null
}

function summarizeRuns(results: FfaSimulationResult[]): Summary {
  const playerSamples = results.flatMap(result => result.players)
  const matchStats = results.flatMap(result => result.matches)

  return {
    assumptions: 'Fixed 8-player FFA open lobbies with repeated circles, some mixed-circle games, and hidden-skill performance variance',
    samples: playerSamples.length,
    gamesP10: percentile(playerSamples.map(sample => sample.gamesPlayed).sort((left, right) => left - right), 0.1),
    gamesP90: percentile(playerSamples.map(sample => sample.gamesPlayed).sort((left, right) => left - right), 0.9),
    favorite20PlusShare: share(matchStats, stat => stat.favoriteProbability >= 0.2),
    favorite30PlusShare: share(matchStats, stat => stat.favoriteProbability >= 0.3),
    averagePlacementBands: AVERAGE_PLACEMENT_BANDS.map(({ label, low, high }) => summarizeBand(
      label,
      playerSamples,
      sample => sample.observedAveragePlacement,
      low,
      high,
    )),
    hiddenSkillBands: HIDDEN_SKILL_BANDS.map(({ label, low, high }) => summarizeBand(
      label,
      playerSamples,
      sample => sample.hiddenDisplay,
      low,
      high,
    )),
  }
}

function summarizeBand(
  label: string,
  samples: PlayerSample[],
  getValue: (sample: PlayerSample) => number,
  low: number | null,
  high: number | null,
): BandSummary {
  const ratings = samples
    .filter(sample => (low == null || getValue(sample) >= low) && (high == null || getValue(sample) < high))
    .map(sample => sample.displayRating)
    .sort((left, right) => left - right)

  return {
    label,
    samples: ratings.length,
    median: percentile(ratings, 0.5),
    p10: percentile(ratings, 0.1),
    p90: percentile(ratings, 0.9),
  }
}

function renderMarkdown(summary: Summary, options: CliOptions): string {
  const lines = [
    '# FFA Rating Open-Lobby Simulation',
    '',
    `Seed: \`${options.seed}\``,
    `Games/player cap: \`${options.games}\``,
    `Replicates: \`${options.replicates}\``,
    '',
    summary.assumptions,
    '',
    `- samples: \`${summary.samples}\``,
    `- games played p10-p90: \`${formatCountRange(summary.gamesP10, summary.gamesP90)}\``,
    `- share of lobbies with pre-match favorite >= 20%: \`${formatPercent(summary.favorite20PlusShare)}\``,
    `- share of lobbies with pre-match favorite >= 30%: \`${formatPercent(summary.favorite30PlusShare)}\``,
    '',
    '## Observed Average Placement',
    '',
    '| Observed average placement over season | Median rating | P10-P90 | Samples |',
    '| -------------------------------------- | ------------- | ------- | ------- |',
  ]

  for (const band of summary.averagePlacementBands) {
    lines.push(`| ${band.label} | ${formatMaybeRating(band.median)} | ${formatRange(band.p10, band.p90)} | ${band.samples} |`)
  }

  lines.push('')
  lines.push('## Hidden Skill Bands')
  lines.push('')
  lines.push('Simulation-only diagnostic: hidden skill is not visible to players, but it shows whether ratings separate the field cleanly.')
  lines.push('')
  lines.push('| Hidden skill band | Median rating | P10-P90 | Samples |')
  lines.push('| ----------------- | ------------- | ------- | ------- |')

  for (const band of summary.hiddenSkillBands) {
    lines.push(`| ${band.label} | ${formatMaybeRating(band.median)} | ${formatRange(band.p10, band.p90)} | ${band.samples} |`)
  }

  return `${lines.join('\n')}\n`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatMaybeRating(value: number | null): string {
  return value == null ? '-' : `~${Math.round(value)}`
}

function formatRange(low: number | null, high: number | null): string {
  if (low == null || high == null) return '-'
  return `~${Math.round(low)}-${Math.round(high)}`
}

function formatCountRange(low: number | null, high: number | null): string {
  if (low == null || high == null) return '-'
  return `${Math.round(low)}-${Math.round(high)}`
}

function share<T>(values: T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 0
  let hits = 0
  for (const value of values) {
    if (predicate(value)) hits += 1
  }
  return hits / values.length
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const boundedRatio = Math.max(0, Math.min(1, ratio))
  const index = boundedRatio * (values.length - 1)
  const leftIndex = Math.floor(index)
  const rightIndex = Math.min(values.length - 1, leftIndex + 1)
  const mix = index - leftIndex
  const left = values[leftIndex] ?? values[0]!
  const right = values[rightIndex] ?? left
  return left + ((right - left) * mix)
}

function createLcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function sampleNormal(random: () => number, mean: number, stdDev: number): number {
  const u1 = Math.max(1e-12, random())
  const u2 = Math.max(1e-12, random())
  const magnitude = Math.sqrt(-2 * Math.log(u1))
  const z0 = magnitude * Math.cos(2 * Math.PI * u2)
  return mean + (z0 * stdDev)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pickWeighted<T>(
  values: T[],
  getWeight: (value: T) => number,
  random: () => number,
): T | null {
  let totalWeight = 0
  for (const value of values) {
    totalWeight += Math.max(0, getWeight(value))
  }
  if (totalWeight <= 0) return null

  let threshold = random() * totalWeight
  for (const value of values) {
    threshold -= Math.max(0, getWeight(value))
    if (threshold <= 0) return value
  }

  return values.at(-1) ?? null
}

function pickManyWeighted<T>(
  values: T[],
  count: number,
  getWeight: (value: T) => number,
  random: () => number,
): T[] {
  const pool = [...values]
  const picked: T[] = []

  while (picked.length < count && pool.length > 0) {
    const next = pickWeighted(pool, getWeight, random)
    if (!next) break
    picked.push(next)
    const index = pool.indexOf(next)
    if (index >= 0) pool.splice(index, 1)
  }

  return picked
}

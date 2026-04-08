/* eslint-disable no-console */
import type { PlayerRating } from '../packages/rating/src/index.ts'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { calculateTeamRatings, createRating, DEFAULT_MU, DISPLAY_RATING_BASE, DISPLAY_RATING_SCALE, displayRating, predictWinProbabilities } from '../packages/rating/src/index.ts'

type SimMode = 'duel' | 'duo' | 'squad'
type SimVariant = 'duel' | 'duo' | 'squad3' | 'squad4'

interface CliOptions {
  command: 'summary' | 'help'
  outDir: string
  json: boolean
  games: number
  replicates: number
  modes: SimMode[]
  seed: number
  discountStart: number
  discountFloor: number
  discountExponent: number
}

interface VariantConfig {
  variant: SimVariant
  publicMode: SimMode
  label: string
  teamSize: 1 | 2 | 3 | 4
  playerCount: number
  circleSize: number
  sameCircleShare: number
  premadeChancePerTeam: number
  circleSkillStdDev: number
  playerSkillStdDev: number
  hiddenSigma: number
  pairCoordinationBonus: number
  premadePlan: Array<{ size: 2 | 3 | 4, chance: number }>
}

interface SimPlayer {
  id: string
  circleId: number
  hiddenDisplay: number
  visible: PlayerRating
  gamesPlayed: number
  wins: number
}

interface PremadeGroup {
  id: string
  circleId: number
  memberIds: string[]
  size: 2 | 3 | 4
}

interface TeamSelection {
  playerIds: string[]
  premadeSize: number
}

interface MatchStat {
  favoriteProbability: number
}

interface PlayerSample {
  mode: SimMode
  variant: SimVariant
  gamesPlayed: number
  observedWinRate: number
  displayRating: number
  hiddenDisplay: number
}

interface VariantSimulationResult {
  config: VariantConfig
  players: PlayerSample[]
  matches: MatchStat[]
}

interface BandSummary {
  label: string
  low: number
  high: number
  samples: number
  median: number | null
  p10: number | null
  p90: number | null
}

interface ModeSummary {
  mode: SimMode
  assumptions: string
  samples: number
  gamesP10: number | null
  gamesP90: number | null
  favorite75PlusShare: number
  favorite90PlusShare: number
  bands: BandSummary[]
}

interface ExpectedWinDiscountPolicy {
  start: number
  floor: number
  exponent: number
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT_DIR = resolve(repoRoot, 'tmp', 'rating-open-sim')
const DEFAULT_SEED = 20260403
const DEFAULT_GAMES = 100
const DEFAULT_REPLICATES = 12
const DEFAULT_MODES: SimMode[] = ['duel', 'duo', 'squad']
const LIVE_DISCOUNT_POLICY: ExpectedWinDiscountPolicy = {
  start: 0.70,
  floor: 0.05,
  exponent: 1.5,
}

const WIN_RATE_BANDS = [
  { label: '45-55%', low: 0.45, high: 0.55 },
  { label: '55-65%', low: 0.55, high: 0.65 },
  { label: '65-75%', low: 0.65, high: 0.75 },
  { label: '75-85%', low: 0.75, high: 0.85 },
] as const

const VARIANT_CONFIGS: Record<SimVariant, VariantConfig> = {
  duel: {
    variant: 'duel',
    publicMode: 'duel',
    label: 'Duel',
    teamSize: 1,
    playerCount: 120,
    circleSize: 12,
    sameCircleShare: 0.8,
    premadeChancePerTeam: 0,
    circleSkillStdDev: 105,
    playerSkillStdDev: 150,
    hiddenSigma: 4,
    pairCoordinationBonus: 0,
    premadePlan: [],
  },
  duo: {
    variant: 'duo',
    publicMode: 'duo',
    label: 'Duo',
    teamSize: 2,
    playerCount: 128,
    circleSize: 16,
    sameCircleShare: 0.72,
    premadeChancePerTeam: 0.4,
    circleSkillStdDev: 115,
    playerSkillStdDev: 145,
    hiddenSigma: 4,
    pairCoordinationBonus: 12,
    premadePlan: [{ size: 2, chance: 0.35 }],
  },
  squad3: {
    variant: 'squad3',
    publicMode: 'squad',
    label: 'Squad 3v3',
    teamSize: 3,
    playerCount: 144,
    circleSize: 18,
    sameCircleShare: 0.68,
    premadeChancePerTeam: 0.46,
    circleSkillStdDev: 120,
    playerSkillStdDev: 135,
    hiddenSigma: 4,
    pairCoordinationBonus: 9,
    premadePlan: [{ size: 3, chance: 0.12 }, { size: 2, chance: 0.18 }],
  },
  squad4: {
    variant: 'squad4',
    publicMode: 'squad',
    label: 'Squad 4v4',
    teamSize: 4,
    playerCount: 160,
    circleSize: 24,
    sameCircleShare: 0.64,
    premadeChancePerTeam: 0.52,
    circleSkillStdDev: 125,
    playerSkillStdDev: 130,
    hiddenSigma: 4,
    pairCoordinationBonus: 8,
    premadePlan: [{ size: 4, chance: 0.1 }, { size: 3, chance: 0.14 }, { size: 2, chance: 0.18 }],
  },
}

const args = parseCli(Bun.argv.slice(2))

if (args.command === 'help') {
  printUsage()
  process.exit(0)
}

await mkdir(args.outDir, { recursive: true })

console.log(`[sim] running open-lobby rating population sim`)
console.log(`[sim] modes=${args.modes.join(', ')} games=${args.games} replicates=${args.replicates} seed=${args.seed}`)
console.log(`[sim] expected-win taper start=${formatPolicyPercent(args.discountStart)} floor=${formatPolicyPercent(args.discountFloor)} exp=${args.discountExponent}`)

const variantsToRun = expandVariants(args.modes)
const results: VariantSimulationResult[] = []

for (const variant of variantsToRun) {
  const config = VARIANT_CONFIGS[variant]
  const variantRuns = getReplicateCountForVariant(config.publicMode, variant, args.replicates)
  for (let replicate = 0; replicate < variantRuns; replicate++) {
    const seed = mixSeed(args.seed, variant, replicate)
    results.push(simulateVariant(config, args.games, seed))
  }
}

const modeSummaries = summarizeModes(results, args.modes)
const markdown = renderMarkdown(modeSummaries, args)
const payload = {
  generatedAt: new Date().toISOString(),
  args,
  modeSummaries,
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
    modes: parseModes(options.get('modes')),
    seed: normalizePositiveInteger(options.get('seed'), DEFAULT_SEED),
    discountStart: normalizeUnitFloat(options.get('discount-start'), LIVE_DISCOUNT_POLICY.start),
    discountFloor: normalizeUnitFloat(options.get('discount-floor'), LIVE_DISCOUNT_POLICY.floor),
    discountExponent: normalizePositiveFloat(options.get('discount-exponent'), LIVE_DISCOUNT_POLICY.exponent),
  }
}

function printUsage(): void {
  console.log([
    'Usage:',
    '  bun scripts/rating-open-sim.ts summary [--modes duel,duo,squad] [--games 100] [--replicates 12] [--seed 20260403] [--discount-start 0.70] [--discount-floor 0.05] [--discount-exponent 1.5] [--out-dir tmp/rating-open-sim] [--json]',
    '  bun scripts/rating-open-sim.ts help',
    '',
    'Notes:',
    '  - Uses open-lobby circles with repeated opponents and optional premades.',
    '  - Duel, duo, and squad are simulated separately; squad is a 70/30 mix of 3v3 and 4v4 samples.',
    '  - Default summaries use a 100-game cap per player.',
  ].join('\n'))
}

function normalizePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeUnitFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.min(0.99, parsed))
}

function normalizePositiveFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseModes(value: string | undefined): SimMode[] {
  if (!value) return [...DEFAULT_MODES]
  const modes = value
    .split(',')
    .map(part => part.trim())
    .filter((part): part is SimMode => part === 'duel' || part === 'duo' || part === 'squad')
  return modes.length > 0 ? [...new Set(modes)] : [...DEFAULT_MODES]
}

function expandVariants(modes: SimMode[]): SimVariant[] {
  return modes.flatMap((mode) => {
    if (mode === 'duel') return ['duel']
    if (mode === 'duo') return ['duo']
    return ['squad3', 'squad4']
  })
}

function getReplicateCountForVariant(mode: SimMode, variant: SimVariant, requestedReplicates: number): number {
  if (mode !== 'squad') return requestedReplicates
  return variant === 'squad3'
    ? Math.max(1, Math.round(requestedReplicates * 0.7))
    : Math.max(1, requestedReplicates - Math.round(requestedReplicates * 0.7))
}

function mixSeed(baseSeed: number, variant: SimVariant, replicate: number): number {
  const variantValue = [...variant].reduce((total, char) => total + char.charCodeAt(0), 0)
  return (baseSeed + (variantValue * 1009) + (replicate * 65537)) >>> 0
}

function simulateVariant(config: VariantConfig, gamesPerPlayer: number, seed: number): VariantSimulationResult {
  const random = createLcg(seed)
  const players: SimPlayer[] = []
  const circlePlayerIds = new Map<number, string[]>()
  const premades: PremadeGroup[] = []
  const circleSkillById = new Map<number, number>()

  for (let playerIndex = 0; playerIndex < config.playerCount; playerIndex++) {
    const circleId = Math.floor(playerIndex / config.circleSize)
    const circleBaseSkill = circleSkillById.get(circleId) ?? (1000 + sampleNormal(random, 0, config.circleSkillStdDev))
    circleSkillById.set(circleId, circleBaseSkill)
    const hiddenDisplay = clamp(Math.round(circleBaseSkill + sampleNormal(random, 0, config.playerSkillStdDev)), 650, 1650)
    const playerId = `${config.variant}-p${String(playerIndex + 1).padStart(4, '0')}`
    players.push({
      id: playerId,
      circleId,
      hiddenDisplay,
      visible: createRating(playerId),
      gamesPlayed: 0,
      wins: 0,
    })
    const currentCirclePlayers = circlePlayerIds.get(circleId) ?? []
    currentCirclePlayers.push(playerId)
    circlePlayerIds.set(circleId, currentCirclePlayers)
  }

  for (const [circleId, playerIds] of circlePlayerIds.entries()) {
    premades.push(...buildPremades(config, circleId, playerIds, random))
  }

  const playerById = new Map(players.map(player => [player.id, player]))
  const matchStats: MatchStat[] = []
  const playersPerMatch = config.teamSize * 2

  while (players.some(player => player.gamesPlayed < gamesPerPlayer)) {
    const available = players.filter(player => player.gamesPlayed < gamesPerPlayer)
    if (available.length < playersPerMatch) break

    const sameCircle = random() < config.sameCircleShare
    let teamA: TeamSelection | null = null
    let teamB: TeamSelection | null = null

    if (sameCircle) {
      const circleId = pickCircleId(circlePlayerIds, playerById, gamesPerPlayer, playersPerMatch, random)
      if (circleId != null) {
        const used = new Set<string>()
        teamA = buildTeam(config, circleId, circlePlayerIds, premades, playerById, used, gamesPerPlayer, random)
        teamB = teamA ? buildTeam(config, circleId, circlePlayerIds, premades, playerById, used, gamesPerPlayer, random) : null
      }
    }
    else {
      const circleA = pickCircleId(circlePlayerIds, playerById, gamesPerPlayer, config.teamSize, random)
      const circleB = pickSecondCircleId(circlePlayerIds, playerById, gamesPerPlayer, config.teamSize, circleA, random)
      if (circleA != null && circleB != null) {
        teamA = buildTeam(config, circleA, circlePlayerIds, premades, playerById, new Set<string>(), gamesPerPlayer, random)
        teamB = buildTeam(config, circleB, circlePlayerIds, premades, playerById, new Set<string>(), gamesPerPlayer, random)
      }
    }

    if (!teamA || !teamB || teamA.playerIds.length !== config.teamSize || teamB.playerIds.length !== config.teamSize) {
      const fallback = buildFallbackMatch(config, players, gamesPerPlayer, random)
      teamA = fallback.teamA
      teamB = fallback.teamB
    }

    const teamAVisible = teamA.playerIds.map((playerId) => {
      const player = playerById.get(playerId)
      if (!player) throw new Error(`Missing visible player ${playerId}`)
      return player.visible
    })
    const teamBVisible = teamB.playerIds.map((playerId) => {
      const player = playerById.get(playerId)
      if (!player) throw new Error(`Missing visible player ${playerId}`)
      return player.visible
    })
    const visibleProbabilities = predictWinProbabilities([teamAVisible, teamBVisible])
    matchStats.push({
      favoriteProbability: Math.max(visibleProbabilities[0] ?? 0.5, visibleProbabilities[1] ?? 0.5),
    })

    const teamAHidden = teamA.playerIds.map((playerId, index) => toHiddenRating(playerById.get(playerId), config, index < teamA.premadeSize))
    const teamBHidden = teamB.playerIds.map((playerId, index) => toHiddenRating(playerById.get(playerId), config, index < teamB.premadeSize))
    const actualProbabilities = predictWinProbabilities([teamAHidden, teamBHidden])
    const teamAWon = random() < (actualProbabilities[0] ?? 0.5)

    const updates = teamAWon
      ? calculateTeamRatingsForSimulation(
          [{ players: teamAVisible }, { players: teamBVisible }],
          {
            start: args.discountStart,
            floor: args.discountFloor,
            exponent: args.discountExponent,
          },
        )
      : calculateTeamRatingsForSimulation(
          [{ players: teamBVisible }, { players: teamAVisible }],
          {
            start: args.discountStart,
            floor: args.discountFloor,
            exponent: args.discountExponent,
          },
        )
    const updateByPlayerId = new Map(updates.map(update => [update.playerId, update]))

    for (const playerId of teamA.playerIds) {
      const player = playerById.get(playerId)
      const update = updateByPlayerId.get(playerId)
      if (!player || !update) throw new Error(`Missing team A update for ${playerId}`)
      player.visible = { playerId, mu: update.after.mu, sigma: update.after.sigma }
      player.gamesPlayed += 1
      if (teamAWon) player.wins += 1
    }
    for (const playerId of teamB.playerIds) {
      const player = playerById.get(playerId)
      const update = updateByPlayerId.get(playerId)
      if (!player || !update) throw new Error(`Missing team B update for ${playerId}`)
      player.visible = { playerId, mu: update.after.mu, sigma: update.after.sigma }
      player.gamesPlayed += 1
      if (!teamAWon) player.wins += 1
    }
  }

  const samples = players
    .filter(player => player.gamesPlayed > 0)
    .map((player): PlayerSample => ({
      mode: config.publicMode,
      variant: config.variant,
      gamesPlayed: player.gamesPlayed,
      observedWinRate: player.wins / player.gamesPlayed,
      displayRating: Math.round(displayRating(player.visible.mu, player.visible.sigma)),
      hiddenDisplay: player.hiddenDisplay,
    }))

  return {
    config,
    players: samples,
    matches: matchStats,
  }
}

function buildPremades(
  config: VariantConfig,
  circleId: number,
  circlePlayerIds: string[],
  random: () => number,
): PremadeGroup[] {
  if (config.teamSize === 1 || config.premadePlan.length === 0) return []

  const shuffled = [...circlePlayerIds]
  shuffleInPlace(shuffled, random)
  const premades: PremadeGroup[] = []
  let groupIndex = 0

  while (shuffled.length >= 2) {
    const nextPlan = config.premadePlan.find(plan => shuffled.length >= plan.size && random() < plan.chance)
    if (!nextPlan) {
      shuffled.shift()
      continue
    }

    const memberIds = shuffled.splice(0, nextPlan.size)
    premades.push({
      id: `${config.variant}-c${circleId}-g${groupIndex + 1}`,
      circleId,
      memberIds,
      size: nextPlan.size,
    })
    groupIndex += 1
  }

  return premades
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

function buildTeam(
  config: VariantConfig,
  circleId: number,
  circlePlayerIds: Map<number, string[]>,
  premades: PremadeGroup[],
  playerById: Map<string, SimPlayer>,
  usedIds: Set<string>,
  gamesPerPlayer: number,
  random: () => number,
): TeamSelection | null {
  const circleCandidates = (circlePlayerIds.get(circleId) ?? []).filter((playerId) => {
    const player = playerById.get(playerId)
    return player != null && player.gamesPlayed < gamesPerPlayer && !usedIds.has(playerId)
  })
  if (circleCandidates.length < config.teamSize) return null

  let teamIds: string[] = []
  let premadeSize = 0

  if (config.teamSize > 1 && random() < config.premadeChancePerTeam) {
    const premade = pickWeighted(
      premades.filter(group =>
        group.circleId === circleId
        && group.size <= config.teamSize
        && group.memberIds.every((playerId) => {
          const player = playerById.get(playerId)
          return player != null && player.gamesPlayed < gamesPerPlayer && !usedIds.has(playerId)
        }),
      ),
      group => group.size === config.teamSize ? 3 : 1 + group.size,
      random,
    )
    if (premade) {
      teamIds = [...premade.memberIds]
      premadeSize = premade.size
    }
  }

  while (teamIds.length < config.teamSize) {
    const available = circleCandidates.filter(playerId => !teamIds.includes(playerId))
    const picked = pickWeighted(
      available,
      (playerId) => {
        const player = playerById.get(playerId)
        return player ? Math.max(1, gamesPerPlayer - player.gamesPlayed) : 0
      },
      random,
    )
    if (!picked) break
    teamIds.push(picked)
  }

  if (teamIds.length !== config.teamSize) return null
  for (const playerId of teamIds) usedIds.add(playerId)
  return { playerIds: teamIds, premadeSize }
}

function buildFallbackMatch(
  config: VariantConfig,
  players: SimPlayer[],
  gamesPerPlayer: number,
  random: () => number,
): { teamA: TeamSelection, teamB: TeamSelection } {
  const available = players.filter(player => player.gamesPlayed < gamesPerPlayer)
  const picked = pickManyWeighted(
    available,
    config.teamSize * 2,
    player => Math.max(1, gamesPerPlayer - player.gamesPlayed),
    random,
  )
  if (picked.length !== config.teamSize * 2) throw new Error(`Could not form fallback match for ${config.variant}`)

  return {
    teamA: { playerIds: picked.slice(0, config.teamSize).map(player => player.id), premadeSize: 0 },
    teamB: { playerIds: picked.slice(config.teamSize).map(player => player.id), premadeSize: 0 },
  }
}

function toHiddenRating(player: SimPlayer | undefined, config: VariantConfig, hasPremadeBonus: boolean): PlayerRating {
  if (!player) throw new Error('Missing hidden player')
  const coordinationBonus = hasPremadeBonus ? config.pairCoordinationBonus : 0
  return {
    playerId: player.id,
    mu: displayToMu(player.hiddenDisplay + coordinationBonus),
    sigma: config.hiddenSigma,
  }
}

function displayToMu(display: number): number {
  return DEFAULT_MU + ((display - DISPLAY_RATING_BASE) / DISPLAY_RATING_SCALE)
}

function calculateTeamRatingsForSimulation(
  teams: Array<{ players: PlayerRating[] }>,
  policy: ExpectedWinDiscountPolicy,
) {
  const currentUpdates = calculateTeamRatings(teams)
  if (teams.length !== 2) return currentUpdates

  const winnerProbability = predictWinProbabilities(teams.map(team => team.players))[0] ?? 0.5
  const liveWeight = getExpectedWinWeight(LIVE_DISCOUNT_POLICY, winnerProbability)
  const targetWeight = getExpectedWinWeight(policy, winnerProbability)
  if (Math.abs(liveWeight - targetWeight) < 1e-12) return currentUpdates

  const scale = targetWeight / liveWeight
  return currentUpdates.map((update) => {
    const afterMu = update.before.mu + ((update.after.mu - update.before.mu) * scale)
    const afterSigma = update.before.sigma + ((update.after.sigma - update.before.sigma) * scale)
    const displayAfter = displayRating(afterMu, afterSigma)
    return {
      ...update,
      after: { mu: afterMu, sigma: afterSigma },
      displayAfter,
      displayDelta: displayAfter - update.displayBefore,
    }
  })
}

function getExpectedWinWeight(policy: ExpectedWinDiscountPolicy, winnerProbability: number): number {
  const boundedProbability = Math.max(0, Math.min(1, winnerProbability))
  if (boundedProbability <= policy.start) return 1

  const normalizedTail = (1 - boundedProbability) / Math.max(1e-9, 1 - policy.start)
  return Math.max(policy.floor, normalizedTail ** policy.exponent)
}

function summarizeModes(results: VariantSimulationResult[], requestedModes: SimMode[]): ModeSummary[] {
  return requestedModes.map((mode) => {
    const relevant = results.filter(result => result.config.publicMode === mode)
    const playerSamples = relevant.flatMap(result => result.players)
    const matchStats = relevant.flatMap(result => result.matches)

    return {
      mode,
      assumptions: summarizeAssumptions(relevant.map(result => result.config)),
      samples: playerSamples.length,
      gamesP10: percentile(playerSamples.map(sample => sample.gamesPlayed).sort((left, right) => left - right), 0.1),
      gamesP90: percentile(playerSamples.map(sample => sample.gamesPlayed).sort((left, right) => left - right), 0.9),
      favorite75PlusShare: share(matchStats, stat => stat.favoriteProbability >= 0.75),
      favorite90PlusShare: share(matchStats, stat => stat.favoriteProbability >= 0.9),
      bands: WIN_RATE_BANDS.map(({ label, low, high }) => {
        const ratings = playerSamples
          .filter(sample => sample.observedWinRate >= low && sample.observedWinRate < high)
          .map(sample => sample.displayRating)
          .sort((left, right) => left - right)
        return {
          label,
          low,
          high,
          samples: ratings.length,
          median: percentile(ratings, 0.5),
          p10: percentile(ratings, 0.1),
          p90: percentile(ratings, 0.9),
        }
      }),
    }
  })
}

function summarizeAssumptions(configs: VariantConfig[]): string {
  const labels = [...new Set(configs.map(config => config.label))]
  const premadeSuffix = configs.some(config => config.premadeChancePerTeam > 0)
    ? ', and optional premades'
    : ''
  if (labels.length === 1) return `${labels[0]} open lobbies with repeated circles and cross-circle games${premadeSuffix}`
  return `${labels.join(' + ')} open lobbies mixed together with repeated circles and cross-circle games${premadeSuffix}`
}

function renderMarkdown(modeSummaries: ModeSummary[], options: CliOptions): string {
  const lines = [
    '# Rating Open-Lobby Simulation',
    '',
    `Seed: \`${options.seed}\``,
    `Games/player cap: \`${options.games}\``,
    `Replicates: \`${options.replicates}\``,
    '',
    'This model is intentionally more realistic than the fixed-1000-opponent tests:',
    '- repeated opponents are allowed inside social circles',
    '- some matches are same-circle and some are cross-circle',
    '- duo and squad can keep premades together',
    '- squad is a 70/30 mix of 3v3 and 4v4 runs',
    '',
  ]

  for (const summary of modeSummaries) {
    lines.push(`## ${capitalize(summary.mode)}`)
    lines.push('')
    lines.push(summary.assumptions)
    lines.push('')
    lines.push(`- samples: \`${summary.samples}\``)
    lines.push(`- games played p10-p90: \`${formatCountRange(summary.gamesP10, summary.gamesP90)}\``)
    lines.push(`- share of matches with pre-match favorite >= 75%: \`${formatPercent(summary.favorite75PlusShare)}\``)
    lines.push(`- share of matches with pre-match favorite >= 90%: \`${formatPercent(summary.favorite90PlusShare)}\``)
    lines.push('')
    lines.push('| Observed win rate over season | Median rating | P10-P90 | Samples |')
    lines.push('| ----------------------------- | ------------- | ------- | ------- |')
    for (const band of summary.bands) {
      lines.push(`| ${band.label} | ${formatMaybeRating(band.median)} | ${formatRange(band.p10, band.p90)} | ${band.samples} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatPolicyPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`
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

function shuffleInPlace<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1))
    const temp = values[index]
    values[index] = values[swapIndex]!
    values[swapIndex] = temp!
  }
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

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

#!/usr/bin/env bun
import type { CivReplaySnapshotTimeline, CivReplayTurnSnapshot } from './civreplay/snapshot.ts'
import type { CivupOpeningReport } from './opening-report.ts'
import type { CivupAutosaveTimeline, CivupTurnSnapshot } from './types.ts'
import { analyzeAutosaveTimelineBytes } from './autosave-timeline.ts'
import { createCityStateResolver } from './civreplay/city-states.ts'
import { analyzeCivReplaySnapshotsBytes } from './civreplay/snapshot.ts'
import { compareOpeningReports, formatOpeningComparisonSummary } from './compare-opening.ts'
import { createHashResolver } from './hash.ts'
import { analyzeOpeningReportBytes, formatOpeningReportSummary } from './opening-report.ts'
import { analyzeScienceReportBytes, formatScienceReportSummary } from './science-report.ts'

type OutputFormat = 'summary' | 'json' | 'jsonl'
type CliCommand = 'parse' | 'lobby' | 'snapshot' | 'opening' | 'science' | 'compare-opening' | 'help'

interface CivupLobbyReport {
  tool: 'civup-analyzer'
  schemaVersion: 1
  source: string
  sourceKind: CivupAutosaveTimeline['sourceKind']
  generatedAt: string
  saveName: string | null
  gameRandomSeed: number | null
  mapRandomSeed: number | null
  gameMode: string | null
  mapFile: string | null
  players: CivupLobbyPlayer[]
}

interface CivupLobbyPlayer {
  slot: number
  team: number | null
  playerName: string | null
  leader: string | null
  civilization: string | null
}

interface CliOptions {
  command: CliCommand
  path: string | null
  comparePath: string | null
  format: OutputFormat
  out: string | null
  focus: string | null
  playerId: number | null
  turn: number | null
  fromTurn: number | null
  toTurn: number | null
  limit: number | null
  compact: boolean
  failFast: boolean
  typesDbPath: string | null
  loadDefaultTypesDb: boolean
}

let options: CliOptions
try {
  options = parseArgs(Bun.argv.slice(2))
}
catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid arguments')
  printUsage()
  process.exit(1)
}

if (options.command === 'help') {
  printUsage()
  process.exit(0)
}

if (!options.path) {
  printUsage()
  process.exit(1)
}

if (options.command === 'compare-opening') {
  if (!options.comparePath) {
    printUsage()
    process.exit(1)
  }
  const baselineFile = Bun.file(options.path)
  const subjectFile = Bun.file(options.comparePath)
  if (!(await baselineFile.exists())) {
    console.error(`File not found: ${options.path}`)
    process.exit(1)
  }
  if (!(await subjectFile.exists())) {
    console.error(`File not found: ${options.comparePath}`)
    process.exit(1)
  }
  const baseline = parseOpeningReportJson(await baselineFile.text(), options.path)
  const subject = parseOpeningReportJson(await subjectFile.text(), options.comparePath)
  const output = formatOpeningComparisonOutput(compareOpeningReports(baseline, subject), options)
  if (options.out) await Bun.write(options.out, output)
  else console.log(output)
  process.exit(0)
}

const file = Bun.file(options.path)
if (!(await file.exists())) {
  console.error(`File not found: ${options.path}`)
  process.exit(1)
}

const bytes = new Uint8Array(await file.arrayBuffer())
const output = runCommand(options, bytes)

if (options.out) await Bun.write(options.out, output)
else console.log(output)

function runCommand(options: CliOptions, bytes: Uint8Array): string {
  const path = options.path!
  if (options.command === 'lobby') {
    const timeline = analyzeAutosaveTimelineBytes(path, bytes, {
      limit: options.limit ?? 1,
      failFast: options.failFast,
    })
    return formatLobbyOutput(buildLobbyReport(timeline), options)
  }

  if (options.command === 'snapshot') {
    const timeline = analyzeCivReplaySnapshotsBytes(path, bytes, {
      limit: options.limit,
      turn: options.turn,
      failFast: options.failFast,
      cityStateResolver: createCityStateResolver({
        typesDbPath: options.typesDbPath,
        loadDefaultTypesDb: options.loadDefaultTypesDb,
      }),
    })
    return formatSnapshotOutput(timeline, options)
  }

  if (options.command === 'opening') {
    const report = analyzeOpeningReportBytes(path, bytes, {
      focus: options.focus,
      playerId: options.playerId,
      fromTurn: options.fromTurn,
      toTurn: options.toTurn,
      limit: options.limit,
      failFast: options.failFast,
      hashResolver: createHashResolver({
        typesDbPath: options.typesDbPath,
        loadDefaultTypesDb: options.loadDefaultTypesDb,
      }),
    })
    return formatOpeningOutput(report, options)
  }

  if (options.command === 'science') {
    const report = analyzeScienceReportBytes(path, bytes, {
      focus: options.focus,
      playerId: options.playerId,
      turn: options.turn,
      limit: options.limit,
      failFast: options.failFast,
      hashResolver: createHashResolver({
        typesDbPath: options.typesDbPath,
        loadDefaultTypesDb: options.loadDefaultTypesDb,
      }),
    })
    return formatScienceOutput(report, options)
  }

  const timeline = analyzeAutosaveTimelineBytes(path, bytes, {
    limit: options.limit,
    failFast: options.failFast,
  })
  return formatParseOutput(timeline, options)
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: 'parse',
    path: null,
    comparePath: null,
    format: 'summary',
    out: null,
    focus: null,
    playerId: null,
    turn: null,
    fromTurn: null,
    toTurn: null,
    limit: null,
    compact: false,
    failFast: false,
    typesDbPath: null,
    loadDefaultTypesDb: true,
  }

  const rest = [...args]
  const first = rest[0]
  if (first === 'help' || first === '--help' || first === '-h') return { ...options, command: 'help' }
  if (first && isCliCommand(first)) {
    options.command = normalizeCliCommand(first)
    rest.shift()
  }

  while (rest.length > 0) {
    const arg = rest.shift()!
    if (arg === '--help' || arg === '-h') return { ...options, command: 'help' }
    if (arg === '--json') {
      options.format = 'json'
      continue
    }
    if (arg === '--jsonl') {
      options.format = 'jsonl'
      continue
    }
    if (arg === '--summary') {
      options.format = 'summary'
      continue
    }
    if (arg === '--format') {
      options.format = parseOutputFormat(readOptionValue(rest, arg))
      continue
    }
    if (arg === '--out' || arg === '-o') {
      options.out = readOptionValue(rest, arg)
      continue
    }
    if (arg === '--focus') {
      options.focus = readOptionValue(rest, arg)
      continue
    }
    if (arg === '--player-id') {
      options.playerId = parseNonNegativeInt(readOptionValue(rest, arg), arg)
      continue
    }
    if (arg === '--turn') {
      options.turn = parsePositiveInt(readOptionValue(rest, arg), arg)
      continue
    }
    if (arg === '--from-turn') {
      options.fromTurn = parsePositiveInt(readOptionValue(rest, arg), arg)
      continue
    }
    if (arg === '--to-turn') {
      options.toTurn = parsePositiveInt(readOptionValue(rest, arg), arg)
      continue
    }
    if (arg === '--limit') {
      options.limit = parsePositiveInt(readOptionValue(rest, arg), arg)
      continue
    }
    if (arg === '--compact') {
      options.compact = true
      continue
    }
    if (arg === '--fail-fast') {
      options.failFast = true
      continue
    }
    if (arg === '--types-db') {
      options.typesDbPath = readOptionValue(rest, arg)
      continue
    }
    if (arg === '--no-types-db') {
      options.loadDefaultTypesDb = false
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    if (!options.path) {
      options.path = arg
      continue
    }
    if (options.command === 'compare-opening' && !options.comparePath) {
      options.comparePath = arg
      continue
    }
    throw new Error(`Unexpected argument: ${arg}`)
  }

  return options
}

function formatParseOutput(timeline: CivupAutosaveTimeline, options: CliOptions): string {
  if (options.format === 'json') return `${JSON.stringify(timeline, null, options.compact ? 0 : 2)}\n`
  if (options.format === 'jsonl') return `${timeline.turns.map(turn => JSON.stringify({ source: timeline.source, ...turn })).join('\n')}\n`
  return formatParseSummary(timeline, options.focus)
}

function formatLobbyOutput(report: CivupLobbyReport, options: CliOptions): string {
  if (options.format === 'json') return `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`
  if (options.format === 'jsonl') return `${report.players.map(player => JSON.stringify({ source: report.source, saveName: report.saveName, gameRandomSeed: report.gameRandomSeed, mapRandomSeed: report.mapRandomSeed, ...player })).join('\n')}\n`
  return formatLobbySummary(report)
}

function formatSnapshotOutput(timeline: CivReplaySnapshotTimeline, options: CliOptions): string {
  if (options.format === 'json') return `${JSON.stringify(timeline, null, options.compact ? 0 : 2)}\n`
  if (options.format === 'jsonl') return `${timeline.snapshots.map(snapshot => JSON.stringify({ source: timeline.source, ...snapshot })).join('\n')}\n`
  return formatSnapshotSummary(timeline)
}

function formatOpeningOutput(report: ReturnType<typeof analyzeOpeningReportBytes>, options: CliOptions): string {
  if (options.format === 'json') return `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`
  if (options.format === 'jsonl') return `${report.turns.map(turn => JSON.stringify({ source: report.source, player: report.player, ...turn })).join('\n')}\n`
  return formatOpeningReportSummary(report)
}

function formatScienceOutput(report: ReturnType<typeof analyzeScienceReportBytes>, options: CliOptions): string {
  if (options.format === 'json') return `${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`
  if (options.format === 'jsonl') return `${report.players.map(player => JSON.stringify({ source: report.source, turn: report.turn, saveName: report.saveName, ...player })).join('\n')}\n`
  return formatScienceReportSummary(report)
}

function formatOpeningComparisonOutput(comparison: ReturnType<typeof compareOpeningReports>, options: CliOptions): string {
  if (options.format === 'json') return `${JSON.stringify(comparison, null, options.compact ? 0 : 2)}\n`
  if (options.format === 'jsonl') return `${comparison.keyTurns.map(turn => JSON.stringify({ baselineSide: comparison.baseline, subjectSide: comparison.subject, ...turn })).join('\n')}\n`
  return formatOpeningComparisonSummary(comparison)
}

function parseOpeningReportJson(text: string, path: string): CivupOpeningReport {
  const parsed = JSON.parse(text) as CivupOpeningReport
  if (parsed.tool !== 'civup-analyzer' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.turns) || !parsed.milestones) {
    throw new Error(`${path} is not a civup opening report JSON file`)
  }
  return parsed
}

function buildLobbyReport(timeline: CivupAutosaveTimeline): CivupLobbyReport {
  const firstTurn = timeline.turns[0] ?? null
  return {
    tool: 'civup-analyzer',
    schemaVersion: 1,
    source: timeline.source,
    sourceKind: timeline.sourceKind,
    generatedAt: new Date().toISOString(),
    saveName: firstTurn?.saveName ?? null,
    gameRandomSeed: firstTurn?.gameRandomSeed ?? timeline.summary.gameRandomSeeds[0] ?? null,
    mapRandomSeed: firstTurn?.mapRandomSeed ?? timeline.summary.mapRandomSeeds[0] ?? null,
    gameMode: firstTurn?.gameMode ?? timeline.summary.gameModes[0] ?? null,
    mapFile: firstTurn?.mapFile ?? null,
    players: (firstTurn?.players ?? timeline.summary.players).map(player => ({
      slot: player.slot,
      team: player.team,
      playerName: player.playerName,
      leader: player.leader,
      civilization: player.civilization,
    })).sort((left, right) => left.slot - right.slot),
  }
}

function formatLobbySummary(report: CivupLobbyReport): string {
  const lines: string[] = []
  lines.push('CivUp Lobby Setup')
  lines.push(`source: ${report.source}`)
  if (report.saveName) lines.push(`save: ${report.saveName}`)
  lines.push(`seeds: game random ${report.gameRandomSeed ?? '?'}, map random ${report.mapRandomSeed ?? '?'}`)
  if (report.gameMode || report.mapFile) lines.push(`settings: ${report.gameMode ?? '?'}${report.mapFile ? ` | ${report.mapFile}` : ''}`)
  lines.push('')
  lines.push('Slot Order')
  for (const player of report.players) {
    lines.push(`  slot ${player.slot} | team ${player.team ?? '?'} | ${player.playerName ?? 'AI'} | ${player.leader ?? 'unknown leader'} | ${player.civilization ?? 'unknown civ'}`)
  }
  lines.push('')
  lines.push('Teams')
  const teams = groupLobbyTeams(report.players)
  if (teams.length === 0) lines.push('  no team data found')
  for (const [team, players] of teams) lines.push(`  team ${team}: slots ${players.map(player => player.slot).join(', ')}`)
  return `${lines.join('\n')}\n`
}

function groupLobbyTeams(players: readonly CivupLobbyPlayer[]): Array<[number, CivupLobbyPlayer[]]> {
  const teams = new Map<number, CivupLobbyPlayer[]>()
  for (const player of players) {
    if (player.team == null) continue
    const team = teams.get(player.team) ?? []
    team.push(player)
    teams.set(player.team, team)
  }
  return [...teams.entries()].sort((left, right) => left[0] - right[0])
}

function formatParseSummary(timeline: CivupAutosaveTimeline, focus: string | null): string {
  const lines: string[] = []
  const summary = timeline.summary
  lines.push('CivUp Autosave Timeline')
  lines.push(`source: ${timeline.source}`)
  lines.push(`kind: ${timeline.sourceKind}`)
  lines.push(`saves: ${summary.parsedCount}/${summary.saveCount} parsed${summary.failureCount ? `, ${summary.failureCount} failed` : ''}`)
  lines.push(`turns: ${summary.firstTurn ?? '?'} -> ${summary.lastTurn ?? '?'}`)
  if (summary.gameRandomSeeds.length > 0 || summary.mapRandomSeeds.length > 0) lines.push(`seeds: game random ${formatNumberList(summary.gameRandomSeeds)}, map random ${formatNumberList(summary.mapRandomSeeds)}`)
  if (summary.gameModes.length > 0) lines.push(`modes: ${summary.gameModes.join(', ')}`)
  lines.push('')
  lines.push('Players')
  for (const player of summary.players) {
    lines.push(`  slot ${player.slot}${player.team == null ? '' : ` team ${player.team}`}: ${player.playerName ?? 'AI'} | ${player.leader ?? 'unknown leader'} | ${player.civilization ?? 'unknown civ'} | turns ${player.firstTurn ?? '?'}-${player.lastTurn ?? '?'}`)
  }

  if (focus) {
    const focusedPlayers = summary.players.filter(player => matchesFocus(player, focus))
    lines.push('')
    lines.push(`Focus: ${focus}`)
    if (focusedPlayers.length === 0) lines.push('  no matching players/leaders/civilizations found')
    for (const player of focusedPlayers) lines.push(`  slot ${player.slot}${player.team == null ? '' : ` team ${player.team}`}: ${player.playerName ?? 'AI'} | ${player.leader ?? 'unknown leader'} | ${player.civilization ?? 'unknown civ'} | ${player.seenTurns} turns`)
  }

  if (timeline.failures.length > 0) {
    lines.push('')
    lines.push('Failures')
    for (const failure of timeline.failures) lines.push(`  ${failure.saveName}: ${failure.error}`)
  }

  lines.push('')
  lines.push('Turn Snapshots')
  for (const turn of timeline.turns) lines.push(formatTurnLine(turn))
  return `${lines.join('\n')}\n`
}

function formatSnapshotSummary(timeline: CivReplaySnapshotTimeline): string {
  const lines: string[] = []
  const summary = timeline.summary
  lines.push('CivUp CivReplay Snapshot Parse')
  lines.push(`source: ${timeline.source}`)
  lines.push(`kind: ${timeline.sourceKind}`)
  lines.push(`saves: ${summary.parsedCount}/${summary.saveCount} parsed${summary.failureCount ? `, ${summary.failureCount} failed` : ''}`)
  lines.push(`turns: ${summary.firstTurn ?? '?'} -> ${summary.lastTurn ?? '?'}`)
  if (summary.minStateBlobBytes != null && summary.maxStateBlobBytes != null) {
    lines.push(`state blob: ${formatByteCount(summary.minStateBlobBytes)} -> ${formatByteCount(summary.maxStateBlobBytes)}`)
  }
  if (summary.gameRandomSeeds.length > 0 || summary.mapRandomSeeds.length > 0) lines.push(`seeds: game random ${formatNumberList(summary.gameRandomSeeds)}, map random ${formatNumberList(summary.mapRandomSeeds)}`)
  if (summary.mapWidths.length > 0 && summary.tileCounts.length > 0) {
    const widths = summary.mapWidths.join(',')
    const heights = summary.mapHeights.length ? summary.mapHeights.join(',') : '?'
    lines.push(`map: ${widths}x${heights}, tiles ${summary.tileCounts.join(',')}`)
  }
  if (summary.internalPlayerCounts.length > 0) {
    lines.push(`players: internal ${summary.internalPlayerCounts.join(',')}, cities ${formatRange(summary.cityCounts)}`)
  }
  if (summary.cityStateCounts.length > 0) {
    lines.push(`city-states: known ${formatRange(summary.cityStateCounts)}, alive ${formatRange(summary.cityStateAliveCounts)}, scientific ${formatRange(summary.cityStateScientificAliveCounts)}/${formatRange(summary.cityStateScientificCounts)} alive/known`)
  }

  if (timeline.failures.length > 0) {
    lines.push('')
    lines.push('Failures')
    for (const failure of timeline.failures) lines.push(`  ${failure.saveName}: ${failure.error}`)
  }

  lines.push('')
  lines.push('Snapshots')
  for (const snapshot of timeline.snapshots) lines.push(formatSnapshotLine(snapshot))
  return `${lines.join('\n')}\n`
}

function formatTurnLine(turn: CivupTurnSnapshot): string {
  const turnLabel = turn.gameTurn ?? turn.turnFromName ?? '?'
  const bbg = turn.bbgVersion ? ` BBG ${turn.bbgVersion}` : turn.bbgDetected ? ' BBG' : ''
  return `  T${turnLabel}: ${turn.saveName} | players ${turn.playerCount ?? '?'} | ${turn.gameMode ?? '?'}${bbg}`
}

function formatSnapshotLine(snapshot: CivReplayTurnSnapshot): string {
  const turnLabel = snapshot.turnFromName ?? '?'
  const height = snapshot.map.height ?? '?'
  const events = snapshot.events.length ? ` | events ${snapshot.events.length}` : ''
  const cityStates = snapshot.cityStates.count ? ` | city-states ${snapshot.cityStates.aliveCount}/${snapshot.cityStates.count} alive${snapshot.cityStates.scientificCount ? `, scientific ${snapshot.cityStates.scientificAliveCount}/${snapshot.cityStates.scientificCount}` : ''}` : ''
  return `  T${turnLabel}: ${snapshot.saveName} | map ${snapshot.map.width}x${height} ${snapshot.map.tileCount} tiles | owned ${snapshot.map.ownedTileCount} | cities ${snapshot.players.cityCount}${cityStates}${events} | state ${formatByteCount(snapshot.stateBlobInflatedSizeBytes)} | blobs ${snapshot.compressedBlobCount}`
}

function matchesFocus(player: { playerName: string | null, leader: string | null, civilization: string | null }, focus: string): boolean {
  const needle = normalize(focus)
  return [player.playerName, player.leader, player.civilization]
    .some(value => normalize(value ?? '').includes(needle))
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function readOptionValue(rest: string[], option: string): string {
  const value = rest.shift()
  if (!value) throw new Error(`${option} requires a value`)
  return value
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === 'summary' || value === 'json' || value === 'jsonl') return value
  throw new Error(`Invalid output format: ${value}`)
}

function parsePositiveInt(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`)
  return parsed
}

function parseNonNegativeInt(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer`)
  return parsed
}

function formatByteCount(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function formatRange(values: readonly number[]): string {
  if (values.length === 0) return '?'
  if (values.length === 1) return String(values[0])
  return `${values[0]} -> ${values.at(-1)}`
}

function formatNumberList(values: readonly number[]): string {
  return values.length ? values.join(', ') : '?'
}

function isCliCommand(value: string): boolean {
  return ['parse', 'timeline', 'autosaves', 'lobby', 'setup', 'slots', 'snapshot', 'snapshots', 'state', 'opening', 'open', 'science', 'sci', 'compare-opening', 'compare', 'compare-openings', 'help'].includes(value)
}

function normalizeCliCommand(value: string): CliCommand {
  if (value === 'timeline' || value === 'autosaves') return 'parse'
  if (value === 'lobby' || value === 'setup' || value === 'slots') return 'lobby'
  if (value === 'snapshot' || value === 'snapshots' || value === 'state') return 'snapshot'
  if (value === 'opening' || value === 'open') return 'opening'
  if (value === 'science' || value === 'sci') return 'science'
  if (value === 'compare-opening' || value === 'compare' || value === 'compare-openings') return 'compare-opening'
  if (value === 'parse') return 'parse'
  return 'help'
}

function printUsage() {
  console.log(`Usage:
  civup parse <autosaves.zip|save.Civ6Save> [options]
  civup lobby <autosaves.zip|save.Civ6Save> [options]
  civup snapshot <autosaves.zip|save.Civ6Save> [options]
  civup opening <autosaves.zip> --focus <player|leader|civ> [options]
  civup science <autosaves.zip|save.Civ6Save> [options]
  civup compare-opening <baseline-opening.json> <subject-opening.json> [options]

Options:
  --summary              Print a human-readable summary (default)
  --json                 Print JSON
  --jsonl                Print one JSON object per turn/save
  --format <format>      summary, json, or jsonl
  --out, -o <path>       Write output to a file
  --focus <text>         Highlight matching player, leader, or civilization in parse summary
  --player-id <n>        Select internal player id/slot for opening reports
  --turn <n>             Snapshot only one autosave turn
  --from-turn <n>        Opening report start turn (default 1)
  --to-turn <n>          Opening report end turn (default 50)
  --limit <n>            Parse only the first n autosaves
  --types-db <path>      Resolve hashes with a Civ VI DebugGameplay.sqlite file
  --no-types-db          Do not load the default local Civ VI DebugGameplay.sqlite
  --compact              Minify JSON output
  --fail-fast            Stop on the first parse failure
  --help, -h             Show this help

Examples:
  civup parse auto.zip
  civup lobby auto.zip
  civup parse auto.zip --jsonl --out timeline.jsonl
  civup parse auto.zip --focus Mikalai
  civup snapshot auto.zip --turn 35
  civup snapshot auto.zip --jsonl --out snapshots.jsonl
  civup opening auto.zip --focus Lincoln --to-turn 50
  civup science auto.zip --turn 70
  civup compare-opening expert-lincoln.json mine-lincoln.json
`)
}

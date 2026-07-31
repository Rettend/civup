/* eslint-disable no-console */
import type { Database } from '@civup/db'
import type { StatsContext } from '../src/services/stats/context.ts'
import {
  backfillCivLeaderboardStatsFromHistory,
  buildCivLeaderboardSnapshotFromD1,
  getCivLeaderboardStatsStatus,
  getStoredCivLeaderboardDisplayConfig,
  repairCivLeaderboardStatsFromContributions,
  rebuildCivLeaderboardSnapshots,
} from '../src/services/leaderboard/civ-snapshot.ts'
import { markLeaderboardsDirty } from '../src/services/leaderboard/message.ts'

export type CivLeaderboardBackfillCommand = 'preview' | 'apply'
export type CivLeaderboardBackfillSource = 'history' | 'contributions'

export interface CivLeaderboardBackfillOptions {
  command: CivLeaderboardBackfillCommand
  source?: CivLeaderboardBackfillSource
  execute: boolean
  json: boolean
  target: string
  config: string
  database: string
  db: Database
  kv: KVNamespace
  statsContext: StatsContext
  applyHint: string
  includeHistoricalPreview?: boolean
  onProgress?: (label: string) => void
}

interface ScriptResult {
  mode: CivLeaderboardBackfillCommand
  source: CivLeaderboardBackfillSource
  target: string
  config: string
  database: string
  before: unknown
  historical?: {
    completedMatchCount: number
    snapshotRowCount: number
  }
  backfill?: {
    scannedCompletedMatchCount: number
    scannedParticipantRowCount: number
    contributionRowCount: number
    civRowCount: number
    completedMatchCount: number
    snapshotRowCount: number
    snapshotUpdatedAt: number
  }
  after?: unknown
  message?: string
}

export async function runCivLeaderboardBackfill(options: CivLeaderboardBackfillOptions): Promise<void> {
  const source = options.source ?? 'history'
  options.onProgress?.('loading current status')
  const before = await getCivLeaderboardStatsStatus(options.db, options.statsContext, options.kv)

  if (options.command === 'preview') {
    const historical = source === 'history' && options.includeHistoricalPreview !== false
      ? await withProgress(options, 'scanning historical preview', () => buildCivLeaderboardSnapshotFromD1(options.db, options.statsContext))
      : undefined
    const result: ScriptResult = {
      mode: 'preview',
      source,
      target: options.target,
      config: options.config,
      database: options.database,
      before,
      message: `No D1 or KV writes were performed. Run ${options.applyHint} to rebuild civ leaderboard aggregates and KV snapshot.`,
    }
    if (historical) {
      result.historical = {
        completedMatchCount: historical.completedMatchCount,
        snapshotRowCount: historical.rows.length,
      }
    }
    printResult(result, options.json)
    return
  }

  if (!options.execute) {
    printResult({
      mode: 'apply',
      source,
      target: options.target,
      config: options.config,
      database: options.database,
      before,
      message: `Dry run only. Run ${options.applyHint} to mutate D1 and KV.`,
    }, options.json)
    return
  }

  const updatedAt = Date.now()
  options.onProgress?.('loading display config')
  const config = await getStoredCivLeaderboardDisplayConfig(options.kv, options.statsContext)
  options.onProgress?.(source === 'contributions' ? 'rebuilding aggregates from contribution rows' : 'rebuilding contribution rows from match history')
  const backfill = source === 'contributions'
    ? await repairCivLeaderboardStatsFromContributions(options.db, options.statsContext, updatedAt, config)
    : await backfillCivLeaderboardStatsFromHistory(options.db, options.statsContext, updatedAt, config)
  options.onProgress?.('writing scoped KV snapshots')
  const snapshots = await rebuildCivLeaderboardSnapshots(options.db, options.kv, options.statsContext, undefined, updatedAt)
  options.onProgress?.('marking civ leaderboards dirty')
  await markLeaderboardsDirty(options.db, options.statsContext, `script:civ-leaderboard:${source}`, { civ: true, now: dirtyTimestampBefore(updatedAt) })
  const snapshot = snapshots.get('all') ?? backfill.snapshot
  options.onProgress?.('loading final status')
  const after = await getCivLeaderboardStatsStatus(options.db, options.statsContext, options.kv)

  printResult({
    mode: 'apply',
    source,
    target: options.target,
    config: options.config,
    database: options.database,
    before,
    backfill: {
      scannedCompletedMatchCount: backfill.scannedCompletedMatchCount,
      scannedParticipantRowCount: backfill.scannedParticipantRowCount,
      contributionRowCount: backfill.contributionRowCount,
      civRowCount: backfill.civRowCount,
      completedMatchCount: backfill.snapshot.completedMatchCount,
      snapshotRowCount: snapshot.rows.length,
      snapshotUpdatedAt: snapshot.updatedAt,
    },
    after,
  }, options.json)
}

function printResult(result: ScriptResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Mode: ${result.mode}`)
  console.log(`Source: ${result.source}`)
  console.log(`Target: ${result.target}`)
  console.log(`Config: ${result.config}`)
  console.log(`Database: ${result.database}`)
  console.log('Before:')
  printObject(result.before)
  if (result.historical) {
    console.log('Historical scan:')
    printObject(result.historical)
  }
  if (result.backfill) {
    console.log('Backfill:')
    printObject(result.backfill)
  }
  if (result.after) {
    console.log('After:')
    printObject(result.after)
  }
  if (result.message) console.log(result.message)
}

function printObject(value: unknown): void {
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    console.log(`  ${key}: ${String(item)}`)
  }
}

function dirtyTimestampBefore(value: number): number {
  return Math.max(0, Math.round(value) - 1)
}

async function withProgress<T>(options: CivLeaderboardBackfillOptions, label: string, run: () => Promise<T>): Promise<T> {
  options.onProgress?.(label)
  return run()
}

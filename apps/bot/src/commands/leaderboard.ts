import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { Embed } from 'discord-hono'
import { createDb } from '@civup/db'
import { LEADERBOARD_MODE_CHOICES, LEADERBOARD_MODES, parseLeaderboardMode } from '@civup/game'
import { LEADERBOARD_MIN_GAMES } from '@civup/rating'
import { Command, Option } from 'discord-hono'
import { leaderboardEmbed } from '../embeds/leaderboard.ts'
import { teamLeaderboardEmbed } from '../embeds/team-leaderboard.ts'
import { ensureLeaderboardModeSnapshot, ensureLeaderboardModeSnapshots } from '../services/leaderboard/snapshot.ts'
import {
  ensureTeamLeaderboardBucketSnapshots,
  TEAM_LEADERBOARD_BUCKETS,
  TEAM_LEADERBOARD_MIN_GAMES,
  type TeamLeaderboardBucket,
} from '../services/leaderboard/team-snapshot.ts'
import { createStateStore } from '../services/state/store.ts'
import { factory } from '../setup.ts'

type LeaderboardView = 'players' | 'teams'
type TeamLeaderboardSize = 'all' | '3v3' | '4v4'

interface Var {
  mode?: string
  view?: string
  size?: string
}

const LEADERBOARD_VIEW_CHOICES = [
  { name: 'Players', value: 'players' },
  { name: 'Teams', value: 'teams' },
] as const

const TEAM_LEADERBOARD_SIZE_CHOICES = [
  { name: 'All Squad Sizes', value: 'all' },
  { name: '3v3 Only', value: '3v3' },
  { name: '4v4 Only', value: '4v4' },
] as const

export const command_leaderboard = factory.command<Var>(
  new Command('leaderboard', 'Show the top players or teams').options(
    new Option('mode', 'Leaderboard track')
      .choices(...LEADERBOARD_MODE_CHOICES),
    new Option('view', 'Leaderboard view')
      .choices(...LEADERBOARD_VIEW_CHOICES),
    new Option('size', 'Squad team size for team view')
      .choices(...TEAM_LEADERBOARD_SIZE_CHOICES),
  ),
  (c) => {
    const requestedMode = c.var.mode ? parseLeaderboardMode(c.var.mode) : null
    const view = parseLeaderboardView(c.var.view) ?? 'players'
    const teamSize = parseTeamLeaderboardSize(c.var.size) ?? 'all'

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const kv = createStateStore(c.env)
      const payload = await buildLeaderboardCommandPayload(db, kv, requestedMode, {
        view,
        teamSize,
      })
      await c.followup(payload)
    })
  },
)

export async function buildLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  requestedMode: LeaderboardMode | null,
  options: {
    view?: LeaderboardView
    teamSize?: TeamLeaderboardSize
  } = {},
): Promise<{ embeds?: Embed[], content?: string }> {
  if ((options.view ?? 'players') === 'teams') {
    return await buildTeamLeaderboardCommandPayload(db, kv, requestedMode, options.teamSize ?? 'all')
  }

  return await buildPlayerLeaderboardCommandPayload(db, kv, requestedMode)
}

async function buildPlayerLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  requestedMode: LeaderboardMode | null,
): Promise<{ embeds?: Embed[], content?: string }> {
  if (requestedMode) {
    const snapshot = await ensureLeaderboardModeSnapshot(db, kv, requestedMode)
    return { embeds: [leaderboardEmbed(requestedMode, snapshot.rows)] }
  }

  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, LEADERBOARD_MODES)
  const embeds = LEADERBOARD_MODES.flatMap((mode) => {
    const snapshot = snapshots.get(mode)
    if (!snapshot || !snapshot.rows.some(row => row.gamesPlayed >= LEADERBOARD_MIN_GAMES)) return []
    return [leaderboardEmbed(mode, snapshot.rows)]
  })

  if (embeds.length === 0) {
    return { content: 'No players with enough games to rank yet.' }
  }

  return { embeds }
}

async function buildTeamLeaderboardCommandPayload(
  db: Database,
  kv: KVNamespace,
  requestedMode: LeaderboardMode | null,
  teamSize: TeamLeaderboardSize,
): Promise<{ embeds?: Embed[], content?: string }> {
  const requested = resolveRequestedTeamLeaderboardBuckets(requestedMode, teamSize)
  if ('error' in requested) return { content: requested.error }

  const snapshots = await ensureTeamLeaderboardBucketSnapshots(db, kv, requested.buckets)
  const visibleBuckets = requested.explicit
    ? requested.buckets
    : requested.buckets.filter((bucket) => {
        const snapshot = snapshots.get(bucket)
        return snapshot?.rows.some(row => row.gamesPlayed >= TEAM_LEADERBOARD_MIN_GAMES) ?? false
      })
  const buckets = visibleBuckets.length > 0 ? visibleBuckets : requested.buckets

  const embeds = buckets.map((bucket) => {
    const snapshot = snapshots.get(bucket)
    return teamLeaderboardEmbed(bucket, snapshot?.rows ?? [])
  })

  return { embeds }
}

function parseLeaderboardView(value: string | null | undefined): LeaderboardView | null {
  if (value === 'players' || value === 'teams') return value
  return null
}

function parseTeamLeaderboardSize(value: string | null | undefined): TeamLeaderboardSize | null {
  if (value === 'all' || value === '3v3' || value === '4v4') return value
  return null
}

function resolveRequestedTeamLeaderboardBuckets(
  requestedMode: LeaderboardMode | null,
  teamSize: TeamLeaderboardSize,
): { buckets: TeamLeaderboardBucket[], explicit: boolean } | { error: string } {
  if (requestedMode && requestedMode !== 'duo' && requestedMode !== 'squad') {
    return { error: 'Team leaderboards are only available for Duo and Squad.' }
  }

  if (requestedMode === 'duo') {
    if (teamSize !== 'all') {
      return { error: 'Squad size filters only apply to Squad team leaderboards.' }
    }

    return { buckets: ['duo'], explicit: true }
  }

  if (requestedMode === 'squad') {
    if (teamSize === '3v3') return { buckets: ['squad-3v3'], explicit: true }
    if (teamSize === '4v4') return { buckets: ['squad-4v4'], explicit: true }
    return { buckets: ['squad-3v3', 'squad-4v4'], explicit: true }
  }

  if (teamSize === '3v3') return { buckets: ['squad-3v3'], explicit: true }
  if (teamSize === '4v4') return { buckets: ['squad-4v4'], explicit: true }

  return { buckets: [...TEAM_LEADERBOARD_BUCKETS], explicit: false }
}

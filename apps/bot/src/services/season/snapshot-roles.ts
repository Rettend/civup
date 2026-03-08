import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { matches, matchParticipants, seasonPeakModeRanks, seasonPeakRanks, seasons } from '@civup/db'
import { COMPETITIVE_TIERS, toLeaderboardMode } from '@civup/game'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { createGuildRole, deleteGuildRole, DiscordApiError, editGuildMemberRoles } from '../discord/index.ts'
import { fetchGuildMemberRoleIds, fetchGuildRoles, formatRankedRoleSlotLabel, getConfiguredRankedRoleLabel, getRankedRoleConfig } from '../ranked/roles.ts'
import { formatSeasonShortName } from './index.ts'

interface StoredSeasonSnapshotRoleMappings {
  bySeasonId?: Record<string, {
    seasonNumber?: unknown
    seasonName?: unknown
    roles?: Partial<Record<CompetitiveTier, unknown>>
  }>
}

export interface SeasonSnapshotRoleMappings {
  bySeasonId: Record<string, {
    seasonNumber: number
    seasonName: string
    roles: Record<CompetitiveTier, string | null>
  }>
}

export interface SeasonRankHistoryModeSummary {
  mode: LeaderboardMode
  tier: CompetitiveTier | null
  tierLabel: string
  tierRoleId: string | null
  rating: number
  gamesPlayed: number
  wins: number
}

export interface SeasonRankHistoryEntry {
  seasonId: string
  seasonNumber: number
  seasonName: string
  modes: Partial<Record<LeaderboardMode, SeasonRankHistoryModeSummary>>
}

const SEASON_SNAPSHOT_ROLE_KEY_PREFIX = 'ranked-roles:season-snapshots:'
const SEASON_SNAPSHOT_ROLE_WINDOW = 4

export async function getSeasonSnapshotRoleMappings(kv: KVNamespace, guildId: string): Promise<SeasonSnapshotRoleMappings> {
  const raw = await kv.get(snapshotRolesKey(guildId), 'json') as StoredSeasonSnapshotRoleMappings | null
  return normalizeSeasonSnapshotRoleMappings(raw)
}

export async function ensureSeasonSnapshotRoles(
  kv: KVNamespace,
  guildId: string,
  token: string,
  season: { id: string, seasonNumber: number, name: string },
): Promise<Record<CompetitiveTier, string>> {
  const [mappings, guildRoles, config] = await Promise.all([
    getSeasonSnapshotRoleMappings(kv, guildId),
    fetchGuildRoles(token, guildId),
    getRankedRoleConfig(kv, guildId),
  ])

  const existing = mappings.bySeasonId[season.id]
  const guildRoleById = new Map(guildRoles.map(role => [role.id, role]))
  const guildRoleByName = new Map(guildRoles.map(role => [role.name, role]))

  const roles = {
    pleb: null,
    squire: null,
    gladiator: null,
    legion: null,
    champion: null,
  } as Record<CompetitiveTier, string | null>

  for (const tier of COMPETITIVE_TIERS) {
    const existingRoleId = existing?.roles[tier] ?? null
    const sourceRoleId = config.currentRoles[tier]
    const sourceRole = sourceRoleId ? guildRoleById.get(sourceRoleId) : null
    const roleLabel = sourceRole?.name ?? getConfiguredRankedRoleLabel(config, tier) ?? formatRankedRoleSlotLabel(tier)
    const roleName = formatSeasonSnapshotRoleName(season.seasonNumber, roleLabel)
    const legacyRoleName = formatLegacySeasonSnapshotRoleName(season.name, roleLabel)
    const mappedRole = existingRoleId ? guildRoleById.get(existingRoleId) : null
    if (mappedRole && (mappedRole.name === roleName || mappedRole.name === legacyRoleName)) {
      roles[tier] = existingRoleId
      continue
    }

    const existingRole = guildRoleByName.get(roleName) ?? guildRoleByName.get(legacyRoleName)
    if (existingRole) {
      roles[tier] = existingRole.id
      continue
    }

    const created = await createGuildRole(token, guildId, {
      name: roleName,
      color: normalizeDiscordColor(sourceRole?.color ?? config.currentRoleMeta[tier].color),
    })
    roles[tier] = created.id
  }

  mappings.bySeasonId[season.id] = {
    seasonNumber: season.seasonNumber,
    seasonName: season.name,
    roles,
  }
  await setSeasonSnapshotRoleMappings(kv, guildId, mappings)

  return coerceRequiredRoles(roles)
}

export async function finalizeSeasonSnapshotRoles(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  token: string,
  season: { id: string, seasonNumber: number, name: string },
): Promise<void> {
  const roleIdsByTier = await ensureSeasonSnapshotRoles(kv, guildId, token, season)
  const rows = await db
    .select({ playerId: seasonPeakRanks.playerId, tier: seasonPeakRanks.tier })
    .from(seasonPeakRanks)
    .where(eq(seasonPeakRanks.seasonId, season.id))

  const seasonRoleIds = Object.values(roleIdsByTier)
  for (const row of rows) {
    const tier = row.tier as CompetitiveTier
    const desiredRoleId = roleIdsByTier[tier]
    if (!desiredRoleId) continue

    try {
      const roleIds = await fetchGuildMemberRoleIds(token, guildId, row.playerId)
      const nextRoleIds = roleIds.filter(roleId => !seasonRoleIds.includes(roleId))
      nextRoleIds.push(desiredRoleId)
      nextRoleIds.sort((a, b) => a.localeCompare(b))
      if (sameStringArray([...roleIds].sort((a, b) => a.localeCompare(b)), nextRoleIds)) continue
      await editGuildMemberRoles(token, guildId, row.playerId, nextRoleIds)
    }
    catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) continue
      throw error
    }
  }

  await trimExpiredSeasonSnapshotRoles(db, kv, guildId, token)
}

export async function listPlayerSeasonSnapshotHistory(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  playerId: string,
): Promise<SeasonRankHistoryEntry[]> {
  const [rows, matchRows, mappings] = await Promise.all([
    db
      .select({
        seasonId: seasonPeakModeRanks.seasonId,
        seasonNumber: seasons.seasonNumber,
        seasonName: seasons.name,
        mode: seasonPeakModeRanks.mode,
        tier: seasonPeakModeRanks.tier,
        rating: seasonPeakModeRanks.rating,
      })
      .from(seasonPeakModeRanks)
      .innerJoin(seasons, eq(seasonPeakModeRanks.seasonId, seasons.id))
      .where(eq(seasonPeakModeRanks.playerId, playerId))
      .orderBy(desc(seasons.seasonNumber)),
    db
      .select({
        seasonId: matches.seasonId,
        gameMode: matches.gameMode,
        placement: matchParticipants.placement,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(
        eq(matchParticipants.playerId, playerId),
        eq(matches.status, 'completed'),
      )),
    getSeasonSnapshotRoleMappings(kv, guildId),
  ])

  const seasonMatchStats = new Map<string, Partial<Record<LeaderboardMode, { gamesPlayed: number, wins: number }>>>()
  for (const row of matchRows) {
    if (!row.seasonId) continue
    const mode = toLeaderboardMode(row.gameMode as 'ffa' | '1v1' | '2v2' | '3v3')
    const seasonStats = seasonMatchStats.get(row.seasonId) ?? {}
    const modeStats = seasonStats[mode] ?? { gamesPlayed: 0, wins: 0 }
    modeStats.gamesPlayed += 1
    if (row.placement === 1) modeStats.wins += 1
    seasonStats[mode] = modeStats
    seasonMatchStats.set(row.seasonId, seasonStats)
  }

  const historyBySeasonId = new Map<string, SeasonRankHistoryEntry>()
  for (const row of rows) {
    const mode = row.mode as LeaderboardMode
    const seasonEntry = historyBySeasonId.get(row.seasonId) ?? {
      seasonId: row.seasonId,
      seasonNumber: row.seasonNumber,
      seasonName: row.seasonName,
      modes: {},
    }

    const stats = seasonMatchStats.get(row.seasonId)?.[mode]
    if (!stats || stats.gamesPlayed <= 0) continue

    const tier = row.tier as CompetitiveTier | null
    seasonEntry.modes[mode] = {
      mode,
      tier,
      tierLabel: tier ? formatRankedRoleSlotLabel(tier) : 'Unranked',
      tierRoleId: tier ? mappings.bySeasonId[row.seasonId]?.roles[tier] ?? null : null,
      rating: row.rating,
      gamesPlayed: stats.gamesPlayed,
      wins: stats.wins,
    }
    historyBySeasonId.set(row.seasonId, seasonEntry)
  }

  return [...historyBySeasonId.values()]
    .filter(season => Object.keys(season.modes).length > 0)
    .sort((left, right) => right.seasonNumber - left.seasonNumber)
}

export function formatSeasonSnapshotRoleName(seasonNumber: number, roleLabel: string): string {
  return `${formatSeasonShortName(seasonNumber)} ${roleLabel}`
}

async function trimExpiredSeasonSnapshotRoles(
  db: Database,
  kv: KVNamespace,
  guildId: string,
  token: string,
): Promise<void> {
  const [mappings, recentSeasons] = await Promise.all([
    getSeasonSnapshotRoleMappings(kv, guildId),
    db.select({ id: seasons.id }).from(seasons).orderBy(desc(seasons.seasonNumber)).limit(SEASON_SNAPSHOT_ROLE_WINDOW),
  ])

  const keepSeasonIds = new Set(recentSeasons.map(season => season.id))
  const expiredSeasonIds = Object.keys(mappings.bySeasonId).filter(seasonId => !keepSeasonIds.has(seasonId))
  if (expiredSeasonIds.length === 0) return

  const expiredRows = await db
    .select({ seasonId: seasonPeakRanks.seasonId, playerId: seasonPeakRanks.playerId })
    .from(seasonPeakRanks)
    .where(inArray(seasonPeakRanks.seasonId, expiredSeasonIds))

  const playerIdsBySeasonId = new Map<string, Set<string>>()
  for (const row of expiredRows) {
    const existing = playerIdsBySeasonId.get(row.seasonId) ?? new Set<string>()
    existing.add(row.playerId)
    playerIdsBySeasonId.set(row.seasonId, existing)
  }

  for (const seasonId of expiredSeasonIds) {
    const mapping = mappings.bySeasonId[seasonId]
    if (!mapping) continue

    const roleIds = COMPETITIVE_TIERS
      .map(tier => mapping.roles[tier])
      .filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0)

    const playerIds = [...(playerIdsBySeasonId.get(seasonId) ?? new Set<string>())]
    for (const playerId of playerIds) {
      try {
        const memberRoleIds = await fetchGuildMemberRoleIds(token, guildId, playerId)
        const nextRoleIds = memberRoleIds.filter(roleId => !roleIds.includes(roleId))
        nextRoleIds.sort((a, b) => a.localeCompare(b))
        if (sameStringArray([...memberRoleIds].sort((a, b) => a.localeCompare(b)), nextRoleIds)) continue
        await editGuildMemberRoles(token, guildId, playerId, nextRoleIds)
      }
      catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) continue
        throw error
      }
    }

    for (const roleId of roleIds) {
      try {
        await deleteGuildRole(token, guildId, roleId)
      }
      catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) continue
        throw error
      }
    }

    delete mappings.bySeasonId[seasonId]
  }

  await setSeasonSnapshotRoleMappings(kv, guildId, mappings)
}

async function setSeasonSnapshotRoleMappings(kv: KVNamespace, guildId: string, mappings: SeasonSnapshotRoleMappings): Promise<void> {
  await kv.put(snapshotRolesKey(guildId), JSON.stringify(mappings))
}

function snapshotRolesKey(guildId: string): string {
  return `${SEASON_SNAPSHOT_ROLE_KEY_PREFIX}${guildId}`
}

function formatLegacySeasonSnapshotRoleName(seasonName: string, roleLabel: string): string {
  return `${seasonName} ${roleLabel}`
}

function normalizeSeasonSnapshotRoleMappings(raw: StoredSeasonSnapshotRoleMappings | null | undefined): SeasonSnapshotRoleMappings {
  const bySeasonId: SeasonSnapshotRoleMappings['bySeasonId'] = {}
  for (const [seasonId, value] of Object.entries(raw?.bySeasonId ?? {})) {
    if (!seasonId) continue
    bySeasonId[seasonId] = {
      seasonNumber: typeof value.seasonNumber === 'number' && Number.isFinite(value.seasonNumber)
        ? Math.max(0, Math.round(value.seasonNumber))
        : 0,
      seasonName: typeof value.seasonName === 'string' ? value.seasonName : seasonId,
      roles: {
        pleb: normalizeRoleId(value.roles?.pleb),
        squire: normalizeRoleId(value.roles?.squire),
        gladiator: normalizeRoleId(value.roles?.gladiator),
        legion: normalizeRoleId(value.roles?.legion),
        champion: normalizeRoleId(value.roles?.champion),
      },
    }
  }

  return { bySeasonId }
}

function normalizeRoleId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null
}

function normalizeDiscordColor(value: string | null): number | undefined {
  if (!value) return undefined
  const normalized = value.startsWith('#') ? value.slice(1) : value
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return undefined
  const parsed = Number.parseInt(normalized, 16)
  return Number.isFinite(parsed) ? parsed : undefined
}

function coerceRequiredRoles(roles: Record<CompetitiveTier, string | null>): Record<CompetitiveTier, string> {
  const next = {} as Record<CompetitiveTier, string>
  for (const tier of COMPETITIVE_TIERS) {
    const roleId = roles[tier]
    if (!roleId) throw new Error(`Missing season snapshot role for ${tier}.`)
    next[tier] = roleId
  }
  return next
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

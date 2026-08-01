import type { Database } from '@civup/db'
import type { CivLobbySettingsCommunityPreset, CivLobbySettingsProfile } from '@civup/game'
import { gameSettingsPresets } from '@civup/db'
import {
  CIV_LOBBY_SETTINGS_COMMUNITY_PRESET_LIST_LIMIT,
  CIV_LOBBY_SETTINGS_SCHEMA_VERSION,
  normalizeCivLobbySettingsPresetName,
  normalizeCivLobbySettingsProfile,
} from '@civup/game'
import { and, desc, eq } from 'drizzle-orm'

export type GameSettingsPresetWriteResult
  = | { ok: true, preset: CivLobbySettingsCommunityPreset }
    | { ok: false, reason: 'limit' | 'conflict' | 'not-found' | 'forbidden' | 'stale' }

export async function listGameSettingsPresets(
  db: Database,
  limit = CIV_LOBBY_SETTINGS_COMMUNITY_PRESET_LIST_LIMIT,
): Promise<CivLobbySettingsCommunityPreset[]> {
  const boundedLimit = Math.max(1, Math.min(CIV_LOBBY_SETTINGS_COMMUNITY_PRESET_LIST_LIMIT, Math.round(limit)))
  const rows = await db.select().from(gameSettingsPresets)
    .orderBy(desc(gameSettingsPresets.updatedAt), desc(gameSettingsPresets.id))
    .limit(boundedLimit)
  return rows.flatMap(parsePresetRow)
}

export async function getGameSettingsPresetById(
  db: Database,
  id: string,
): Promise<CivLobbySettingsCommunityPreset | null> {
  const [row] = await db.select().from(gameSettingsPresets).where(eq(gameSettingsPresets.id, id)).limit(1)
  return row ? parsePresetRow(row)[0] ?? null : null
}

export async function createGameSettingsPreset(
  db: Database,
  input: {
    ownerDiscordUserId: string
    ownerDisplayName: string | null
    name: unknown
    profile: unknown
    now?: number
  },
): Promise<GameSettingsPresetWriteResult> {
  const normalizedName = normalizeCivLobbySettingsPresetName(input.name)
  const profile = normalizeCivLobbySettingsProfile(input.profile)
  const now = normalizeTimestamp(input.now)
  const id = crypto.randomUUID()
  try {
    const [created] = await db.insert(gameSettingsPresets).values({
      id,
      ownerDiscordUserId: input.ownerDiscordUserId,
      ownerDisplayName: normalizeOwnerDisplayName(input.ownerDisplayName),
      name: normalizedName.name,
      normalizedName: normalizedName.normalizedName,
      profileJson: JSON.stringify(profile),
      schemaVersion: CIV_LOBBY_SETTINGS_SCHEMA_VERSION,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }).returning()
    return created ? { ok: true, preset: parsePresetRow(created)[0]! } : { ok: false, reason: 'conflict' }
  }
  catch (error) {
    if (hasErrorMessage(error, /game settings preset owner limit/i)) return { ok: false, reason: 'limit' }
    if (isUniqueConstraintError(error)) return { ok: false, reason: 'conflict' }
    throw error
  }
}

export async function updateGameSettingsPreset(
  db: Database,
  input: {
    id: string
    ownerDiscordUserId: string
    revision: number
    name?: unknown
    profile?: unknown
    ownerDisplayName?: string | null
    now?: number
  },
): Promise<GameSettingsPresetWriteResult> {
  const existing = await getGameSettingsPresetById(db, input.id)
  if (!existing) return { ok: false, reason: 'not-found' }
  if (existing.ownerDiscordUserId !== input.ownerDiscordUserId) return { ok: false, reason: 'forbidden' }
  if (existing.revision !== input.revision) return { ok: false, reason: 'stale' }

  const normalizedName = input.name === undefined
    ? { name: existing.name, normalizedName: normalizeCivLobbySettingsPresetName(existing.name).normalizedName }
    : normalizeCivLobbySettingsPresetName(input.name)
  const profile = input.profile === undefined ? existing.profile : normalizeCivLobbySettingsProfile(input.profile)
  try {
    const [updated] = await db.update(gameSettingsPresets).set({
      ownerDisplayName: input.ownerDisplayName === undefined ? existing.ownerDisplayName : normalizeOwnerDisplayName(input.ownerDisplayName),
      name: normalizedName.name,
      normalizedName: normalizedName.normalizedName,
      profileJson: JSON.stringify(profile),
      schemaVersion: CIV_LOBBY_SETTINGS_SCHEMA_VERSION,
      revision: existing.revision + 1,
      updatedAt: normalizeTimestamp(input.now),
    }).where(and(
      eq(gameSettingsPresets.id, input.id),
      eq(gameSettingsPresets.ownerDiscordUserId, input.ownerDiscordUserId),
      eq(gameSettingsPresets.revision, input.revision),
    )).returning()
    return updated ? { ok: true, preset: parsePresetRow(updated)[0]! } : { ok: false, reason: 'stale' }
  }
  catch (error) {
    if (isUniqueConstraintError(error)) return { ok: false, reason: 'conflict' }
    throw error
  }
}

export async function deleteGameSettingsPreset(
  db: Database,
  input: { id: string, ownerDiscordUserId: string, revision: number },
): Promise<Exclude<GameSettingsPresetWriteResult, { ok: true }> | { ok: true }> {
  const existing = await getGameSettingsPresetById(db, input.id)
  if (!existing) return { ok: false, reason: 'not-found' }
  if (existing.ownerDiscordUserId !== input.ownerDiscordUserId) return { ok: false, reason: 'forbidden' }
  if (existing.revision !== input.revision) return { ok: false, reason: 'stale' }
  const deleted = await db.delete(gameSettingsPresets).where(and(
    eq(gameSettingsPresets.id, input.id),
    eq(gameSettingsPresets.ownerDiscordUserId, input.ownerDiscordUserId),
    eq(gameSettingsPresets.revision, input.revision),
  )).returning({ id: gameSettingsPresets.id })
  return deleted.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}

function parsePresetRow(row: typeof gameSettingsPresets.$inferSelect): CivLobbySettingsCommunityPreset[] {
  try {
    if (row.schemaVersion !== CIV_LOBBY_SETTINGS_SCHEMA_VERSION || !Number.isInteger(row.revision) || row.revision < 1) return []
    const profile = normalizeCivLobbySettingsProfile(JSON.parse(row.profileJson) as unknown)
    return [{
      id: row.id,
      ownerDiscordUserId: row.ownerDiscordUserId,
      ownerDisplayName: row.ownerDisplayName,
      name: row.name,
      profile,
      schemaVersion: CIV_LOBBY_SETTINGS_SCHEMA_VERSION,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }]
  }
  catch {
    return []
  }
}

function normalizeTimestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.round(value)) : Date.now()
}

function normalizeOwnerDisplayName(value: string | null): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized ? normalized.slice(0, 80) : null
}

function isUniqueConstraintError(error: unknown): boolean {
  return hasErrorMessage(error, /unique constraint|constraint failed/i)
}

function hasErrorMessage(error: unknown, pattern: RegExp): boolean {
  let candidate: unknown = error
  for (let depth = 0; depth < 4 && candidate; depth += 1) {
    if (candidate instanceof Error && pattern.test(candidate.message)) return true
    candidate = typeof candidate === 'object' && 'cause' in candidate ? candidate.cause : null
  }
  return false
}

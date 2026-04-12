import type { CompetitiveTier, GameMode, LeaderDataVersion } from '@civup/game'
import type { LobbyDraftConfig, LobbyState, StoredLobbyState } from './types.ts'
import { defaultPlayerCount, MAX_LEADER_POOL_SIZE, normalizeAvailableLeaderDataVersion, playerCountOptions, requiresRedDeathDuplicateFactions } from '@civup/game'
import { nanoid } from 'nanoid'
import { normalizeRankedRoleTierId } from '../ranked/roles.ts'
import { normalizeSteamLobbyLink } from '../steam-link.ts'

export const DEFAULT_DRAFT_CONFIG: LobbyDraftConfig = {
  banTimerSeconds: null,
  pickTimerSeconds: null,
  leaderPoolSize: null,
  leaderDataVersion: 'live',
  simultaneousPick: false,
  redDeath: false,
  dealOptionsSize: null,
  randomDraft: false,
  duplicateFactions: false,
}

export function parseLobbyState(raw: unknown): LobbyState | null {
  if (!raw || typeof raw !== 'object') return null
  return normalizeLobby(raw as StoredLobbyState)
}

export function normalizeLobby(raw: StoredLobbyState | LobbyState): LobbyState {
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
    ? Math.round(raw.createdAt)
    : Date.now()
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    ? Math.round(raw.updatedAt)
    : createdAt

  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : nanoid(10),
    createdAt,
    updatedAt,
    guildId: normalizeGuildId(raw.guildId),
    steamLobbyLink: normalizeSteamLobbyLink(raw.steamLobbyLink),
    slots: normalizeStoredSlots(raw.mode, raw.slots),
    draftConfig: normalizeDraftConfigForMode(raw.mode, raw.draftConfig),
    minRole: normalizeCompetitiveTier(raw.minRole),
    maxRole: normalizeCompetitiveTier(raw.maxRole),
    lastActivityAt: normalizeLobbyLastActivityAt(
      raw.lastActivityAt,
      'lastJoinedAt' in raw ? raw.lastJoinedAt : undefined,
      updatedAt,
      createdAt,
    ),
    memberPlayerIds: normalizeMemberPlayerIds(raw.memberPlayerIds),
    revision: normalizeLobbyRevision(raw.revision),
  }
}

export function createEmptySlots(mode: GameMode): (string | null)[] {
  return Array.from({ length: defaultPlayerCount(mode) }, () => null)
}

export function normalizeStoredSlots(mode: GameMode, value: unknown): (string | null)[] {
  const targetSize = resolveStoredSlotCount(mode, value)
  const normalized = Array.from({ length: targetSize }, () => null as string | null)

  if (!Array.isArray(value)) return normalized

  const seen = new Set<string>()
  for (let i = 0; i < targetSize; i++) {
    const raw = value[i]
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    normalized[i] = trimmed
    seen.add(trimmed)
  }

  return normalized
}

export function normalizeDraftConfig(config: Partial<LobbyDraftConfig> | LobbyDraftConfig | null | undefined): LobbyDraftConfig {
  return {
    banTimerSeconds: normalizeTimerSeconds(config?.banTimerSeconds),
    pickTimerSeconds: normalizeTimerSeconds(config?.pickTimerSeconds),
    leaderPoolSize: normalizeLeaderPoolSize(config?.leaderPoolSize),
    leaderDataVersion: normalizeLeaderDataVersion(config?.leaderDataVersion),
    simultaneousPick: normalizeSimultaneousPick(config?.simultaneousPick),
    redDeath: normalizeRedDeath(config?.redDeath),
    dealOptionsSize: normalizeDealOptionsSize(config?.dealOptionsSize),
    randomDraft: normalizeRandomDraft(config?.randomDraft),
    duplicateFactions: normalizeDuplicateFactions(config?.duplicateFactions),
  }
}

export function normalizeDraftConfigForMode(
  mode: GameMode,
  config: Partial<LobbyDraftConfig> | LobbyDraftConfig | null | undefined,
): LobbyDraftConfig {
  const normalized = normalizeDraftConfig(config)
  const redDeath = normalized.redDeath
  return {
    ...normalized,
    leaderPoolSize: redDeath ? null : normalized.leaderPoolSize,
    leaderDataVersion: redDeath ? 'live' : normalized.leaderDataVersion,
    simultaneousPick: mode === 'ffa' && !redDeath ? normalized.simultaneousPick : false,
    redDeath,
    dealOptionsSize: redDeath ? normalized.dealOptionsSize : null,
    randomDraft: redDeath ? normalized.randomDraft : false,
    duplicateFactions: redDeath ? (requiresRedDeathDuplicateFactions(mode) || normalized.duplicateFactions) : false,
  }
}

export function normalizeMemberPlayerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

export function normalizeCompetitiveTier(value: unknown): CompetitiveTier | null {
  return normalizeRankedRoleTierId(value)
}

export function normalizeLobbyRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : 1
}

export function normalizeLobbyLastActivityAt(
  value: unknown,
  legacyValue: unknown,
  updatedAt: number,
  createdAt: number,
): number {
  for (const candidate of [value, legacyValue]) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue
    const rounded = Math.round(candidate)
    if (rounded > 0) return rounded
  }
  return updatedAt > 0 ? updatedAt : createdAt
}

export function sameDraftConfig(a: LobbyDraftConfig, b: LobbyDraftConfig): boolean {
  return a.banTimerSeconds === b.banTimerSeconds
    && a.pickTimerSeconds === b.pickTimerSeconds
    && a.leaderPoolSize === b.leaderPoolSize
    && a.leaderDataVersion === b.leaderDataVersion
    && a.simultaneousPick === b.simultaneousPick
    && a.redDeath === b.redDeath
    && a.dealOptionsSize === b.dealOptionsSize
    && a.randomDraft === b.randomDraft
    && a.duplicateFactions === b.duplicateFactions
}

function resolveStoredSlotCount(mode: GameMode, value: unknown): number {
  if (!Array.isArray(value)) return defaultPlayerCount(mode)

  const slotCount = Math.round(value.length)
  if (mode === 'ffa' && slotCount === 10) return slotCount
  return playerCountOptions(mode).includes(slotCount) ? slotCount : defaultPlayerCount(mode)
}

export function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function normalizeGuildId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeTimerSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= 0 ? rounded : null
}

function normalizeLeaderPoolSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 1 || rounded > MAX_LEADER_POOL_SIZE) return null
  return rounded
}

function normalizeLeaderDataVersion(value: unknown): LeaderDataVersion {
  return normalizeAvailableLeaderDataVersion(value === 'beta' ? 'beta' : 'live')
}

function normalizeSimultaneousPick(value: unknown): boolean {
  return value === true
}

function normalizeRedDeath(value: unknown): boolean {
  return value === true
}

function normalizeDealOptionsSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < 2 || rounded > 10) return null
  return rounded
}

function normalizeRandomDraft(value: unknown): boolean {
  return value === true
}

function normalizeDuplicateFactions(value: unknown): boolean {
  return value === true
}

import type { CompetitiveTier, GameMode } from '@civup/game'
import type { LobbyDraftConfig, LobbyState, StoredLobbyState } from './types.ts'
import { MAX_LEADER_POOL_SIZE, maxPlayerCount } from '@civup/game'
import { nanoid } from 'nanoid'
import { normalizeSteamLobbyLink } from '../steam-link.ts'
import { normalizeRankedRoleTierId } from '../ranked/roles.ts'

export const DEFAULT_DRAFT_CONFIG: LobbyDraftConfig = {
  banTimerSeconds: null,
  pickTimerSeconds: null,
  leaderPoolSize: null,
}

export function parseLobbyState(raw: unknown): LobbyState | null {
  if (!raw || typeof raw !== 'object') return null
  return normalizeLobby(raw as StoredLobbyState)
}

export function normalizeLobby(raw: StoredLobbyState | LobbyState): LobbyState {
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : nanoid(10),
    guildId: normalizeGuildId(raw.guildId),
    steamLobbyLink: normalizeSteamLobbyLink(raw.steamLobbyLink),
    slots: normalizeStoredSlots(raw.mode, raw.slots),
    draftConfig: normalizeDraftConfig(raw.draftConfig),
    minRole: normalizeCompetitiveTier(raw.minRole),
    memberPlayerIds: normalizeMemberPlayerIds(raw.memberPlayerIds),
    revision: normalizeLobbyRevision(raw.revision),
  }
}

export function createEmptySlots(mode: GameMode): (string | null)[] {
  return Array.from({ length: maxPlayerCount(mode) }, () => null)
}

export function normalizeStoredSlots(mode: GameMode, value: unknown): (string | null)[] {
  const targetSize = maxPlayerCount(mode)
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

export function sameDraftConfig(a: LobbyDraftConfig, b: LobbyDraftConfig): boolean {
  return a.banTimerSeconds === b.banTimerSeconds
    && a.pickTimerSeconds === b.pickTimerSeconds
    && a.leaderPoolSize === b.leaderPoolSize
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

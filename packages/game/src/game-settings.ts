import type { GameMode } from './types.ts'
import { GAME_MODES } from './types.ts'
import { getLeaderIds } from './leader-registry.ts'

export const CIV_LOBBY_SETTINGS_SCHEMA_VERSION = 1 as const
export const CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES = 16_384
export const CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS = 32
export const CIV_LOBBY_SETTINGS_MAX_COMMUNITY_PRESETS_PER_OWNER = 10
export const CIV_LOBBY_SETTINGS_COMMUNITY_PRESET_LIST_LIMIT = 50
export const CIV_LOBBY_SETTINGS_PRESET_NAME_MIN_LENGTH = 2
export const CIV_LOBBY_SETTINGS_PRESET_NAME_MAX_LENGTH = 40
export const CIV_LOBBY_SETTINGS_LIMITS = Object.freeze({
  hutFrequencyMultiplier: Object.freeze({ min: 0.25, max: 5 }),
  mphTimerBaseSeconds: Object.freeze({ min: 0, max: 600 }),
  mphTimerSecondsPerAverageCity: Object.freeze({ min: 0, max: 60 }),
  mphTimerSecondsPerAverageUnit: Object.freeze({ min: 0, max: 60 }),
})

export type CivLobbyRidges = 'classic' | 'standard'

export interface CivLobbyMphTimerFormula {
  baseSeconds: number
  secondsPerAverageCity: number
  secondsPerAverageUnit: number
}

export interface CivLobbyCompetitiveBans {
  defenderOfTheFaith: boolean
  godOfTheForge: boolean
  colosseum: boolean
  templeOfArtemis: boolean
}

export interface CivLobbySettings {
  hutFrequencyMultiplier: number
  diplomaticVictory: boolean
  culturalVictory: boolean
  ridges: CivLobbyRidges
  mphTimer: CivLobbyMphTimerFormula
  competitiveBans: CivLobbyCompetitiveBans
  autoBannedLeaderIds: string[]
}

export interface CivLobbySettingsOverride {
  hutFrequencyMultiplier?: number
  diplomaticVictory?: boolean
  culturalVictory?: boolean
  ridges?: CivLobbyRidges
  mphTimer?: Partial<CivLobbyMphTimerFormula>
  competitiveBans?: Partial<CivLobbyCompetitiveBans>
  autoBannedLeaderIds?: string[]
}

export interface CivLobbySettingsProfile {
  schemaVersion: typeof CIV_LOBBY_SETTINGS_SCHEMA_VERSION
  base: CivLobbySettings
  modeOverrides: Partial<Record<GameMode, CivLobbySettingsOverride>>
}

export type CivLobbySettingsPresetKind = 'official' | 'community' | 'custom'

export interface CivLobbySettingsPresetMetadata {
  kind: CivLobbySettingsPresetKind
  id: string | null
  name: string
  revision: number | null
}

export interface AppliedCivLobbySettings {
  profile: CivLobbySettingsProfile
  preset: CivLobbySettingsPresetMetadata
}

export interface CivLobbySettingsCommunityPreset {
  id: string
  ownerDiscordUserId: string
  ownerDisplayName: string | null
  name: string
  profile: CivLobbySettingsProfile
  schemaVersion: typeof CIV_LOBBY_SETTINGS_SCHEMA_VERSION
  revision: number
  createdAt: number
  updatedAt: number
}

export class CivLobbySettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CivLobbySettingsValidationError'
  }
}

const SETTINGS_KEYS = ['hutFrequencyMultiplier', 'diplomaticVictory', 'culturalVictory', 'ridges', 'mphTimer', 'competitiveBans', 'autoBannedLeaderIds'] as const
const TIMER_KEYS = ['baseSeconds', 'secondsPerAverageCity', 'secondsPerAverageUnit'] as const
const COMPETITIVE_BAN_KEYS = ['defenderOfTheFaith', 'godOfTheForge', 'colosseum', 'templeOfArtemis'] as const
const VALID_LEADER_IDS = new Set([...getLeaderIds('live'), ...getLeaderIds('beta')])

const OFFICIAL_PROFILE_INPUT: CivLobbySettingsProfile = {
  schemaVersion: CIV_LOBBY_SETTINGS_SCHEMA_VERSION,
  base: {
    hutFrequencyMultiplier: 1.75,
    diplomaticVictory: false,
    culturalVictory: false,
    ridges: 'standard',
    mphTimer: {
      baseSeconds: 30,
      secondsPerAverageCity: 2,
      secondsPerAverageUnit: 0.5,
    },
    competitiveBans: {
      defenderOfTheFaith: true,
      godOfTheForge: true,
      colosseum: true,
      templeOfArtemis: true,
    },
    autoBannedLeaderIds: [],
  },
  modeOverrides: {},
}

/** Immutable built-in profile used without a database read. */
export const OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE = deepFreeze(normalizeCivLobbySettingsProfile(OFFICIAL_PROFILE_INPUT))
export const OFFICIAL_PPL_CIV_LOBBY_SETTINGS_NAME = 'Official PPL preset'
export const OFFICIAL_PPL_APPLIED_CIV_LOBBY_SETTINGS: AppliedCivLobbySettings = deepFreeze({
  profile: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
  preset: {
    kind: 'official',
    id: null,
    name: OFFICIAL_PPL_CIV_LOBBY_SETTINGS_NAME,
    revision: null,
  },
})

/** Strictly validates and returns a canonical, detached profile. */
export function normalizeCivLobbySettingsProfile(value: unknown): CivLobbySettingsProfile {
  assertRawProfileSize(value)
  const profile = requireRecord(value, 'Game settings profile')
  assertKnownKeys(profile, ['schemaVersion', 'base', 'modeOverrides'], 'Game settings profile')
  if (profile.schemaVersion !== CIV_LOBBY_SETTINGS_SCHEMA_VERSION) {
    throw new CivLobbySettingsValidationError(`Game settings schemaVersion must be ${CIV_LOBBY_SETTINGS_SCHEMA_VERSION}.`)
  }

  const normalized: CivLobbySettingsProfile = {
    schemaVersion: CIV_LOBBY_SETTINGS_SCHEMA_VERSION,
    base: normalizeSettings(profile.base),
    modeOverrides: normalizeModeOverrides(profile.modeOverrides),
  }
  if (profileJsonByteLength(normalized) > CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES) {
    throw new CivLobbySettingsValidationError(`Game settings profile must be at most ${CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES} bytes.`)
  }
  return normalized
}

/** Resolves a profile's sparse override for one draft game mode. */
export function resolveCivLobbySettings(profile: CivLobbySettingsProfile, mode: GameMode): CivLobbySettings {
  const normalized = normalizeCivLobbySettingsProfile(profile)
  const override = normalized.modeOverrides[mode]
  if (!override) return cloneSettings(normalized.base)
  return {
    ...normalized.base,
    ...override,
    mphTimer: {
      ...normalized.base.mphTimer,
      ...override.mphTimer,
    },
    competitiveBans: {
      ...normalized.base.competitiveBans,
      ...override.competitiveBans,
    },
    autoBannedLeaderIds: override.autoBannedLeaderIds
      ? [...override.autoBannedLeaderIds]
      : [...normalized.base.autoBannedLeaderIds],
  }
}

export function civLobbySettingsProfilesEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(normalizeCivLobbySettingsProfile(left)) === JSON.stringify(normalizeCivLobbySettingsProfile(right))
  }
  catch {
    return false
  }
}

/** Normalizes persisted applied settings; missing or invalid legacy values use Official in memory. */
export function normalizeAppliedCivLobbySettings(value: unknown): AppliedCivLobbySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return cloneOfficialAppliedSettings()
  const candidate = value as { profile?: unknown, preset?: unknown }
  try {
    const profile = normalizeCivLobbySettingsProfile(candidate.profile)
    const preset = normalizePresetMetadata(candidate.preset)
    return { profile, preset }
  }
  catch {
    return cloneOfficialAppliedSettings()
  }
}

export function createAppliedCivLobbySettings(
  profile: unknown,
  preset: CivLobbySettingsPresetMetadata,
): AppliedCivLobbySettings {
  return {
    profile: normalizeCivLobbySettingsProfile(profile),
    preset: normalizePresetMetadata(preset),
  }
}

export function cloneOfficialAppliedSettings(): AppliedCivLobbySettings {
  return {
    profile: normalizeCivLobbySettingsProfile(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE),
    preset: { ...OFFICIAL_PPL_APPLIED_CIV_LOBBY_SETTINGS.preset },
  }
}

export function profileJsonByteLength(profile: CivLobbySettingsProfile): number {
  return new TextEncoder().encode(JSON.stringify(profile)).byteLength
}

export function normalizeCivLobbySettingsPresetName(value: unknown): { name: string, normalizedName: string } {
  if (typeof value !== 'string') throw new CivLobbySettingsValidationError('Preset name is required.')
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (name.length < CIV_LOBBY_SETTINGS_PRESET_NAME_MIN_LENGTH || name.length > CIV_LOBBY_SETTINGS_PRESET_NAME_MAX_LENGTH) {
    throw new CivLobbySettingsValidationError(`Preset name must be ${CIV_LOBBY_SETTINGS_PRESET_NAME_MIN_LENGTH}-${CIV_LOBBY_SETTINGS_PRESET_NAME_MAX_LENGTH} characters.`)
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _'’.-]*$/u.test(name)) {
    throw new CivLobbySettingsValidationError('Preset name contains unsupported characters.')
  }
  const normalizedName = name.toLocaleLowerCase('en-US')
  if (/\b(?:official|default)\b/u.test(normalizedName)) {
    throw new CivLobbySettingsValidationError('Preset names cannot use reserved Official or default wording.')
  }
  return { name, normalizedName }
}

function normalizeSettings(value: unknown): CivLobbySettings {
  const settings = requireRecord(value, 'Base game settings')
  assertKnownKeys(settings, SETTINGS_KEYS, 'Base game settings')
  return {
    hutFrequencyMultiplier: requireBoundedNumber(settings.hutFrequencyMultiplier, CIV_LOBBY_SETTINGS_LIMITS.hutFrequencyMultiplier, 'Hut frequency multiplier'),
    diplomaticVictory: requireBoolean(settings.diplomaticVictory, 'Diplomatic victory'),
    culturalVictory: requireBoolean(settings.culturalVictory, 'Cultural victory'),
    ridges: requireRidges(settings.ridges),
    mphTimer: normalizeTimer(settings.mphTimer, false),
    competitiveBans: normalizeCompetitiveBans(settings.competitiveBans, false),
    autoBannedLeaderIds: normalizeLeaderIds(settings.autoBannedLeaderIds),
  }
}

function normalizeModeOverrides(value: unknown): Partial<Record<GameMode, CivLobbySettingsOverride>> {
  if (value == null) return {}
  const overrides = requireRecord(value, 'Mode overrides')
  assertKnownKeys(overrides, GAME_MODES, 'Mode overrides')
  const normalized: Partial<Record<GameMode, CivLobbySettingsOverride>> = {}
  for (const mode of GAME_MODES) {
    if (overrides[mode] == null) continue
    normalized[mode] = normalizeOverride(overrides[mode], mode)
  }
  return normalized
}

function normalizeOverride(value: unknown, mode: GameMode): CivLobbySettingsOverride {
  const override = requireRecord(value, `${mode} override`)
  assertKnownKeys(override, SETTINGS_KEYS, `${mode} override`)
  const normalized: CivLobbySettingsOverride = {}
  if ('hutFrequencyMultiplier' in override) normalized.hutFrequencyMultiplier = requireBoundedNumber(override.hutFrequencyMultiplier, CIV_LOBBY_SETTINGS_LIMITS.hutFrequencyMultiplier, 'Hut frequency multiplier')
  if ('diplomaticVictory' in override) normalized.diplomaticVictory = requireBoolean(override.diplomaticVictory, 'Diplomatic victory')
  if ('culturalVictory' in override) normalized.culturalVictory = requireBoolean(override.culturalVictory, 'Cultural victory')
  if ('ridges' in override) normalized.ridges = requireRidges(override.ridges)
  if ('mphTimer' in override) normalized.mphTimer = normalizeTimer(override.mphTimer, true)
  if ('competitiveBans' in override) normalized.competitiveBans = normalizeCompetitiveBans(override.competitiveBans, true)
  if ('autoBannedLeaderIds' in override) normalized.autoBannedLeaderIds = normalizeLeaderIds(override.autoBannedLeaderIds)
  return normalized
}

function normalizeTimer(value: unknown, sparse: false): CivLobbyMphTimerFormula
function normalizeTimer(value: unknown, sparse: true): Partial<CivLobbyMphTimerFormula>
function normalizeTimer(value: unknown, sparse: boolean): CivLobbyMphTimerFormula | Partial<CivLobbyMphTimerFormula> {
  const timer = requireRecord(value, 'MPH timer formula')
  assertKnownKeys(timer, TIMER_KEYS, 'MPH timer formula')
  if (!sparse) {
    return {
      baseSeconds: requireBoundedNumber(timer.baseSeconds, CIV_LOBBY_SETTINGS_LIMITS.mphTimerBaseSeconds, 'MPH base seconds'),
      secondsPerAverageCity: requireBoundedNumber(timer.secondsPerAverageCity, CIV_LOBBY_SETTINGS_LIMITS.mphTimerSecondsPerAverageCity, 'MPH seconds per average city'),
      secondsPerAverageUnit: requireBoundedNumber(timer.secondsPerAverageUnit, CIV_LOBBY_SETTINGS_LIMITS.mphTimerSecondsPerAverageUnit, 'MPH seconds per average unit'),
    }
  }
  const normalized: Partial<CivLobbyMphTimerFormula> = {}
  if ('baseSeconds' in timer) normalized.baseSeconds = requireBoundedNumber(timer.baseSeconds, CIV_LOBBY_SETTINGS_LIMITS.mphTimerBaseSeconds, 'MPH base seconds')
  if ('secondsPerAverageCity' in timer) normalized.secondsPerAverageCity = requireBoundedNumber(timer.secondsPerAverageCity, CIV_LOBBY_SETTINGS_LIMITS.mphTimerSecondsPerAverageCity, 'MPH seconds per average city')
  if ('secondsPerAverageUnit' in timer) normalized.secondsPerAverageUnit = requireBoundedNumber(timer.secondsPerAverageUnit, CIV_LOBBY_SETTINGS_LIMITS.mphTimerSecondsPerAverageUnit, 'MPH seconds per average unit')
  return normalized
}

function normalizeCompetitiveBans(value: unknown, sparse: false): CivLobbyCompetitiveBans
function normalizeCompetitiveBans(value: unknown, sparse: true): Partial<CivLobbyCompetitiveBans>
function normalizeCompetitiveBans(value: unknown, sparse: boolean): CivLobbyCompetitiveBans | Partial<CivLobbyCompetitiveBans> {
  const bans = requireRecord(value, 'Competitive bans')
  assertKnownKeys(bans, COMPETITIVE_BAN_KEYS, 'Competitive bans')
  if (!sparse) {
    return {
      defenderOfTheFaith: requireBoolean(bans.defenderOfTheFaith, 'Defender of the Faith ban'),
      godOfTheForge: requireBoolean(bans.godOfTheForge, 'God of the Forge ban'),
      colosseum: requireBoolean(bans.colosseum, 'Colosseum ban'),
      templeOfArtemis: requireBoolean(bans.templeOfArtemis, 'Temple of Artemis ban'),
    }
  }
  const normalized: Partial<CivLobbyCompetitiveBans> = {}
  for (const key of COMPETITIVE_BAN_KEYS) {
    if (key in bans) normalized[key] = requireBoolean(bans[key], `${key} ban`)
  }
  return normalized
}

function normalizeLeaderIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CivLobbySettingsValidationError('Automatically excluded leaders must be an array.')
  if (value.length > CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS) {
    throw new CivLobbySettingsValidationError(`At most ${CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS} leaders can be automatically excluded.`)
  }
  const ids = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.trim() !== candidate || !VALID_LEADER_IDS.has(candidate)) {
      throw new CivLobbySettingsValidationError(`Unknown leader ID: ${String(candidate)}`)
    }
    ids.add(candidate)
  }
  if (ids.size > CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS) {
    throw new CivLobbySettingsValidationError(`At most ${CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS} leaders can be automatically excluded.`)
  }
  return [...ids].sort((left, right) => left.localeCompare(right))
}

function assertRawProfileSize(value: unknown): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  }
  catch {
    throw new CivLobbySettingsValidationError('Game settings profile must be valid JSON.')
  }
  if (serialized == null || new TextEncoder().encode(serialized).byteLength > CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES) {
    throw new CivLobbySettingsValidationError(`Game settings profile must be at most ${CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES} bytes.`)
  }
}

function normalizePresetMetadata(value: unknown): CivLobbySettingsPresetMetadata {
  const preset = requireRecord(value, 'Applied preset metadata')
  assertKnownKeys(preset, ['kind', 'id', 'name', 'revision'], 'Applied preset metadata')
  if (preset.kind !== 'official' && preset.kind !== 'community' && preset.kind !== 'custom') {
    throw new CivLobbySettingsValidationError('Applied preset kind is invalid.')
  }
  const name = typeof preset.name === 'string' ? preset.name.trim() : ''
  if (!name || name.length > 40) throw new CivLobbySettingsValidationError('Applied preset name is invalid.')
  const id = preset.kind === 'community' && typeof preset.id === 'string' && preset.id.length > 0 ? preset.id : null
  if (preset.kind === 'community' && !id) throw new CivLobbySettingsValidationError('Community preset ID is required.')
  const revision = preset.kind === 'community' && Number.isInteger(preset.revision) && Number(preset.revision) > 0 ? Number(preset.revision) : null
  if (preset.kind === 'community' && revision == null) throw new CivLobbySettingsValidationError('Community preset revision is required.')
  return { kind: preset.kind, id, name, revision }
}

function cloneSettings(settings: CivLobbySettings): CivLobbySettings {
  return {
    ...settings,
    mphTimer: { ...settings.mphTimer },
    competitiveBans: { ...settings.competitiveBans },
    autoBannedLeaderIds: [...settings.autoBannedLeaderIds],
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CivLobbySettingsValidationError(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function assertKnownKeys(value: Record<string, unknown>, known: readonly string[], label: string): void {
  const allowed = new Set(known)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) throw new CivLobbySettingsValidationError(`${label} contains an unknown field: ${unknown}.`)
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CivLobbySettingsValidationError(`${label} must be true or false.`)
  return value
}

function requireRidges(value: unknown): CivLobbyRidges {
  if (value !== 'classic' && value !== 'standard') throw new CivLobbySettingsValidationError('Ridges must be classic or standard.')
  return value
}

function requireBoundedNumber(value: unknown, limits: { min: number, max: number }, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limits.min || value > limits.max) {
    throw new CivLobbySettingsValidationError(`${label} must be between ${limits.min} and ${limits.max}.`)
  }
  return Math.round(value * 100) / 100
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

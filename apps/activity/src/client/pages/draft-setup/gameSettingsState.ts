import type { CivLobbySettings, CivLobbySettingsOverride, CivLobbySettingsProfile, GameMode } from '@civup/game'

export function cloneGameSettingsProfile(profile: CivLobbySettingsProfile): CivLobbySettingsProfile {
  return structuredClone(profile)
}

export function setGameSettingsModeOverrideEnabled(
  profile: CivLobbySettingsProfile,
  mode: GameMode,
  enabled: boolean,
): CivLobbySettingsProfile {
  const next = cloneGameSettingsProfile(profile)
  if (enabled) next.modeOverrides[mode] ??= {}
  else delete next.modeOverrides[mode]
  return next
}

export function updateGameSettingsForMode(
  profile: CivLobbySettingsProfile,
  mode: GameMode,
  settings: CivLobbySettings,
): CivLobbySettingsProfile {
  const next = cloneGameSettingsProfile(profile)
  if (next.modeOverrides[mode] == null) {
    next.base = cloneSettings(settings)
    return next
  }
  next.modeOverrides[mode] = buildSparseOverride(next.base, settings)
  return next
}

export function buildSparseOverride(base: CivLobbySettings, settings: CivLobbySettings): CivLobbySettingsOverride {
  const override: CivLobbySettingsOverride = {}
  if (settings.hutFrequencyMultiplier !== base.hutFrequencyMultiplier) override.hutFrequencyMultiplier = settings.hutFrequencyMultiplier
  if (settings.diplomaticVictory !== base.diplomaticVictory) override.diplomaticVictory = settings.diplomaticVictory
  if (settings.culturalVictory !== base.culturalVictory) override.culturalVictory = settings.culturalVictory
  if (settings.ridges !== base.ridges) override.ridges = settings.ridges

  const mphTimer: CivLobbySettingsOverride['mphTimer'] = {}
  if (settings.mphTimer.baseSeconds !== base.mphTimer.baseSeconds) mphTimer.baseSeconds = settings.mphTimer.baseSeconds
  if (settings.mphTimer.secondsPerAverageCity !== base.mphTimer.secondsPerAverageCity) mphTimer.secondsPerAverageCity = settings.mphTimer.secondsPerAverageCity
  if (settings.mphTimer.secondsPerAverageUnit !== base.mphTimer.secondsPerAverageUnit) mphTimer.secondsPerAverageUnit = settings.mphTimer.secondsPerAverageUnit
  if (Object.keys(mphTimer).length > 0) override.mphTimer = mphTimer

  const competitiveBans: CivLobbySettingsOverride['competitiveBans'] = {}
  for (const key of ['defenderOfTheFaith', 'godOfTheForge', 'colosseum', 'templeOfArtemis'] as const) {
    if (settings.competitiveBans[key] !== base.competitiveBans[key]) competitiveBans[key] = settings.competitiveBans[key]
  }
  if (Object.keys(competitiveBans).length > 0) override.competitiveBans = competitiveBans
  if (settings.autoBannedLeaderIds.join('\0') !== base.autoBannedLeaderIds.join('\0')) override.autoBannedLeaderIds = [...settings.autoBannedLeaderIds]
  return override
}

function cloneSettings(settings: CivLobbySettings): CivLobbySettings {
  return {
    ...settings,
    mphTimer: { ...settings.mphTimer },
    competitiveBans: { ...settings.competitiveBans },
    autoBannedLeaderIds: [...settings.autoBannedLeaderIds],
  }
}

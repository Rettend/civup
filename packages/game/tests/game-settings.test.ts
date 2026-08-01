import {
  civLobbySettingsProfilesEqual,
  cloneOfficialAppliedSettings,
  normalizeAppliedCivLobbySettings,
  normalizeCivLobbySettingsProfile,
  OFFICIAL_PPL_CIV_LOBBY_SETTINGS_NAME,
  OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
  resolveCivLobbySettings,
} from '../src/index.ts'
import { describe, expect, test } from 'bun:test'

describe('game settings profiles', () => {
  test('normalizes leader IDs and sparse mode overrides canonically', () => {
    const leaderIds = ['zulu-shaka', 'america-abraham-lincoln']
    const profile = normalizeCivLobbySettingsProfile({
      ...OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
      base: {
        ...OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE.base,
        autoBannedLeaderIds: [leaderIds[0], leaderIds[1], leaderIds[0]],
      },
      modeOverrides: {
        '3v3': { hutFrequencyMultiplier: 2, mphTimer: { baseSeconds: 45 } },
      },
    })

    expect(profile.base.autoBannedLeaderIds).toEqual([...leaderIds].sort())
    expect(resolveCivLobbySettings(profile, '2v2').hutFrequencyMultiplier).toBe(1.75)
    expect(resolveCivLobbySettings(profile, '3v3')).toMatchObject({
      hutFrequencyMultiplier: 2,
      mphTimer: { baseSeconds: 45, secondsPerAverageCity: 2, secondsPerAverageUnit: 0.5 },
    })
  })

  test('compares normalized profiles and rejects unknown or invalid leader IDs', () => {
    const reordered = {
      ...OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
      base: {
        ...OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE.base,
        autoBannedLeaderIds: [],
      },
    }
    expect(civLobbySettingsProfilesEqual(reordered, OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE)).toBe(true)
    expect(() => normalizeCivLobbySettingsProfile({
      ...reordered,
      base: { ...reordered.base, autoBannedLeaderIds: ['not-a-real-leader'] },
    })).toThrow('Unknown leader ID')
    expect(() => normalizeCivLobbySettingsProfile({ ...reordered, futureField: true })).toThrow('unknown field')
    expect(() => normalizeCivLobbySettingsProfile({
      ...reordered,
      base: { ...reordered.base, autoBannedLeaderIds: Array.from({ length: 33 }, () => 'zulu-shaka') },
    })).toThrow('At most 32 leaders')
    expect(() => normalizeCivLobbySettingsProfile({
      ...reordered,
      modeOverrides: { ffa: { futureField: 'x'.repeat(17_000) } },
    })).toThrow('at most 16384 bytes')
  })

  test('contains the settled immutable Official PPL values', () => {
    const settings = resolveCivLobbySettings(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE, '2v2')
    expect(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_NAME).toBe('Official PPL preset')
    expect(settings).toEqual({
      hutFrequencyMultiplier: 1.75,
      diplomaticVictory: false,
      culturalVictory: false,
      ridges: 'standard',
      mphTimer: { baseSeconds: 30, secondsPerAverageCity: 2, secondsPerAverageUnit: 0.5 },
      competitiveBans: {
        defenderOfTheFaith: true,
        godOfTheForge: true,
        colosseum: true,
        templeOfArtemis: true,
      },
      autoBannedLeaderIds: [],
    })
    expect(Object.isFrozen(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE)).toBe(true)
  })

  test('falls back legacy applied settings to a detached Official copy', () => {
    const first = normalizeAppliedCivLobbySettings(undefined)
    const second = cloneOfficialAppliedSettings()
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.profile).not.toBe(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE)
  })
})

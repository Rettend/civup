import { OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE, resolveCivLobbySettings } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { setGameSettingsModeOverrideEnabled, updateGameSettingsForMode } from '../src/client/pages/draft-setup/gameSettingsState.ts'

describe('game settings editor state', () => {
  test('keeps base values shared and writes sparse mode overrides', () => {
    const withOverride = setGameSettingsModeOverrideEnabled(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE, '3v3', true)
    const updated = updateGameSettingsForMode(withOverride, '3v3', {
      ...resolveCivLobbySettings(withOverride, '3v3'),
      hutFrequencyMultiplier: 2,
    })

    expect(updated.base.hutFrequencyMultiplier).toBe(1.75)
    expect(updated.modeOverrides['3v3']).toEqual({ hutFrequencyMultiplier: 2 })
    expect(resolveCivLobbySettings(updated, '2v2').hutFrequencyMultiplier).toBe(1.75)
    expect(resolveCivLobbySettings(updated, '3v3').hutFrequencyMultiplier).toBe(2)
    expect(setGameSettingsModeOverrideEnabled(updated, '3v3', false).modeOverrides['3v3']).toBeUndefined()
  })
})

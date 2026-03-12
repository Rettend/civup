import { describe, expect, test } from 'bun:test'
import { normalizeSteamLobbyLink, parseSteamLobbyLink, STEAM_LOBBY_LINK_ERROR } from '../../src/services/steam-link.ts'

describe('steam lobby link parsing', () => {
  test('accepts valid Civ 6 Steam lobby links', () => {
    expect(parseSteamLobbyLink('steam://joinlobby/289070/12345678901234567/76561198000000000')).toBe(
      'steam://joinlobby/289070/12345678901234567/76561198000000000',
    )
  })

  test('treats nullish or blank values as cleared links', () => {
    expect(parseSteamLobbyLink(null)).toBeNull()
    expect(parseSteamLobbyLink('   ')).toBeNull()
    expect(normalizeSteamLobbyLink('   ')).toBeNull()
  })

  test('rejects links for other protocols or app ids', () => {
    expect(parseSteamLobbyLink('https://example.com')).toBeUndefined()
    expect(parseSteamLobbyLink('steam://joinlobby/480/123/76561198000000000')).toBeUndefined()
    expect(STEAM_LOBBY_LINK_ERROR).toContain('steam://joinlobby/289070/')
  })
})

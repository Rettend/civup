import type { GameMode } from '@civup/game'

export const LOBBY_ID_KEY_PREFIX = 'lobby:id:'
export const LOBBY_MODE_KEY_PREFIX = 'lobby:mode:'
export const LOBBY_MATCH_KEY_PREFIX = 'lobby:match:'
export const LOBBY_TTL = 24 * 60 * 60

export function idKey(lobbyId: string): string {
  return `${LOBBY_ID_KEY_PREFIX}${lobbyId}`
}

export function modeIndexKey(mode: GameMode, lobbyId: string): string {
  return `${LOBBY_MODE_KEY_PREFIX}${mode}:${lobbyId}`
}

export function modePrefix(mode: GameMode): string {
  return `${LOBBY_MODE_KEY_PREFIX}${mode}:`
}

export function matchKey(matchId: string): string {
  return `${LOBBY_MATCH_KEY_PREFIX}${matchId}`
}

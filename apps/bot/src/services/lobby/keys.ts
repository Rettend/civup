import type { GameMode } from '@civup/game'

export const LOBBY_ID_KEY_PREFIX = 'lobby:id:'
export const LOBBY_MODE_KEY_PREFIX = 'lobby:mode:'
export const LOBBY_CHANNEL_KEY_PREFIX = 'lobby:channel:'
export const LOBBY_MATCH_KEY_PREFIX = 'lobby:match:'
export const LOBBY_DRAFT_ROSTER_KEY_PREFIX = 'lobby:draft-roster:'
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

export function channelIndexKey(channelId: string, lobbyId: string): string {
  return `${LOBBY_CHANNEL_KEY_PREFIX}${channelId}:${lobbyId}`
}

export function channelPrefix(channelId: string): string {
  return `${LOBBY_CHANNEL_KEY_PREFIX}${channelId}:`
}

export function matchKey(matchId: string): string {
  return `${LOBBY_MATCH_KEY_PREFIX}${matchId}`
}

export function draftRosterKey(lobbyId: string): string {
  return `${LOBBY_DRAFT_ROSTER_KEY_PREFIX}${lobbyId}`
}

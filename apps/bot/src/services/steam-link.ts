export const CIV6_STEAM_APP_ID = '289070'
export const MAX_STEAM_LOBBY_LINK_LENGTH = 120

const STEAM_LOBBY_LINK_PATTERN = new RegExp(`^steam://joinlobby/${CIV6_STEAM_APP_ID}/([1-9][0-9]{0,19})/([1-9][0-9]{0,19})$`)

export const STEAM_LOBBY_LINK_ERROR = `steam_link must use steam://joinlobby/${CIV6_STEAM_APP_ID}/<lobbyId>/<steamId64>`

export function parseSteamLobbyLink(value: unknown): string | null | undefined {
  if (value == null) return null
  if (typeof value !== 'string') return undefined

  const normalized = value.trim()
  if (normalized.length === 0) return null
  if (normalized.length > MAX_STEAM_LOBBY_LINK_LENGTH) return undefined
  if (!STEAM_LOBBY_LINK_PATTERN.test(normalized)) return undefined
  return normalized
}

export function normalizeSteamLobbyLink(value: unknown): string | null {
  const parsed = parseSteamLobbyLink(value)
  return parsed === undefined ? null : parsed
}

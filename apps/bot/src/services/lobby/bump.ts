import { bumpCooldownKey, LOBBY_TTL } from './keys.ts'

export const LOBBY_BUMP_COOLDOWN_MS = 60_000

export async function getLobbyBumpCooldownRemainingMs(
  kv: KVNamespace,
  lobbyId: string,
  options?: {
    now?: number
  },
): Promise<number> {
  const now = options?.now ?? Date.now()
  const lastBumpedAt = await getLobbyLastBumpedAt(kv, lobbyId)
  if (lastBumpedAt == null) return 0

  return Math.max(0, LOBBY_BUMP_COOLDOWN_MS - (now - lastBumpedAt))
}

export async function markLobbyBumped(
  kv: KVNamespace,
  lobbyId: string,
  options?: {
    now?: number
  },
): Promise<void> {
  const now = options?.now ?? Date.now()
  await kv.put(bumpCooldownKey(lobbyId), String(now), { expirationTtl: LOBBY_TTL })
}

async function getLobbyLastBumpedAt(kv: KVNamespace, lobbyId: string): Promise<number | null> {
  const raw = await kv.get(bumpCooldownKey(lobbyId))
  if (typeof raw !== 'string') return null

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

const SEASON_CONFIRMATION_KEY_PREFIX = 'confirm:season:'
const SEASON_CONFIRMATION_TTL_SECONDS = 5 * 60

export interface PendingSeasonConfirmation {
  guildId: string
  actorId: string
  action: 'start' | 'end'
  seasonName: string | null
}

function seasonConfirmationKey(token: string): string {
  return `${SEASON_CONFIRMATION_KEY_PREFIX}${token}`
}

function newSeasonConfirmationToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export async function createSeasonConfirmation(
  kv: KVNamespace,
  confirmation: PendingSeasonConfirmation,
): Promise<string> {
  const token = newSeasonConfirmationToken()
  await kv.put(
    seasonConfirmationKey(token),
    JSON.stringify(confirmation),
    { expirationTtl: SEASON_CONFIRMATION_TTL_SECONDS },
  )
  return token
}

export async function getSeasonConfirmation(
  kv: KVNamespace,
  token: string,
): Promise<PendingSeasonConfirmation | null> {
  const raw = await kv.get(seasonConfirmationKey(token), 'json')
  if (!raw || typeof raw !== 'object') return null

  const parsed = raw as Partial<PendingSeasonConfirmation>
  if (typeof parsed.guildId !== 'string') return null
  if (typeof parsed.actorId !== 'string') return null
  if (parsed.action !== 'start' && parsed.action !== 'end') return null

  return {
    guildId: parsed.guildId,
    actorId: parsed.actorId,
    action: parsed.action,
    seasonName: typeof parsed.seasonName === 'string' ? parsed.seasonName : null,
  }
}

export async function clearSeasonConfirmation(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(seasonConfirmationKey(token))
}

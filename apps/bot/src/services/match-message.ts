const MATCH_MESSAGE_KEY_PREFIX = 'match-message:'
const MATCH_MESSAGE_TTL_SECONDS = 180 * 24 * 60 * 60

function messageMatchKey(messageId: string): string {
  return `${MATCH_MESSAGE_KEY_PREFIX}${messageId}`
}

export async function storeMatchMessageMapping(
  kv: KVNamespace,
  messageId: string,
  matchId: string,
): Promise<void> {
  const key = messageMatchKey(messageId)
  const existing = await kv.get(key)
  if (existing === matchId) return
  await kv.put(key, matchId, { expirationTtl: MATCH_MESSAGE_TTL_SECONDS })
}

export async function getMatchIdForMessage(
  kv: KVNamespace,
  messageId: string,
): Promise<string | null> {
  return kv.get(messageMatchKey(messageId))
}

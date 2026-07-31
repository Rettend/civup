import type { SessionRecord } from './session-record.ts'
import { ACTIVITY_FEED_ROOM, CIVUP_INTERNAL_SECRET_HEADER, fetchPartyServerDurableObject } from '@civup/utils'

interface PublishSessionUpdateRequest {
  record?: SessionRecord
}

export async function publishActivitySessionUpdate(
  namespace: DurableObjectNamespace | null | undefined,
  record: SessionRecord,
  internalSecret: string | undefined,
): Promise<void> {
  if (!namespace) return

  const headers = new Headers({ 'Content-Type': 'application/json' })
  const secret = internalSecret?.trim() ?? ''
  if (secret.length > 0) headers.set(CIVUP_INTERNAL_SECRET_HEADER, secret)

  const response = await fetchPartyServerDurableObject(namespace, {
    party: 'activity',
    room: ACTIVITY_FEED_ROOM,
    input: `https://activity.local/parties/activity/${ACTIVITY_FEED_ROOM}`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({ record } satisfies PublishSessionUpdateRequest),
    },
  })
  if (!response.ok) throw new Error(`Activity feed publish failed: ${response.status} ${await response.text()}`)
}

export async function rebuildActivityOverview(
  namespace: DurableObjectNamespace | null | undefined,
  internalSecret: string | undefined,
): Promise<void> {
  if (!namespace) return
  const headers = new Headers()
  const secret = internalSecret?.trim() ?? ''
  if (secret.length > 0) headers.set(CIVUP_INTERNAL_SECRET_HEADER, secret)
  const response = await fetchPartyServerDurableObject(namespace, {
    party: 'activity',
    room: ACTIVITY_FEED_ROOM,
    input: `https://activity.local/parties/activity/${ACTIVITY_FEED_ROOM}/rebuild`,
    init: { method: 'POST', headers },
  })
  if (!response.ok) throw new Error(`Activity overview rebuild failed: ${response.status} ${await response.text()}`)
}

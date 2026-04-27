import { CIVUP_INTERNAL_SECRET_HEADER, fetchPartyServerDurableObject } from '@civup/utils'

export interface ActivityLaunchTargetSelection {
  kind: 'lobby' | 'match'
  id: string
}

export interface StoredActivityLaunchTargetSelection extends ActivityLaunchTargetSelection {
  createdAt: number
}

const ACTIVITY_LAUNCH_TARGET_TTL_MS = 120_000
const ACTIVITY_LAUNCH_TARGET_DO_PREFIX = 'activity-launch-target:'
const ACTIVITY_LAUNCH_TARGET_DO_PATH = 'https://activity.local/activity-launch-target'
const ACTIVITY_PARTYSERVER_NAMESPACE = 'activity'

export async function storeActivityLaunchTargetSelection(
  namespace: DurableObjectNamespace | null | undefined,
  internalSecret: string | undefined,
  _channelId: string | null | undefined,
  userId: string | null | undefined,
  target: ActivityLaunchTargetSelection,
): Promise<void> {
  if (!namespace || !userId || !target.id) return
  const payload: StoredActivityLaunchTargetSelection = {
    ...target,
    createdAt: Date.now(),
  }
  try {
    const response = await fetchActivityLaunchTarget(namespace, userId, {
      method: 'POST',
      headers: activityLaunchTargetHeaders(internalSecret),
      body: JSON.stringify(payload),
    })
    if (!response.ok) console.warn(`Activity launch target store failed: ${response.status} ${await response.text()}`)
  }
  catch (error) {
    console.warn('Activity launch target store failed', error)
  }
}

export async function readActivityLaunchTargetSelection(
  namespace: DurableObjectNamespace | null | undefined,
  internalSecret: string | undefined,
  _channelId: string,
  userId: string,
): Promise<ActivityLaunchTargetSelection | null> {
  if (!namespace) return null
  try {
    const response = await fetchActivityLaunchTarget(namespace, userId, {
      method: 'GET',
      headers: activityLaunchTargetHeaders(internalSecret),
    })
    if (!response.ok) return null
    const body = await response.json<{ target?: unknown }>().catch(() => null)
    const target = parseStoredActivityLaunchTargetSelection(body?.target ?? null)
    return target ? { kind: target.kind, id: target.id } : null
  }
  catch (error) {
    console.warn('Activity launch target read failed', error)
    return null
  }
}

export async function clearActivityLaunchTargetSelection(
  namespace: DurableObjectNamespace | null | undefined,
  internalSecret: string | undefined,
  _channelId: string,
  userId: string,
): Promise<void> {
  if (!namespace) return
  try {
    await fetchActivityLaunchTarget(namespace, userId, {
      method: 'DELETE',
      headers: activityLaunchTargetHeaders(internalSecret),
    })
  }
  catch (error) {
    console.warn('Activity launch target clear failed', error)
  }
}

export function parseStoredActivityLaunchTargetSelection(value: unknown): StoredActivityLaunchTargetSelection | null {
  if (!value || typeof value !== 'object') return null
  const target = value as Partial<StoredActivityLaunchTargetSelection>
  if (target.kind !== 'lobby' && target.kind !== 'match') return null
  if (typeof target.id !== 'string' || target.id.length === 0) return null
  if (typeof target.createdAt !== 'number' || Date.now() - target.createdAt > ACTIVITY_LAUNCH_TARGET_TTL_MS) return null
  return { kind: target.kind, id: target.id, createdAt: target.createdAt }
}

async function fetchActivityLaunchTarget(namespace: DurableObjectNamespace, userId: string, init: RequestInit): Promise<Response> {
  return await fetchPartyServerDurableObject(namespace, {
    party: ACTIVITY_PARTYSERVER_NAMESPACE,
    room: activityLaunchTargetRoom(userId),
    input: ACTIVITY_LAUNCH_TARGET_DO_PATH,
    init,
  })
}

function activityLaunchTargetHeaders(internalSecret: string | undefined): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const secret = internalSecret?.trim() ?? ''
  if (secret.length > 0) headers.set(CIVUP_INTERNAL_SECRET_HEADER, secret)
  return headers
}

function activityLaunchTargetRoom(userId: string): string {
  return `${ACTIVITY_LAUNCH_TARGET_DO_PREFIX}${userId}`
}

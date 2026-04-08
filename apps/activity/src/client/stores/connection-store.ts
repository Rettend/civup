import type { ClientMessage, CompetitiveTier, DraftAction, LeaderDataVersion, ServerMessage } from '@civup/game'
import { api, ApiError, CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import PartySocket from 'partysocket'
import { createSignal } from 'solid-js'
import { buildActivitySessionHeaders, clearActivitySessionToken, getActivitySessionToken } from '../lib/activity-session'
import { relayDevLog } from '../lib/dev-log'
import { shouldForceReconnectForStaleDraft } from '../lib/stale-draft'
import { applySwapUpdate, draftStore, initDraft, setOptimisticSeatPick, updateDraft, updateDraftPreviews } from './draft-store'
import { clearSelections } from './ui-store'

// ── Types ──────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'

export interface MatchStateSnapshot {
  match: {
    id: string
    gameMode: string
    status: string
    createdAt: number
    completedAt: number | null
  }
  participants: {
    matchId: string
    playerId: string
    team: number | null
    civId: string | null
    placement: number | null
  }[]
}

export interface LobbySnapshot {
  id: string
  revision: number
  mode: string
  hostId: string
  status: string
  steamLobbyLink: string | null
  minRole: CompetitiveTier | null
  maxRole: CompetitiveTier | null
  entries: ({
    playerId: string
    displayName: string
    avatarUrl?: string | null
    partyIds?: string[]
  } | null)[]
  minPlayers: number
  targetSize: number
  draftConfig: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
    leaderPoolSize: number | null
    leaderDataVersion: LeaderDataVersion
    simultaneousPick: boolean
    redDeath: boolean
    dealOptionsSize: number | null
    randomDraft: boolean
  }
  serverDefaults: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
}

export interface RankedRoleOptionSnapshot {
  tier: CompetitiveTier
  rank: number
  roleId: string | null
  label: string
  color: string | null
}

export interface LobbyRankedRolesSnapshot {
  options: RankedRoleOptionSnapshot[]
}

export type LobbyArrangeStrategy = 'randomize' | 'balance'

interface StateWatchMessage {
  type: 'state-changed' | 'error'
  key?: string
  op?: 'put' | 'delete'
  value?: string
  message?: string
}

export interface StateWatchChange {
  key: string
  op: 'put' | 'delete'
  value?: string
}

export interface LobbyStateWatch {
  close: () => void
  subscribeKey: (key: string) => void
  unsubscribeKey: (key: string) => void
  subscribePrefix: (prefix: string) => void
  unsubscribePrefix: (prefix: string) => void
}

export interface LobbyStateWatchOptions {
  channelId: string
  userId: string
  onConnected?: () => void
  onStateChanged: (change: StateWatchChange) => void
  onDisconnected?: () => void
  onError?: (message: string) => void
}

export interface ActivityTargetOption {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  mode: string
  status: 'open' | 'drafting' | 'active'
  participantCount: number
  targetSize: number
  redDeath: boolean
  isMember: boolean
  isHost: boolean
  updatedAt: number
}

export interface ActivityOverviewOptionSnapshot {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  mode: string
  status: 'open' | 'drafting' | 'active'
  participantCount: number
  targetSize: number
  redDeath: boolean
  hostId: string
  memberPlayerIds: string[]
  updatedAt: number
}

export interface ActivityOverviewSnapshot {
  channelId: string
  options: ActivityOverviewOptionSnapshot[]
}

export interface LobbyJoinEligibilitySnapshot {
  canJoin: boolean
  blockedReason: string | null
  pendingSlot: number | null
}

export type ActivityLaunchSelection
  = | {
    kind: 'lobby'
    option: ActivityTargetOption
    pendingJoin: boolean
    joinEligibility: LobbyJoinEligibilitySnapshot
    lobby: LobbySnapshot
  }
  | {
    kind: 'match'
    option: ActivityTargetOption
    matchId: string
    steamLobbyLink: string | null
    roomAccessToken: string | null
    lobbyId?: string | null
    mode?: string | null
  }

export interface ActivityLaunchSnapshot {
  selection: ActivityLaunchSelection | null
  options: ActivityTargetOption[]
}

export interface PartySocketTarget {
  host: string
  prefix?: string
  label?: string
}

// ── State ──────────────────────────────────────────────────

export const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
export const [connectionError, setConnectionError] = createSignal<string | null>(null)

const SOCKET_FATAL_CLOSE_MIN = 4000
const SOCKET_FATAL_CLOSE_MAX = 5000
const STALE_DRAFT_RECONNECT_CHECK_MS = 1_000
const DRAFT_SOCKET_MAX_RETRIES = 12
const STATE_WATCH_SOCKET_MAX_RETRIES = 8

// ── Socket ─────────────────────────────────────────────────

let socket: PartySocket | null = null
let currentRoomConnection: { target: PartySocketTarget, roomId: string, roomAccessToken: string } | null = null
let staleDraftReconnectInterval: ReturnType<typeof setInterval> | null = null
let lastSocketActivityAt = 0
let lastForcedReconnectTimerEndsAt: number | null = null
let lastServerErrorMessage: { message: string, at: number } | null = null
let pendingConfigAck:
  | {
    resolve: () => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
  | null = null
let lastSentPreviewKeys: Partial<Record<DraftAction, string>> = {}

/** Connect to PartyKit draft room using host and match ID */
export function connectToRoom(target: PartySocketTarget, roomId: string, roomAccessToken: string | null) {
  stopStaleDraftReconnectWatchdog()
  const previousSocket = socket
  socket = null
  previousSocket?.close()
  lastSentPreviewKeys = {}
  lastSocketActivityAt = 0
  lastForcedReconnectTimerEndsAt = null
  lastServerErrorMessage = null
  currentRoomConnection = null

  setConnectionStatus('connecting')
  setConnectionError(null)

  const activitySessionToken = getActivitySessionToken()
  if (!activitySessionToken) {
    setConnectionStatus('error')
    setConnectionError('Missing activity session. Reopen the activity.')
    return
  }

  if (!roomAccessToken) {
    setConnectionStatus('error')
    setConnectionError('Missing draft access token. Reopen the activity.')
    return
  }

  currentRoomConnection = { target, roomId, roomAccessToken }
  startStaleDraftReconnectWatchdog()

  const nextSocket = new PartySocket({
    host: target.host,
    party: 'main',
    prefix: target.prefix ?? 'api/parties',
    room: roomId,
    query: {
      accessToken: roomAccessToken,
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: activitySessionToken,
    },
    maxRetries: DRAFT_SOCKET_MAX_RETRIES,
  })
  socket = nextSocket

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return
    lastSocketActivityAt = Date.now()
    lastServerErrorMessage = null
    setConnectionStatus('connected')
    setConnectionError(null)
  })

  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket) return
    lastSocketActivityAt = Date.now()
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage
      handleServerMessage(msg)
    }
    catch (err) {
      relayDevLog('error', 'Failed to parse server message', err)
      console.error('Failed to parse server message:', err)
    }
  })

  nextSocket.addEventListener('close', (event) => {
    if (socket !== nextSocket) return

    const code = typeof event.code === 'number' ? event.code : -1
    const reason = typeof event.reason === 'string' && event.reason.length > 0
      ? event.reason
      : typeof event.type === 'string'
        ? event.type
        : '-'

    if (code !== 1000) {
      if (isFatalSocketClose(code)) stopSocketReconnects(nextSocket, `fatal close ${code}`)
      if (code === 4401) clearActivitySessionToken()

      relayDevLog('warn', 'Draft socket closed unexpectedly', {
        code,
        reason,
        roomId,
        retryCount: nextSocket.retryCount,
        target: describePartySocketTarget(target),
      })

      if (shouldRetryDraftSocket(nextSocket, code)) {
        setConnectionStatus('reconnecting')
        setConnectionError(null)
        return
      }

      socket = null
      stopStaleDraftReconnectWatchdog()
      currentRoomConnection = null
      lastSocketActivityAt = 0
      setConnectionStatus('error')
      setConnectionError(formatDraftSocketCloseError(code, reason, lastServerErrorMessage))
      return
    }

    socket = null
    stopStaleDraftReconnectWatchdog()
    currentRoomConnection = null
    lastSocketActivityAt = 0
    setConnectionStatus('disconnected')
  })

  nextSocket.addEventListener('error', () => {
    if (socket !== nextSocket) return

    if (shouldRetryDraftSocket(nextSocket)) {
      relayDevLog('warn', 'Draft socket connection interrupted', {
        roomId,
        retryCount: nextSocket.retryCount,
        target: describePartySocketTarget(target),
      })
      setConnectionStatus('reconnecting')
      setConnectionError(null)
      return
    }

    relayDevLog('error', 'Draft socket connection failed', {
      roomId,
      target: describePartySocketTarget(target),
    })
    socket = null
    stopStaleDraftReconnectWatchdog()
    currentRoomConnection = null
    lastSocketActivityAt = 0
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
  })
}

export function disconnect() {
  stopStaleDraftReconnectWatchdog()
  socket?.close()
  socket = null
  currentRoomConnection = null
  lastSocketActivityAt = 0
  lastForcedReconnectTimerEndsAt = null
  lastServerErrorMessage = null
  lastSentPreviewKeys = {}
  if (pendingConfigAck) {
    clearTimeout(pendingConfigAck.timeout)
    pendingConfigAck.reject(new Error('Disconnected before config update was acknowledged.'))
    pendingConfigAck = null
  }
  setConnectionStatus('disconnected')
}

function startStaleDraftReconnectWatchdog() {
  stopStaleDraftReconnectWatchdog()
  staleDraftReconnectInterval = setInterval(() => {
    if (!shouldForceReconnectForStaleDraft({
      connectionStatus: connectionStatus(),
      state: draftStore.state,
      timerEndsAt: draftStore.timerEndsAt,
      lastSocketActivityAt,
      lastForcedReconnectTimerEndsAt,
    })) {
      return
    }

    const currentRoom = currentRoomConnection
    if (!currentRoom) return
    lastForcedReconnectTimerEndsAt = draftStore.timerEndsAt

    relayDevLog('warn', 'Forcing draft socket reconnect after stale timer', {
      roomId: currentRoom.roomId,
      timerEndsAt: draftStore.timerEndsAt,
      currentStepIndex: draftStore.state?.currentStepIndex ?? null,
      lastSocketActivityAt,
      target: describePartySocketTarget(currentRoom.target),
    })
    connectToRoom(currentRoom.target, currentRoom.roomId, currentRoom.roomAccessToken)
  }, STALE_DRAFT_RECONNECT_CHECK_MS)
}

function stopStaleDraftReconnectWatchdog() {
  if (!staleDraftReconnectInterval) return
  clearInterval(staleDraftReconnectInterval)
  staleDraftReconnectInterval = null
}

/** Subscribe to lobby/match invalidation events from state coordinator room. */
export function watchLobbyState(target: PartySocketTarget, options: LobbyStateWatchOptions): LobbyStateWatch {
  let closed = false
  const keySubscriptions = new Set<string>()
  const prefixSubscriptions = new Set<string>()

  const socketId = `lobby-watch:${options.userId}:${Math.random().toString(36).slice(2, 10)}`
  const activitySessionToken = getActivitySessionToken()

  const stateSocket = new PartySocket({
    host: target.host,
    party: 'state',
    prefix: target.prefix ?? 'api/parties',
    room: 'global',
    id: socketId,
    query: activitySessionToken
      ? { [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: activitySessionToken }
      : undefined,
    maxRetries: STATE_WATCH_SOCKET_MAX_RETRIES,
  })

  const isSocketOpen = () => stateSocket.readyState === WebSocket.OPEN
  const sendStateSocketMessage = (message: unknown) => {
    if (closed || !isSocketOpen()) return
    stateSocket.send(JSON.stringify(message))
  }
  const subscribeKey = (key: string) => {
    if (keySubscriptions.has(key)) return
    keySubscriptions.add(key)
    sendStateSocketMessage({ type: 'subscribe-key', key })
  }
  const unsubscribeKey = (key: string) => {
    if (!keySubscriptions.delete(key)) return
    sendStateSocketMessage({ type: 'unsubscribe-key', key })
  }
  const subscribePrefix = (prefix: string) => {
    if (prefixSubscriptions.has(prefix)) return
    prefixSubscriptions.add(prefix)
    sendStateSocketMessage({ type: 'subscribe-prefix', prefix })
  }
  const unsubscribePrefix = (prefix: string) => {
    if (!prefixSubscriptions.delete(prefix)) return
    sendStateSocketMessage({ type: 'unsubscribe-prefix', prefix })
  }

  stateSocket.addEventListener('open', () => {
    if (closed) return
    options.onConnected?.()
    for (const key of keySubscriptions) {
      sendStateSocketMessage({ type: 'subscribe-key', key })
    }
    for (const prefix of prefixSubscriptions) {
      sendStateSocketMessage({ type: 'subscribe-prefix', prefix })
    }
  })

  stateSocket.addEventListener('message', (event) => {
    if (closed) return
    try {
      const msg = JSON.parse(event.data as string) as StateWatchMessage
      if (
        msg.type === 'state-changed'
        && typeof msg.key === 'string'
        && (msg.op === 'put' || msg.op === 'delete')
      ) {
        options.onStateChanged({
          key: msg.key,
          op: msg.op,
          value: typeof msg.value === 'string' ? msg.value : undefined,
        })
        return
      }

      if (msg.type === 'error') {
        options.onError?.(msg.message ?? 'State watch error')
      }
    }
    catch (err) {
      relayDevLog('warn', 'Failed to parse state watch message', err)
      console.error('Failed to parse state watch message:', err)
    }
  })

  stateSocket.addEventListener('close', (event) => {
    if (closed) return
    if (isFatalSocketClose(event.code)) stopSocketReconnects(stateSocket, `fatal close ${event.code}`)
    if (isUnauthorizedSocketClose(event.code)) clearActivitySessionToken()
    if (event.code === 1000) return
    options.onDisconnected?.()
    options.onError?.(isUnauthorizedSocketClose(event.code)
      ? 'Activity session expired. Reopen the activity.'
      : `State watch disconnected (${event.code})`)
  })

  stateSocket.addEventListener('error', () => {
    if (closed) return
    options.onError?.('State watch connection failed')
  })

  return {
    subscribeKey,
    unsubscribeKey,
    subscribePrefix,
    unsubscribePrefix,
    close: () => {
      if (closed) return
      closed = true
      stateSocket.close()
    },
  }
}

// ── Send Messages ──────────────────────────────────────────

export function sendMessage(msg: ClientMessage): boolean {
  if (!socket || connectionStatus() !== 'connected') {
    console.warn('Cannot send message: not connected')
    return false
  }
  socket.send(JSON.stringify(msg))
  return true
}

export function sendStart() {
  return sendMessage({ type: 'start' })
}

export function sendBan(civIds: string[]) {
  sendMessage({ type: 'ban', civIds })
}

export function sendPick(civId: string) {
  const sent = sendMessage({ type: 'pick', civId })
  if (sent) {
    setOptimisticSeatPick(civId)
  }
}

export function sendPreview(action: DraftAction, civIds: string[]) {
  const key = `${action}:${civIds.join(',')}`
  if (lastSentPreviewKeys[action] === key) return true

  const sent = sendMessage({ type: 'preview', action, civIds })
  if (sent) lastSentPreviewKeys[action] = key
  return sent
}

export function sendCancel(reason: 'cancel' | 'scrub' | 'revert') {
  return sendMessage({ type: 'cancel', reason })
}

export function sendScrub() {
  return sendCancel('scrub')
}

export function sendRevert() {
  return sendCancel('revert')
}

export function sendSwapRequest(toSeat: number) {
  return sendMessage({ type: 'swap-request', toSeat })
}

export function sendSwapAccept() {
  return sendMessage({ type: 'swap-accept' })
}

export function sendSwapCancel() {
  return sendMessage({ type: 'swap-cancel' })
}

export function sendConfig(banTimerSeconds: number | null, pickTimerSeconds: number | null): Promise<void> {
  if (pendingConfigAck) {
    clearTimeout(pendingConfigAck.timeout)
    pendingConfigAck.reject(new Error('Previous config update still pending.'))
    pendingConfigAck = null
  }

  return new Promise<void>((resolve, reject) => {
    const sent = sendMessage({ type: 'config', banTimerSeconds, pickTimerSeconds })
    if (!sent) {
      reject(new Error('Not connected to draft room.'))
      return
    }

    const timeout = setTimeout(() => {
      if (!pendingConfigAck || pendingConfigAck.timeout !== timeout) return
      pendingConfigAck = null
      reject(new Error('Config update was not acknowledged by the server.'))
    }, 4000)

    pendingConfigAck = {
      resolve,
      reject,
      timeout,
    }
  })
}

// ── Bot API ────────────────────────────────────────────────

function activityApiGet<T>(url: string): Promise<T> {
  return api.get<T>(url, { headers: buildActivitySessionHeaders() })
}

function activityApiPost<T>(url: string, body: unknown): Promise<T> {
  return api.post<T>(url, body, { headers: buildActivitySessionHeaders() })
}

function activityFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: buildActivitySessionHeaders(init?.headers),
  })
}

/** Fetch match ID for a channel from the bot API */
export async function fetchMatchForChannel(
  channelId: string,
): Promise<string | null> {
  try {
    const data = await activityApiGet<{ matchId?: string }>(`/api/match/${channelId}`)
    return data.matchId ?? null
  }
  catch (err) {
    console.error('Failed to fetch match for channel:', err)
    if (err instanceof ApiError && err.status === 404) return null // TODO: remove?
    return null
  }
}

/** Fetch open lobby state for a channel from the bot API */
export async function fetchLobbyForChannel(
  channelId: string,
): Promise<LobbySnapshot | null> {
  try {
    return await activityApiGet<LobbySnapshot>(`/api/lobby/${channelId}`)
  }
  catch (err) {
    console.error('Failed to fetch lobby for channel:', err)
    return null
  }
}

/** Fetch open lobby state for a user from the bot API */
export async function fetchLobbyForUser(
  userId: string,
): Promise<LobbySnapshot | null> {
  try {
    return await activityApiGet<LobbySnapshot>(`/api/lobby/user/${userId}`)
  }
  catch (err) {
    console.error('Failed to fetch lobby for user:', err)
    return null
  }
}

/** Update host draft config for an open lobby */
export async function updateLobbyConfig(
  mode: string,
  lobbyId: string,
  userId: string,
  draftConfig: {
    banTimerSeconds?: number | null
    pickTimerSeconds?: number | null
    leaderPoolSize?: number | null
    leaderDataVersion?: LeaderDataVersion
    simultaneousPick?: boolean
    redDeath?: boolean
    dealOptionsSize?: number | null
    randomDraft?: boolean
    targetSize?: number
    steamLobbyLink?: string | null
    minRole?: CompetitiveTier | null
    maxRole?: CompetitiveTier | null
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/config`, {
      lobbyId,
      userId,
      banTimerSeconds: draftConfig.banTimerSeconds,
      pickTimerSeconds: draftConfig.pickTimerSeconds,
      leaderPoolSize: draftConfig.leaderPoolSize,
      leaderDataVersion: draftConfig.leaderDataVersion,
      simultaneousPick: draftConfig.simultaneousPick,
      redDeath: draftConfig.redDeath,
      dealOptionsSize: draftConfig.dealOptionsSize,
      randomDraft: draftConfig.randomDraft,
      targetSize: draftConfig.targetSize,
      steamLobbyLink: draftConfig.steamLobbyLink,
      minRole: draftConfig.minRole,
      maxRole: draftConfig.maxRole,
    })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to update lobby config:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby config' }
  }
}

/** Fetch ranked-role option labels/colors for one open lobby. */
export async function fetchLobbyRankedRoles(
  mode: string,
  lobbyId: string,
): Promise<LobbyRankedRolesSnapshot | null> {
  try {
    return await activityApiGet<LobbyRankedRolesSnapshot>(`/api/lobby-ranks/${mode}/${lobbyId}`)
  }
  catch (err) {
    console.error('Failed to fetch lobby ranked roles:', err)
    return null
  }
}

/** Update open lobby game mode (host-only). */
export async function updateLobbyMode(
  mode: string,
  lobbyId: string,
  userId: string,
  nextMode: string,
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/mode`, { lobbyId, userId, nextMode })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to update lobby mode:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby mode' }
  }
}

/** Place a player into a target lobby slot (join/move/swap). */
export async function placeLobbySlot(
  mode: string,
  payload: {
    lobbyId: string
    userId: string
    targetSlot: number
    playerId?: string
    displayName?: string
    avatarUrl?: string | null
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/place`, payload)
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to place lobby slot:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby slot' }
  }
}

/** Remove a player from a lobby slot (self-leave or host kick). */
export async function removeLobbySlot(
  mode: string,
  payload: {
    lobbyId: string
    userId: string
    slot: number
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/remove`, payload)
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to remove lobby slot:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while removing lobby slot' }
  }
}

/** Arrange lobby slots for team or seat-order drafts (host-only). */
export async function arrangeLobbySlots(
  mode: string,
  lobbyId: string,
  userId: string,
  strategy: LobbyArrangeStrategy,
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/arrange`, { lobbyId, userId, strategy })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to arrange lobby slots:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while arranging lobby slots' }
  }
}

/** Toggle a visible premade link between neighboring team slots. */
export async function toggleLobbyPremadeLink(
  mode: string,
  lobbyId: string,
  userId: string,
  leftSlot: number,
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/link`, { lobbyId, userId, leftSlot })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to toggle lobby premade link:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while toggling premade link' }
  }
}

/** Start a draft from an open lobby (host-only). */
export async function startLobbyDraft(
  mode: string,
  lobbyId: string,
  userId: string,
): Promise<{ ok: true, matchId: string, roomAccessToken: string | null } | { ok: false, error: string }> {
  try {
    const data = await activityApiPost<{ matchId?: string, roomAccessToken?: string | null }>(`/api/lobby/${mode}/start`, { lobbyId, userId })
    if (!data.matchId) return { ok: false, error: 'Draft started but no match ID was returned' }
    return { ok: true, matchId: data.matchId, roomAccessToken: data.roomAccessToken ?? null }
  }
  catch (err) {
    console.error('Failed to start lobby draft:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while starting lobby draft' }
  }
}

/** Cancel an open lobby before draft room creation */
export async function cancelLobby(
  mode: string,
  lobbyId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    await activityApiPost(`/api/lobby/${mode}/cancel`, { lobbyId, userId })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to cancel lobby:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while cancelling lobby' }
  }
}

/** Fetch match ID for a user from the bot API */
export async function fetchMatchForUser(
  userId: string,
): Promise<string | null> {
  try {
    const data = await activityApiGet<{ matchId?: string }>(`/api/match/user/${userId}`)
    return data.matchId ?? null
  }
  catch (err) {
    console.error('Failed to fetch match for user:', err)
    return null
  }
}

/** Resolve the current activity target plus available options for one channel/user pair. */
export async function fetchActivityLaunchSnapshot(
  channelId: string,
  userId: string,
): Promise<ActivityLaunchSnapshot | null> {
  try {
    return await activityApiGet<ActivityLaunchSnapshot>(`/api/activity/launch/${channelId}/${userId}`)
  }
  catch (err) {
    console.error('Failed to fetch activity launch snapshot:', err)
    return null
  }
}

/** Persist a new activity target selection for this channel. */
export async function selectActivityTarget(
  channelId: string,
  userId: string,
  target: Pick<ActivityTargetOption, 'kind' | 'id'>,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    await activityApiPost('/api/activity/target', {
      channelId,
      userId,
      kind: target.kind,
      id: target.id,
    })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to select activity target:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while switching activity target' }
  }
}

/** Fetch full match state snapshot from bot API */
export async function fetchMatchState(matchId: string): Promise<MatchStateSnapshot | null> {
  try {
    return await activityApiGet<MatchStateSnapshot>(`/api/match/state/${matchId}`)
  }
  catch (err) {
    console.error('Failed to fetch match state:', err)
    return null
  }
}

/** Report result from the activity (team games use "A" or "B") */
export async function reportMatchResult(
  matchId: string,
  reporterId: string,
  placements: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    await activityApiPost(`/api/match/${matchId}/report`, { reporterId, placements })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to report match result:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while reporting result' }
  }
}

/** Scrub an already completed draft match (host-only). */
export async function scrubMatchResult(
  matchId: string,
  reporterId: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    await activityApiPost(`/api/match/${matchId}/scrub`, { reporterId })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to scrub match result:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while scrubbing match' }
  }
}

/** Fill empty lobby slots with active test players (host-only, dev or env-enabled). */
export async function canFillLobbyWithTestPlayers(mode: string): Promise<boolean> {
  try {
    const res = await activityFetch(`/api/lobby/${mode}/fill-test`, {
      method: 'GET',
      headers: { 'Cache-Control': 'no-store' },
    })
    return res.ok
  }
  catch (err) {
    console.error('Failed to check test-player fill availability:', err)
    return false
  }
}

/** Fill empty lobby slots with active test players (host-only, dev or env-enabled). */
export async function fillLobbyWithTestPlayers(
  mode: string,
  lobbyId: string,
  userId: string,
): Promise<{ ok: true, lobby: LobbySnapshot, addedCount: number } | { ok: false, error: string }> {
  try {
    const res = await activityFetch(`/api/lobby/${mode}/fill-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lobbyId, userId }),
    })

    const data = await res.json() as LobbySnapshot & { error?: string, addedCount?: unknown }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to fill lobby slots' }
    return {
      ok: true,
      lobby: data,
      addedCount: typeof data.addedCount === 'number' ? data.addedCount : 0,
    }
  }
  catch (err) {
    console.error('Failed to fill lobby slots with test players:', err)
    return { ok: false, error: 'Network error while filling lobby slots' }
  }
}

// ── Handle Messages ────────────────────────────────────────

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'init':
      clearSelections()
      syncForcedReconnectTimer(msg.timerEndsAt)
      syncPreviewCache(msg.previews, msg.seatIndex)
      initDraft(msg.state, msg.leaderDataVersion ?? 'live', msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.seatIndex, msg.timerEndsAt, msg.completedAt, msg.previews, msg.swapState ?? null)
      if (shouldDisconnectAfterState(msg.state.status, msg.swapState ?? null)) {
        disconnect()
      }
      break
    case 'update':
      syncForcedReconnectTimer(msg.timerEndsAt)
      syncPreviewCache(msg.previews)
      updateDraft(msg.state, msg.leaderDataVersion ?? 'live', msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.events, msg.timerEndsAt, msg.completedAt, msg.previews, msg.swapState ?? null)
      if (pendingConfigAck) {
        clearTimeout(pendingConfigAck.timeout)
        pendingConfigAck.resolve()
        pendingConfigAck = null
      }
      if (shouldDisconnectAfterState(msg.state.status, msg.swapState ?? null)) {
        clearSelections()
        disconnect()
      }
      break
    case 'preview':
      syncPreviewCache(msg.previews)
      updateDraftPreviews(msg.previews)
      break
    case 'swap-update':
      applySwapUpdate(msg.swapState, msg.picks)
      break
    case 'error':
      lastServerErrorMessage = {
        message: msg.message,
        at: Date.now(),
      }
      if (pendingConfigAck) {
        clearTimeout(pendingConfigAck.timeout)
        pendingConfigAck.reject(formatConfigAckError(msg.message))
        pendingConfigAck = null
      }
      console.error('Server error:', msg.message)
      break
  }
}

function shouldDisconnectAfterState(status: string, swapState: unknown): boolean {
  if (status === 'cancelled') return true
  if (status !== 'complete') return false
  return swapState == null
}

function formatDraftSocketCloseError(
  code: number,
  reason: string,
  serverError: { message: string, at: number } | null,
): string {
  if (code === 4401) {
    return 'Activity session expired. Reopen the activity.'
  }

  if (code === 4403) {
    const recentServerError = serverError && Date.now() - serverError.at <= 2_000
      ? serverError.message.trim()
      : ''
    if (recentServerError.length > 0) {
      return /reopen the activity\.?$/i.test(recentServerError)
        ? recentServerError
        : `${recentServerError}. Reopen the activity.`
    }
    return 'Draft access token is invalid or expired. Reopen the activity.'
  }

  return `WebSocket closed (${code}${reason ? `: ${reason}` : ''})`
}

function formatConfigAckError(message: string): Error {
  if (message === 'Unknown message type') {
    return new Error('Draft room server is outdated (missing config support). Redeploy/restart party server and create a new lobby.')
  }
  return new Error(message)
}

function syncPreviewCache(previews: { bans: Record<number, string[]>, picks: Record<number, string[]> }, seatIndex: number | null = draftStore.seatIndex) {
  if (seatIndex == null) {
    lastSentPreviewKeys = {}
    return
  }

  lastSentPreviewKeys = {
    ban: `ban:${(previews.bans[seatIndex] ?? []).join(',')}`,
    pick: `pick:${(previews.picks[seatIndex] ?? []).join(',')}`,
  }
}

function syncForcedReconnectTimer(timerEndsAt: number | null) {
  if (timerEndsAt == null || timerEndsAt !== lastForcedReconnectTimerEndsAt) {
    lastForcedReconnectTimerEndsAt = null
  }
}

function describePartySocketTarget(target: PartySocketTarget): string {
  return `${target.label ?? 'socket'}:${target.host}/${target.prefix ?? 'api/parties'}`
}

function shouldRetryDraftSocket(currentSocket: PartySocket, code?: number): boolean {
  if (!currentSocket.shouldReconnect) return false
  if (typeof code === 'number' && isFatalSocketClose(code)) return false
  return true
}

function stopSocketReconnects(currentSocket: PartySocket, reason: string): void {
  currentSocket.close(1000, reason)
}

export function isFatalSocketClose(code: number): boolean {
  return code >= SOCKET_FATAL_CLOSE_MIN && code < SOCKET_FATAL_CLOSE_MAX
}

export function isUnauthorizedSocketClose(code: number): boolean {
  return code === 4401 || code === 4403
}

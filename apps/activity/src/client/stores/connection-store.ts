import type { ClientMessage, CompetitiveTier, ServerMessage } from '@civup/game'
import { COMPETITIVE_TIERS } from '@civup/game'
import { api, ApiError } from '@civup/utils'
import PartySocket from 'partysocket'
import { createSignal } from 'solid-js'
import { relayDevLog } from '../lib/dev-log'
import { initDraft, setOptimisticSeatPick, updateDraft } from './draft-store'

// ── Types ──────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

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
  minRole: CompetitiveTier | null
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

export interface LobbyConfigErrorContext {
  playerId: string
  playerName: string
  minRole: RankedRoleOptionSnapshot
}

export interface LobbyConfigErrorResult {
  error: string
  errorCode?: string
  context?: LobbyConfigErrorContext
}

export type LobbyTeamArrangeStrategy = 'randomize' | 'balance'

interface StateWatchMessage {
  type: 'state-changed' | 'error'
  key?: string
  message?: string
}

export interface LobbyStateWatch {
  close: () => void
}

export interface LobbyStateWatchOptions {
  channelId: string
  userId: string
  onConnected?: () => void
  onInvalidation: (key: string) => void
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
  isMember: boolean
  isHost: boolean
  updatedAt: number
}

export type ActivityLaunchSelection
  = | {
    kind: 'lobby'
    option: ActivityTargetOption
    pendingJoin: boolean
    lobby: LobbySnapshot
  }
  | {
    kind: 'match'
    option: ActivityTargetOption
    matchId: string
  }

export interface ActivityLaunchSnapshot {
  selection: ActivityLaunchSelection | null
  options: ActivityTargetOption[]
}

// ── State ──────────────────────────────────────────────────

export const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
export const [connectionError, setConnectionError] = createSignal<string | null>(null)

// ── Socket ─────────────────────────────────────────────────

let socket: PartySocket | null = null
let pendingConfigAck:
  | {
    resolve: () => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
  | null = null

/** Connect to PartyKit draft room using host and match ID */
export function connectToRoom(host: string, roomId: string, playerId: string) {
  if (socket) {
    socket.close()
  }

  setConnectionStatus('connecting')
  setConnectionError(null)

  socket = new PartySocket({
    host,
    party: 'main',
    prefix: 'api/parties',
    room: roomId,
    id: playerId,
    query: { playerId },
    maxRetries: 2,
  })

  socket.addEventListener('open', () => {
    setConnectionStatus('connected')
    setConnectionError(null)
  })

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage
      handleServerMessage(msg)
    }
    catch (err) {
      relayDevLog('error', 'Failed to parse server message', err)
      console.error('Failed to parse server message:', err)
    }
  })

  socket.addEventListener('close', (event) => {
    const code = typeof event.code === 'number' ? event.code : -1
    const reason = typeof event.reason === 'string' && event.reason.length > 0
      ? event.reason
      : typeof event.type === 'string'
        ? event.type
        : '-'
    if (code !== 1000) {
      relayDevLog('warn', 'Draft socket closed unexpectedly', { code, reason, roomId })
      setConnectionStatus('error')
      setConnectionError(`WebSocket closed (${code}${reason ? `: ${reason}` : ''})`)
      return
    }

    setConnectionStatus('disconnected')
  })

  socket.addEventListener('error', () => {
    relayDevLog('error', 'Draft socket connection failed', { roomId, playerId })
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
  })
}

export function disconnect() {
  socket?.close()
  socket = null
  if (pendingConfigAck) {
    clearTimeout(pendingConfigAck.timeout)
    pendingConfigAck.reject(new Error('Disconnected before config update was acknowledged.'))
    pendingConfigAck = null
  }
  setConnectionStatus('disconnected')
}

/** Subscribe to lobby/match invalidation events from state coordinator room. */
export function watchLobbyState(host: string, options: LobbyStateWatchOptions): LobbyStateWatch {
  let closed = false

  const stateSocket = new PartySocket({
    host,
    party: 'state',
    prefix: 'api/parties',
    room: 'global',
    id: `lobby-watch:${options.userId}:${Math.random().toString(36).slice(2, 10)}`,
    maxRetries: 2,
  })

  stateSocket.addEventListener('open', () => {
    if (closed) return
    options.onConnected?.()
    stateSocket.send(JSON.stringify({ type: 'subscribe-prefix', prefix: 'lobby:mode:' }))
    stateSocket.send(JSON.stringify({ type: 'subscribe-key', key: `activity-target-user:${options.userId}:${options.channelId}` }))
  })

  stateSocket.addEventListener('message', (event) => {
    if (closed) return
    try {
      const msg = JSON.parse(event.data as string) as StateWatchMessage
      if (msg.type === 'state-changed' && typeof msg.key === 'string') {
        options.onInvalidation(msg.key)
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
    if (event.code === 1000) return
    options.onDisconnected?.()
    options.onError?.(`State watch disconnected (${event.code})`)
  })

  stateSocket.addEventListener('error', () => {
    if (closed) return
    options.onError?.('State watch connection failed')
  })

  return {
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

export function sendCancel(reason: 'cancel' | 'scrub') {
  return sendMessage({ type: 'cancel', reason })
}

export function sendScrub() {
  return sendCancel('scrub')
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

/** Fetch match ID for a channel from the bot API */
export async function fetchMatchForChannel(
  channelId: string,
): Promise<string | null> {
  try {
    const data = await api.get<{ matchId?: string }>(`/api/match/${channelId}`)
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
    return await api.get<LobbySnapshot>(`/api/lobby/${channelId}`)
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
    return await api.get<LobbySnapshot>(`/api/lobby/user/${userId}`)
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
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
    minRole?: CompetitiveTier | null
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string, errorCode?: string, context?: LobbyConfigErrorContext }> {
  try {
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/config`, {
      lobbyId,
      userId,
      banTimerSeconds: draftConfig.banTimerSeconds,
      pickTimerSeconds: draftConfig.pickTimerSeconds,
      minRole: draftConfig.minRole,
    })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to update lobby config:', err)
    if (err instanceof ApiError) {
      const parsed = parseLobbyConfigApiError(err.data)
      return {
        ok: false,
        error: err.message,
        errorCode: parsed?.errorCode,
        context: parsed?.context,
      }
    }
    return { ok: false, error: 'Network error while updating lobby config' }
  }
}

/** Fetch ranked-role option labels/colors for one open lobby. */
export async function fetchLobbyRankedRoles(
  mode: string,
  lobbyId: string,
): Promise<LobbyRankedRolesSnapshot | null> {
  try {
    return await api.get<LobbyRankedRolesSnapshot>(`/api/lobby-ranks/${mode}/${lobbyId}`)
  }
  catch (err) {
    console.error('Failed to fetch lobby ranked roles:', err)
    return null
  }
}

function parseLobbyConfigApiError(data: unknown): LobbyConfigErrorResult | null {
  if (!data || typeof data !== 'object') return null

  const parsed = data as {
    error?: unknown
    errorCode?: unknown
    context?: unknown
  }

  const error = typeof parsed.error === 'string' ? parsed.error : null
  if (!error) return null

  const errorCode = typeof parsed.errorCode === 'string' ? parsed.errorCode : undefined
  const context = parseLobbyConfigErrorContext(parsed.context)
  return { error, errorCode, context }
}

function parseLobbyConfigErrorContext(data: unknown): LobbyConfigErrorContext | undefined {
  if (!data || typeof data !== 'object') return undefined

  const parsed = data as {
    playerId?: unknown
    playerName?: unknown
    minRole?: unknown
  }

  if (typeof parsed.playerId !== 'string' || typeof parsed.playerName !== 'string') return undefined
  const minRole = parseRankedRoleOption(parsed.minRole)
  if (!minRole) return undefined

  return {
    playerId: parsed.playerId,
    playerName: parsed.playerName,
    minRole,
  }
}

function parseRankedRoleOption(data: unknown): RankedRoleOptionSnapshot | null {
  if (!data || typeof data !== 'object') return null

  const parsed = data as {
    tier?: unknown
    rank?: unknown
    roleId?: unknown
    label?: unknown
    color?: unknown
  }

  if (typeof parsed.tier !== 'string' || !COMPETITIVE_TIERS.includes(parsed.tier as CompetitiveTier)) return null
  if (typeof parsed.rank !== 'number' || !Number.isFinite(parsed.rank)) return null
  if (parsed.roleId != null && typeof parsed.roleId !== 'string') return null
  if (typeof parsed.label !== 'string') return null
  if (parsed.color != null && typeof parsed.color !== 'string') return null

  return {
    tier: parsed.tier as CompetitiveTier,
    rank: Math.round(parsed.rank),
    roleId: parsed.roleId ?? null,
    label: parsed.label,
    color: parsed.color ?? null,
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
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/mode`, { lobbyId, userId, nextMode })
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
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/place`, payload)
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
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/remove`, payload)
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to remove lobby slot:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while removing lobby slot' }
  }
}

/** Arrange team lobby slots while keeping premades intact (host-only). */
export async function arrangeLobbyTeams(
  mode: string,
  lobbyId: string,
  userId: string,
  strategy: LobbyTeamArrangeStrategy,
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/arrange`, { lobbyId, userId, strategy })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to arrange lobby teams:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while arranging teams' }
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
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/link`, { lobbyId, userId, leftSlot })
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
): Promise<{ ok: true, matchId: string } | { ok: false, error: string }> {
  try {
    const data = await api.post<{ matchId?: string }>(`/api/lobby/${mode}/start`, { lobbyId, userId })
    if (!data.matchId) return { ok: false, error: 'Draft started but no match ID was returned' }
    return { ok: true, matchId: data.matchId }
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
    await api.post(`/api/lobby/${mode}/cancel`, { lobbyId, userId })
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
    const data = await api.get<{ matchId?: string }>(`/api/match/user/${userId}`)
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
    return await api.get<ActivityLaunchSnapshot>(`/api/activity/launch/${channelId}/${userId}`)
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
): Promise<{ ok: true, snapshot: ActivityLaunchSnapshot } | { ok: false, error: string }> {
  try {
    const snapshot = await api.post<ActivityLaunchSnapshot>('/api/activity/target', {
      channelId,
      userId,
      kind: target.kind,
      id: target.id,
    })
    return { ok: true, snapshot }
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
    return await api.get<MatchStateSnapshot>(`/api/match/state/${matchId}`)
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
    await api.post(`/api/match/${matchId}/report`, { reporterId, placements })
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
    await api.post(`/api/match/${matchId}/scrub`, { reporterId })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to scrub match result:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while scrubbing match' }
  }
}

/** Fill empty lobby slots with active test players (host-only, dev-only). */
export async function fillLobbyWithTestPlayers(
  mode: string,
  lobbyId: string,
  userId: string,
): Promise<{ ok: true, lobby: LobbySnapshot, addedCount: number } | { ok: false, error: string }> {
  try {
    const res = await fetch(`/api/lobby/${mode}/fill-test`, {
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
      initDraft(msg.state, msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.seatIndex, msg.timerEndsAt, msg.completedAt)
      if (isTerminalDraftStatus(msg.state.status)) {
        disconnect()
      }
      break
    case 'update':
      updateDraft(msg.state, msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.events, msg.timerEndsAt, msg.completedAt)
      if (pendingConfigAck) {
        clearTimeout(pendingConfigAck.timeout)
        pendingConfigAck.resolve()
        pendingConfigAck = null
      }
      if (isTerminalDraftStatus(msg.state.status)) {
        disconnect()
      }
      break
    case 'error':
      if (pendingConfigAck) {
        clearTimeout(pendingConfigAck.timeout)
        pendingConfigAck.reject(formatConfigAckError(msg.message))
        pendingConfigAck = null
      }
      console.error('Server error:', msg.message)
      break
  }
}

function isTerminalDraftStatus(status: string): boolean {
  return status === 'complete' || status === 'cancelled'
}

function formatConfigAckError(message: string): Error {
  if (message === 'Unknown message type') {
    return new Error('Draft room server is outdated (missing config support). Redeploy/restart party server and create a new lobby.')
  }
  return new Error(message)
}

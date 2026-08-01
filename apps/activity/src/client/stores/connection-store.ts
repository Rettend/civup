import type { AppliedCivLobbySettings, CivBlitzPartialKit, CivLobbySettingsCommunityPreset, CivLobbySettingsProfile, CompetitiveTier, DraftAction, LeaderDataVersion, MapVoteSelection } from '@civup/game'
import type { SessionClientMessage, SessionServerMessage } from '@civup/session'
import { ACTIVITY_FEED_ROOM, ACTIVITY_VERSION_OUTDATED_MESSAGE, api, ApiError, CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import PartySocket from 'partysocket'
import { createSignal, untrack } from 'solid-js'
import { buildActivitySessionHeaders, clearActivitySessionToken, getActivitySessionToken } from '../lib/activity-session'
import { relayDevLog } from '../lib/dev-log'
import { getAuthTransport } from '../platform/runtime'
import { shouldForceReconnectForStaleDraft } from '../lib/stale-draft'
import { draftNow, draftStore, initDraft, setOptimisticSeatPick, syncDraftServerTime, updateDraft, updateDraftPreviews, updateDraftSteamLobbyLink } from './draft-store'
import { clearSelections } from './ui-store'

// ── Types ──────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'
export type ReportMatchResult = { ok: true } | { ok: false, error: string, reason?: 'processing' | 'finalizing' }

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
  originGuildId: string | null
  revision: number
  mode: string
  hostId: string
  status: string
  steamLobbyLink: string | null
  minRole: CompetitiveTier | null
  maxRole: CompetitiveTier | null
  lobbyRank?: {
    tier: CompetitiveTier
    leaderPoolSize: number | null
  } | null
  lastArrange?: {
    strategy: LobbyArrangeStrategy
    at: number
  } | null
  memberPlayerIds?: string[]
  entries: ({
    playerId: string
    displayName: string
    avatarUrl?: string | null
    sourceGuild?: {
      id: string
      name?: string | null
      iconUrl?: string | null
    }
    balanceRating?: {
      mu: number
      sigma: number
      publicRating?: number
      gamesPlayed: number
      wins?: number
      rank?: number | null
    }
    rankedRole?: {
      tier: CompetitiveTier
      sourceMode: string | null
    } | null
  } | null)[]
  minPlayers: number
  targetSize: number
  draftConfig: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
    leaderPoolSize: number | null
    leaderDataVersion: LeaderDataVersion
    mapVoteEnabled: boolean
    teamFormationEnabled: boolean
    blindBans: boolean
    blindPicks: boolean
    simultaneousPick: boolean
    permanentAlly: boolean
    redDeath: boolean
    dealOptionsSize: number | null
    civBlitz: boolean
    civBlitzOptionCount: number | null
    civBlitzExcludeBbgExpanded: boolean
    randomDraft: boolean
    hiddenDraft: boolean
    duplicateFactions: boolean
    closed?: boolean
  }
  gameSettings?: AppliedCivLobbySettings
  tournament?: {
    id: string
    name: string
    rematchPolicy: 'allow' | 'warn' | 'block'
    rematchWarning: string | null
    configLocked: true
  } | null
  repeatDraft?: {
    kind: 'resume' | 'complete'
    matchId: string
  } | null
  serverDefaults: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
}

interface LobbyPlacementResponse {
  lobby: LobbySnapshot
  transferNotice: string | null
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

export type LobbyArrangeStrategy = 'randomize' | 'balance' | 'shuffle-teams'

export type ActivityStateChange
  = | { type: 'overview', snapshot: ActivityOverviewSnapshot | null }
    | { type: 'lobby', lobbyId: string, snapshot: LobbySnapshot | null }

export type SelectedSessionStateChange
  = | { type: 'lobby', lobbyId: string, snapshot: LobbySnapshot | null }
    | { type: 'session-started', lobbyId: string, matchId: string, steamLobbyLink: string | null, sessionAccessToken: string | null, mode: string | null }

interface SessionConnectionOptions {
  onStateChanged?: (change: SelectedSessionStateChange) => void
}

export interface LobbyStateWatch {
  close: () => void
}

export interface LobbyStateWatchOptions {
  channelId: string
  userId: string
  onConnected?: () => void
  onStateChanged: (change: ActivityStateChange) => void
  onDisconnected?: () => void
  onError?: (message: string) => void
}

export interface ActivityTargetOption {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  originGuildId: string
  mode: string
  status: 'open' | 'closed' | 'drafting' | 'active' | 'completed'
  reported?: boolean
  starting?: boolean
  participantCount: number
  targetSize: number
  redDeath: boolean
  civBlitz: boolean
  isMember: boolean
  isHost: boolean
  players?: ActivityOverviewPlayerSnapshot[]
  updatedAt: number
}

export interface ActivityOverviewPlayerSnapshot {
  playerId: string
  displayName: string
  avatarUrl?: string | null
  team?: number | null
  sourceGuild?: { id: string, name?: string | null, iconUrl?: string | null }
}

export interface ActivityOverviewOptionSnapshot {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  originGuildId: string
  mode: string
  status: 'open' | 'closed' | 'drafting' | 'active' | 'completed'
  reported?: boolean
  starting?: boolean
  participantCount: number
  targetSize: number
  redDeath: boolean
  civBlitz: boolean
  hostId: string
  memberPlayerIds: string[]
  players?: ActivityOverviewPlayerSnapshot[]
  updatedAt: number
}

export interface ActivityOverviewSnapshot {
  channelId: string
  options: ActivityOverviewOptionSnapshot[]
  supportedServers: ActivitySupportedServerSnapshot[]
}

export interface ActivitySupportedServerSnapshot {
  id: string
  name: string | null
  iconUrl: string | null
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
    sessionAccessToken: string | null
    lobbyId?: string | null
    mode?: string | null
  }

export interface ActivityLaunchSnapshot {
  selection: ActivityLaunchSelection | null
  options: ActivityTargetOption[]
}

export interface SessionSocketTarget {
  host: string
  prefix?: string
  label?: string
}

// ── State ──────────────────────────────────────────────────

export const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
export const [connectionError, setConnectionError] = createSignal<string | null>(null)
export const [connectionCloseReason, setConnectionCloseReason] = createSignal<string | null>(null)

const SOCKET_FATAL_CLOSE_MIN = 4000
const SOCKET_FATAL_CLOSE_MAX = 5000
const STALE_DRAFT_RECONNECT_CHECK_MS = 1_000
const SESSION_SOCKET_MAX_RETRIES = 12

// ── Socket ─────────────────────────────────────────────────

let socket: PartySocket | null = null
let currentSessionConnection: { target: SessionSocketTarget, sessionId: string, sessionAccessToken: string | null, onStateChanged?: (change: SelectedSessionStateChange) => void } | null = null
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

/** Connect to the selected session runtime socket. */
export function connectToSession(target: SessionSocketTarget, sessionId: string, sessionAccessToken: string | null, options: SessionConnectionOptions = {}) {
  if (socket && currentSessionConnection?.sessionId === sessionId && currentSessionConnection.sessionAccessToken === sessionAccessToken) {
    currentSessionConnection = { ...currentSessionConnection, target, onStateChanged: options.onStateChanged }
    return
  }

  stopStaleDraftReconnectWatchdog()
  const previousSocket = socket
  socket = null
  previousSocket?.close()
  lastSentPreviewKeys = {}
  lastSocketActivityAt = 0
  lastForcedReconnectTimerEndsAt = null
  lastServerErrorMessage = null
  currentSessionConnection = null

  setConnectionStatus('connecting')
  setConnectionError(null)
  setConnectionCloseReason(null)

  const activitySessionToken = getActivitySessionToken()
  if (getAuthTransport() === 'token' && !activitySessionToken) {
    setConnectionStatus('error')
    setConnectionError('Missing activity session. Reopen the activity.')
    return
  }

  currentSessionConnection = { target, sessionId, sessionAccessToken, onStateChanged: options.onStateChanged }
  startStaleDraftReconnectWatchdog()

  const query: Record<string, string> = {}
  if (getAuthTransport() === 'token' && activitySessionToken) query[CIVUP_ACTIVITY_SESSION_QUERY_PARAM] = activitySessionToken
  if (sessionAccessToken) query.accessToken = sessionAccessToken

  const nextSocket = new PartySocket({
    host: target.host,
    party: 'session',
    prefix: target.prefix ?? 'api/parties',
    room: sessionId,
    query,
    maxRetries: SESSION_SOCKET_MAX_RETRIES,
  })
  socket = nextSocket

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return
    lastSocketActivityAt = draftNow()
    lastServerErrorMessage = null
    setConnectionStatus('connected')
    setConnectionError(null)
    setConnectionCloseReason(null)
  })

  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket) return
    const receivedAt = Date.now()
    try {
      const msg = JSON.parse(event.data as string) as SessionServerMessage
      if (msg.type === 'init' || msg.type === 'update') syncDraftServerTime(msg.serverNow, receivedAt)
      lastSocketActivityAt = draftNow(receivedAt)
      handleServerMessage(msg)
    }
    catch (err) {
      lastSocketActivityAt = draftNow(receivedAt)
      relayDevLog('error', 'Failed to parse server message', err)
      console.error('Failed to parse server message:', err)
    }
  })

  nextSocket.addEventListener('close', (event) => {
    if (socket !== nextSocket) return

    const code = typeof event.code === 'number' ? event.code : -1
    const closeReason = typeof event.reason === 'string' && event.reason.length > 0
      ? event.reason
      : null
    const reason = closeReason ?? (typeof event.type === 'string' ? event.type : '-')

    if (code !== 1000) {
      if (isFatalSocketClose(code)) stopSocketReconnects(nextSocket, `fatal close ${code}`)
      if (code === 4401) clearActivitySessionToken()

      relayDevLog('warn', 'Session socket closed unexpectedly', {
        code,
        reason,
        sessionId,
        retryCount: nextSocket.retryCount,
        target: describeSessionSocketTarget(target),
      })

      if (shouldRetrySessionSocket(nextSocket, code)) {
        setConnectionStatus('reconnecting')
        setConnectionError(null)
        return
      }

      socket = null
      stopStaleDraftReconnectWatchdog()
      currentSessionConnection = null
      lastSocketActivityAt = 0
      setConnectionStatus('error')
      setConnectionError(formatSessionSocketCloseError(code, reason, lastServerErrorMessage))
      setConnectionCloseReason(closeReason)
      return
    }

    socket = null
    stopStaleDraftReconnectWatchdog()
    currentSessionConnection = null
    lastSocketActivityAt = 0
    setConnectionStatus('disconnected')
    setConnectionCloseReason(closeReason)
  })

  nextSocket.addEventListener('error', () => {
    if (socket !== nextSocket) return

    if (shouldRetrySessionSocket(nextSocket)) {
      relayDevLog('warn', 'Session socket connection interrupted', {
        sessionId,
        retryCount: nextSocket.retryCount,
        target: describeSessionSocketTarget(target),
      })
      setConnectionStatus('reconnecting')
      setConnectionError(null)
      return
    }

    relayDevLog('error', 'Session socket connection failed', {
      sessionId,
      target: describeSessionSocketTarget(target),
    })
    socket = null
    stopStaleDraftReconnectWatchdog()
    currentSessionConnection = null
    lastSocketActivityAt = 0
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
    setConnectionCloseReason(null)
  })
}

export function disconnect() {
  stopStaleDraftReconnectWatchdog()
  socket?.close()
  socket = null
  currentSessionConnection = null
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
  setConnectionCloseReason(null)
}

function startStaleDraftReconnectWatchdog() {
  stopStaleDraftReconnectWatchdog()
  staleDraftReconnectInterval = setInterval(() => {
    if (!shouldForceReconnectForStaleDraft({
      connectionStatus: connectionStatus(),
      state: draftStore.state,
      timerEndsAt: draftStore.timerEndsAt,
      mapVote: draftStore.mapVote,
      teamFormation: draftStore.teamFormation,
      lastSocketActivityAt,
      lastForcedReconnectTimerEndsAt,
      nowMs: draftNow(),
    })) { return }

    const currentSession = currentSessionConnection
    if (!currentSession) return
    lastForcedReconnectTimerEndsAt = draftStore.timerEndsAt

    relayDevLog('warn', 'Forcing session socket reconnect after stale timer', {
      sessionId: currentSession.sessionId,
      timerEndsAt: draftStore.timerEndsAt,
      mapVotePhase: draftStore.mapVote.phase,
      mapVoteEndsAt: draftStore.mapVote.endsAt,
      teamFormationEndsAt: draftStore.teamFormation.endsAt,
      currentStepIndex: draftStore.state?.currentStepIndex ?? null,
      lastSocketActivityAt,
      target: describeSessionSocketTarget(currentSession.target),
    })
    connectToSession(currentSession.target, currentSession.sessionId, currentSession.sessionAccessToken)
  }, STALE_DRAFT_RECONNECT_CHECK_MS)
}

function stopStaleDraftReconnectWatchdog() {
  if (!staleDraftReconnectInterval) return
  clearInterval(staleDraftReconnectInterval)
  staleDraftReconnectInterval = null
}

/** Directory/session-owned push drives overview updates. */
export function watchLobbyState(target: SessionSocketTarget, options: LobbyStateWatchOptions): LobbyStateWatch {
  let closed = false
  const activitySessionToken = getActivitySessionToken()
  if (getAuthTransport() === 'token' && !activitySessionToken) {
    queueMicrotask(() => {
      if (!closed) options.onError?.('Missing activity session. Reopen the activity.')
    })
    return { close: () => { closed = true } }
  }

  const activitySocket = new PartySocket({
    host: target.host,
    party: 'activity',
    prefix: target.prefix ?? 'api/parties',
    room: ACTIVITY_FEED_ROOM,
    query: getAuthTransport() === 'token' && activitySessionToken
      ? { [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: activitySessionToken }
      : {},
    maxRetries: SESSION_SOCKET_MAX_RETRIES,
  })

  activitySocket.addEventListener('open', () => {
    if (closed) return
    options.onConnected?.()
  })

  activitySocket.addEventListener('message', (event) => {
    if (closed) return
    try {
      const message = JSON.parse(event.data as string) as Record<string, unknown>
      if (message.type === 'overview') {
        options.onStateChanged({ type: 'overview', snapshot: isActivityOverviewSnapshot(message.snapshot) ? message.snapshot : null })
        return
      }
      if (message.type === 'lobby' && typeof message.lobbyId === 'string') {
        options.onStateChanged({ type: 'lobby', lobbyId: message.lobbyId, snapshot: isLobbySnapshot(message.snapshot) ? message.snapshot : null })
        return
      }
      if (message.type === 'error' && typeof message.message === 'string') {
        options.onError?.(message.message)
      }
    }
    catch (err) {
      relayDevLog('error', 'Failed to parse activity feed message', err)
      console.error('Failed to parse activity feed message:', err)
    }
  })

  activitySocket.addEventListener('close', () => {
    if (closed) return
    options.onDisconnected?.()
  })

  activitySocket.addEventListener('error', () => {
    if (closed) return
    options.onError?.('Activity updates disconnected')
  })

  return {
    close: () => {
      if (closed) return
      closed = true
      activitySocket.close()
    },
  }
}

function isActivityOverviewSnapshot(value: unknown): value is ActivityOverviewSnapshot {
  return !!value
    && typeof value === 'object'
    && typeof (value as Partial<ActivityOverviewSnapshot>).channelId === 'string'
    && Array.isArray((value as Partial<ActivityOverviewSnapshot>).options)
    && Array.isArray((value as Partial<ActivityOverviewSnapshot>).supportedServers)
}

function isLobbySnapshot(value: unknown): value is LobbySnapshot {
  return !!value && typeof value === 'object' && typeof (value as Partial<LobbySnapshot>).id === 'string' && typeof (value as Partial<LobbySnapshot>).revision === 'number' && Array.isArray((value as Partial<LobbySnapshot>).entries)
}

// ── Send Messages ──────────────────────────────────────────

export function sendMessage(msg: SessionClientMessage): boolean {
  const status = untrack(connectionStatus)
  if (!socket || status !== 'connected') {
    console.warn('Cannot send message: not connected')
    return false
  }
  socket.send(JSON.stringify(msg))
  return true
}

export function sendStart() {
  return sendMessage({ type: 'start' })
}

export function sendMapVoteSelection(selection: MapVoteSelection) {
  return sendMessage({ type: 'map-vote-selection', selection })
}

export function sendMapVoteConfirm() {
  return sendMessage({ type: 'map-vote-confirm' })
}

export function sendTeamFormationPick(groupId: string, revision: number) {
  return sendMessage({ type: 'team-formation-pick', groupId, revision })
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

export function sendCivBlitzSubmit(kit: CivBlitzPartialKit) {
  return sendMessage({ type: 'civ-blitz-submit', kit })
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

export function sendLeaderSwap(toSeat: number) {
  return sendMessage({ type: 'leader-swap', toSeat })
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
      reject(new Error('Not connected to session.'))
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

async function activityApiMutation<T>(method: 'PATCH' | 'DELETE', url: string, body: unknown): Promise<T> {
  const response = await activityFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    let data: unknown
    try {
      data = await response.json()
      if (data && typeof data === 'object' && 'error' in data) message = String(data.error)
    }
    catch {}
    throw new ApiError(message, response.status, data, response.headers)
  }
  return response.status === 204 ? null as T : await response.json<T>()
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
    if (err instanceof ApiError && err.status === 404) return null
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
    mapVoteEnabled?: boolean
    teamFormationEnabled?: boolean
    blindBans?: boolean
    blindPicks?: boolean
    simultaneousPick?: boolean
    permanentAlly?: boolean
    redDeath?: boolean
    dealOptionsSize?: number | null
    civBlitz?: boolean
    civBlitzOptionCount?: number | null
    civBlitzExcludeBbgExpanded?: boolean
    randomDraft?: boolean
    hiddenDraft?: boolean
    duplicateFactions?: boolean
    closed?: boolean
    targetSize?: number
    steamLobbyLink?: string | null
    minRole?: CompetitiveTier | null
    maxRole?: CompetitiveTier | null
    gameSettings?: GameSettingsApplyRequest
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
      mapVoteEnabled: draftConfig.mapVoteEnabled,
      teamFormationEnabled: draftConfig.teamFormationEnabled,
      blindBans: draftConfig.blindBans,
      blindPicks: draftConfig.blindPicks,
      simultaneousPick: draftConfig.simultaneousPick,
      permanentAlly: draftConfig.permanentAlly,
      redDeath: draftConfig.redDeath,
      dealOptionsSize: draftConfig.dealOptionsSize,
      civBlitz: draftConfig.civBlitz,
      civBlitzOptionCount: draftConfig.civBlitzOptionCount,
      civBlitzExcludeBbgExpanded: draftConfig.civBlitzExcludeBbgExpanded,
      randomDraft: draftConfig.randomDraft,
      hiddenDraft: draftConfig.hiddenDraft,
      duplicateFactions: draftConfig.duplicateFactions,
      closed: draftConfig.closed,
      targetSize: draftConfig.targetSize,
      steamLobbyLink: draftConfig.steamLobbyLink,
      minRole: draftConfig.minRole,
      maxRole: draftConfig.maxRole,
      gameSettings: draftConfig.gameSettings,
    })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to update lobby config:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby config' }
  }
}

export type GameSettingsApplyRequest
  = | { source: 'official' }
    | { source: 'community', presetId: string, presetRevision: number }
    | { source: 'custom', profile: CivLobbySettingsProfile }

let gameSettingsPresetCache: CivLobbySettingsCommunityPreset[] | null = null
let gameSettingsPresetCacheToken: string | null | undefined

/** Loads the bounded public catalog on demand and caches it for this Activity session. */
export async function fetchGameSettingsPresets(options: { force?: boolean } = {}): Promise<CivLobbySettingsCommunityPreset[]> {
  const token = getActivitySessionToken()
  if (gameSettingsPresetCacheToken !== token) {
    gameSettingsPresetCacheToken = token
    gameSettingsPresetCache = null
  }
  if (!options.force && gameSettingsPresetCache) return [...gameSettingsPresetCache]
  const response = await activityApiGet<{ presets: CivLobbySettingsCommunityPreset[] }>('/api/game-settings/presets')
  gameSettingsPresetCache = response.presets
  return [...response.presets]
}

export async function createGameSettingsPreset(name: string, profile: CivLobbySettingsProfile): Promise<CivLobbySettingsCommunityPreset> {
  const preset = await activityApiPost<CivLobbySettingsCommunityPreset>('/api/game-settings/presets', { name, profile })
  gameSettingsPresetCache = upsertCachedGameSettingsPreset(gameSettingsPresetCache, preset)
  return preset
}

export async function updateGameSettingsPreset(
  id: string,
  revision: number,
  input: { name?: string, profile?: CivLobbySettingsProfile },
): Promise<CivLobbySettingsCommunityPreset> {
  const preset = await activityApiMutation<CivLobbySettingsCommunityPreset>('PATCH', `/api/game-settings/presets/${encodeURIComponent(id)}`, { revision, ...input })
  gameSettingsPresetCache = upsertCachedGameSettingsPreset(gameSettingsPresetCache, preset)
  return preset
}

export async function deleteGameSettingsPreset(id: string, revision: number): Promise<void> {
  await activityApiMutation<void>('DELETE', `/api/game-settings/presets/${encodeURIComponent(id)}`, { revision })
  if (gameSettingsPresetCache) gameSettingsPresetCache = gameSettingsPresetCache.filter(preset => preset.id !== id)
}

function upsertCachedGameSettingsPreset(
  current: CivLobbySettingsCommunityPreset[] | null,
  preset: CivLobbySettingsCommunityPreset,
): CivLobbySettingsCommunityPreset[] | null {
  if (!current) return null
  return [preset, ...current.filter(candidate => candidate.id !== preset.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
    .slice(0, 50)
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
): Promise<{ ok: true, lobby: LobbySnapshot, transferNotice: string | null } | { ok: false, error: string }> {
  try {
    const result = await activityApiPost<LobbyPlacementResponse>(`/api/lobby/${mode}/place`, payload)
    return { ok: true, lobby: result.lobby, transferNotice: result.transferNotice }
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

/** Transfer open lobby host ownership to another slotted player (host-only). */
export async function transferLobbyHost(
  mode: string,
  payload: {
    lobbyId: string
    userId: string
    targetPlayerId: string
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await activityApiPost<LobbySnapshot>(`/api/lobby/${mode}/transfer-host`, payload)
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to transfer lobby host:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while transferring host' }
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

/** Start a draft from an open lobby (host-only). */
export async function startLobbyDraft(
  mode: string,
  lobbyId: string,
  userId: string,
): Promise<{ ok: true, matchId: string, sessionAccessToken: string | null } | { ok: false, error: string }> {
  try {
    const data = await activityApiPost<{ matchId?: string, sessionAccessToken?: string | null }>(`/api/lobby/${mode}/start`, { lobbyId, userId })
    if (!data.matchId) return { ok: false, error: 'Draft started but no match ID was returned' }
    return { ok: true, matchId: data.matchId, sessionAccessToken: data.sessionAccessToken ?? null }
  }
  catch (err) {
    console.error('Failed to start lobby draft:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while starting lobby draft' }
  }
}

/** Repeat or resume the previous matching draft from an open lobby (host-only). */
export async function repeatLobbyDraft(
  mode: string,
  lobbyId: string,
  userId: string,
): Promise<{ ok: true, kind: 'resume' | 'complete', matchId: string, sessionAccessToken: string | null } | { ok: false, error: string }> {
  try {
    const data = await activityApiPost<{ kind?: 'resume' | 'complete', matchId?: string, sessionAccessToken?: string | null }>(`/api/lobby/${mode}/repeat-draft`, { lobbyId, userId })
    if (!data.matchId) return { ok: false, error: 'Draft repeated but no match ID was returned' }
    return { ok: true, kind: data.kind ?? 'complete', matchId: data.matchId, sessionAccessToken: data.sessionAccessToken ?? null }
  }
  catch (err) {
    console.error('Failed to repeat lobby draft:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while repeating draft' }
  }
}

/** Cancel an open lobby before draft creation. */
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
): Promise<{ ok: true, snapshot: ActivityLaunchSnapshot } | { ok: false, error: string, status?: number }> {
  try {
    const data = await activityApiPost<{ snapshot?: ActivityLaunchSnapshot }>('/api/activity/target', {
      channelId,
      userId,
      kind: target.kind,
      id: target.id,
    })
    if (!data.snapshot) return { ok: false, error: 'Activity target response was missing a snapshot' }
    return { ok: true, snapshot: data.snapshot }
  }
  catch (err) {
    console.error('Failed to select activity target:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message, status: err.status }
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
  leaderAssignments?: Record<string, string>,
): Promise<ReportMatchResult> {
  try {
    const data = await activityApiPost<{ ok?: boolean, reportProcessing?: boolean, reportFinalizing?: boolean, error?: string }>(`/api/match/${matchId}/report`, { reporterId, placements, leaderAssignments })
    if (data.reportProcessing) {
      const reason = data.reportFinalizing ? 'finalizing' : 'processing'
      return {
        ok: false,
        reason,
        error: data.reportFinalizing
          ? 'Match is finalizing leader swaps. Try again in a moment.'
          : 'Another player is already reporting this result. Finalizing the report...',
      }
    }
    if (data.ok === false) return { ok: false, error: data.error ?? 'Failed to report result' }
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

    const data = await res.json<LobbySnapshot & { error?: string, addedCount?: unknown }>()
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

function handleServerMessage(msg: SessionServerMessage) {
  switch (msg.type) {
    case 'lobby':
      currentSessionConnection?.onStateChanged?.({
        type: 'lobby',
        lobbyId: msg.lobbyId,
        snapshot: isLobbySnapshot(msg.snapshot) ? msg.snapshot : null,
      })
      break
    case 'session-started':
      currentSessionConnection?.onStateChanged?.({
        type: 'session-started',
        lobbyId: msg.lobbyId,
        matchId: msg.matchId,
        steamLobbyLink: msg.steamLobbyLink,
        sessionAccessToken: msg.sessionAccessToken,
        mode: msg.mode,
      })
      break
    case 'init':
      clearSelections()
      syncForcedReconnectTimer(msg.timerEndsAt)
      syncPreviewCache(msg.previews, msg.seatIndex)
      initDraft(msg.state, msg.leaderDataVersion ?? 'live', msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.seatIndex, msg.timerEndsAt, msg.completedAt, msg.previews, msg.swapState ?? null, msg.mapVote, msg.teamFormation, msg.steamLobbyLink ?? null, msg.permanentAlly === true, msg.hiddenDraft === true)
      if (shouldDisconnectAfterState(msg.state.status, msg.swapState ?? null)) {
        disconnect()
      }
      break
    case 'update':
      syncForcedReconnectTimer(msg.timerEndsAt)
      syncPreviewCache(msg.previews)
      updateDraft(msg.state, msg.leaderDataVersion ?? 'live', msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.events, msg.timerEndsAt, msg.completedAt, msg.previews, msg.swapState ?? null, msg.mapVote, msg.teamFormation, msg.steamLobbyLink ?? null, msg.permanentAlly === true, msg.hiddenDraft === true)
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
    case 'projection-update':
      updateDraftSteamLobbyLink(msg.steamLobbyLink)
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

function formatSessionSocketCloseError(
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
    return 'Session access token is invalid or expired. Reopen the activity.'
  }

  return `WebSocket closed (${code}${reason ? `: ${reason}` : ''})`
}

function formatConfigAckError(message: string): Error {
  if (message === 'Unknown message type') {
    return new Error(ACTIVITY_VERSION_OUTDATED_MESSAGE)
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

function describeSessionSocketTarget(target: SessionSocketTarget): string {
  return `${target.label ?? 'socket'}:${target.host}/${target.prefix ?? 'api/parties'}`
}

function shouldRetrySessionSocket(currentSocket: PartySocket, code?: number): boolean {
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

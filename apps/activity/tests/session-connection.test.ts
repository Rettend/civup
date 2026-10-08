import type { DraftState } from '@civup/game'
import type { SessionServerMessage } from '@civup/session'
import type { PartySocket, PartySocketOptions } from 'partysocket'
import { createEffect, createRoot, DEV, flush, OBSERVE, snapshot } from 'solid-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createDraft, default2v2, EMPTY_MAP_VOTE_SNAPSHOT } from '@civup/game'
import { CIVUP_ACTIVITY_SESSION_HEADER, CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import { configureActivitySessionRenewal } from '../src/client/lib/activity-request'
import {
  cacheActivitySessionToken,
  clearActivitySessionToken,
  getActivitySessionToken,
} from '../src/client/lib/activity-session'
import { configureClientPlatform } from '../src/client/platform/runtime'
import {
  connectionCloseReason,
  connectionError,
  connectionStatus,
  connectToSession,
  disconnect,
  sendConfig,
  sendPick,
  sendPreview,
  sendStart,
  watchLobbyState,
} from '../src/client/stores/connection-store'
import {
  draftNow,
  draftStore,
  getOptimisticSeatPick,
  resetDraft,
  syncDraftServerTime,
} from '../src/client/stores/draft-store'
import { clearSelections, selectedLeader, setSelectedLeader } from '../src/client/stores/ui-store'

const { sockets, FakePartySocket, realSocketFactory } = vi.hoisted(() => {
  interface SocketEvent {
    type: string
    data: string
    code: number
    reason: string
  }
  const instances: Socket[] = []
  class Socket {
    readonly listeners = new Map<string, ((event: SocketEvent) => void)[]>()
    readonly sent: string[] = []
    readonly closeCalls: { code: number; reason: string }[] = []
    readonly queries: Record<string, string>[] = []
    readonly queryRetryCounts: number[] = []
    reconnectCalls = 0
    retryCount = 0
    readyState = 0
    shouldReconnect = true
    private connectLocked = true
    constructor(readonly options: Record<string, unknown>) {
      instances.push(this)
    }
    addEventListener(type: string, listener: (event: SocketEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }
    send(data: string) {
      this.sent.push(data)
    }
    close(code = 1000, reason = '') {
      this.shouldReconnect = false
      this.closeCalls.push({ code, reason })
      // Deliberately synchronous to catch handlers that clear their reference
      // after close(). The real wrapper may forward a native close callback.
      this.emit('close', { code, reason })
    }
    reconnect() {
      this.reconnectCalls += 1
      this.shouldReconnect = true
      this.retryCount = 0
      this.connectLocked = true
    }
    async resolveQuery() {
      if (!this.shouldReconnect) return null
      this.queryRetryCounts.push(this.retryCount)
      const factory = this.options.query as () => Promise<Record<string, string>>
      const query = await factory()
      this.connectLocked = false
      // Like PartySocket's _closeCalled check after awaiting its URL provider.
      if (!this.shouldReconnect) return null
      this.queries.push(query)
      this.readyState = 0
      return query
    }
    private scheduleReconnect() {
      if (!this.shouldReconnect || this.connectLocked) return
      this.connectLocked = true
      // PartySocket leaves shouldReconnect true when its retry limit is hit.
      if (this.retryCount >= (this.options.maxRetries as number)) return
      this.retryCount += 1
    }
    emit(type: string, event: Partial<SocketEvent> = {}) {
      if (type === 'open') {
        this.readyState = 1
        this.connectLocked = false
      }
      if (type === 'error') {
        // v1.1.12 _handleError -> _disconnect -> _handleClose happens BEFORE
        // dispatching the error, including failed WebSocket upgrade requests.
        this.emit('close', { code: 1000, reason: event.reason ?? '' })
      }
      if (type === 'close') {
        this.readyState = 3
        this.scheduleReconnect()
      }
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data: '', code: 0, reason: '', ...event })
      if (type === 'error') this.scheduleReconnect()
    }
    message(message: SessionServerMessage) {
      this.emit('message', { data: JSON.stringify(message) })
    }
  }
  return {
    sockets: instances,
    FakePartySocket: Socket,
    realSocketFactory: { current: null as ((options: PartySocketOptions) => PartySocket) | null },
  }
})

vi.mock('partysocket', () => {
  function Socket(options: PartySocketOptions) {
    return realSocketFactory.current?.(options) ?? new FakePartySocket(options)
  }
  return { default: Socket }
})

const target = { host: 'activity.example.com', prefix: 'api/parties' }
const renewSession = vi.fn<() => Promise<void>>()
const fetchMock = vi.fn<typeof fetch>()
type InitMessage = Extract<SessionServerMessage, { type: 'init' }>

async function settleAsync() {
  // API parsing, the renewal single flight and query factories each add promise
  // turns. No fake timer advancement is needed to finish their immediate work.
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  flush()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

async function useRealPartySocket(
  backoff: Partial<PartySocketOptions> = { minReconnectionDelay: 1, maxReconnectionDelay: 1 },
) {
  const { default: RealPartySocket } = await vi.importActual<typeof import('partysocket')>('partysocket')
  const nativeSockets: NativeSocket[] = []
  const partySockets: PartySocket[] = []
  class NativeSocket extends EventTarget {
    readyState = 0
    binaryType = 'blob'
    constructor(readonly url: string) {
      super()
      nativeSockets.push(this)
    }
    close() {
      this.readyState = 3
    }
    failUpgrade() {
      this.dispatchEvent(new ErrorEvent('error', { message: 'WebSocket upgrade failed' }))
    }
  }
  realSocketFactory.current = options => {
    const partySocket = new RealPartySocket({
      ...options,
      WebSocket: NativeSocket,
      ...backoff,
    })
    partySockets.push(partySocket)
    return partySocket
  }
  return { nativeSockets, partySockets }
}

function activeState(): DraftState {
  return {
    ...createDraft(
      'match-1',
      default2v2,
      [
        { playerId: 'a1', displayName: 'A1', team: 0 },
        { playerId: 'b1', displayName: 'B1', team: 1 },
        { playerId: 'a2', displayName: 'A2', team: 0 },
        { playerId: 'b2', displayName: 'B2', team: 1 },
      ],
      Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`),
    ),
    status: 'active',
    currentStepIndex: 0,
    steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60 }],
  }
}

function initMessage(overrides: Partial<InitMessage> = {}): InitMessage {
  return {
    type: 'init',
    state: activeState(),
    seatIndex: 0,
    hostId: 'a1',
    serverNow: Date.now(),
    timerEndsAt: Date.now() + 60_000,
    completedAt: null,
    mapVote: EMPTY_MAP_VOTE_SNAPSHOT,
    previews: { bans: {}, picks: {} },
    swapState: null,
    ...overrides,
  }
}

function latestSocket() {
  const socket = sockets.at(-1)
  if (!socket) throw new Error('Expected a test socket')
  return socket
}

function startTransport(kind: 'session' | 'overview', onError = vi.fn()) {
  let close: () => void
  if (kind === 'session') {
    connectToSession(target, 'session-1', 'room-access-token')
    close = disconnect
  } else {
    close = watchLobbyState(target, {
      channelId: 'channel-1',
      userId: 'a1',
      onStateChanged: vi.fn(),
      onError,
    }).close
  }
  return { socket: latestSocket(), close, onError }
}

function connect(overrides: Partial<InitMessage> = {}) {
  connectToSession(target, 'session-1', null)
  const socket = latestSocket()
  socket.emit('open')
  socket.message(initMessage(overrides))
  return socket
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  // Dev logs remain enabled, but their beacon transport is local to this test.
  vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true)
  disconnect()
  resetDraft()
  clearSelections()
  flush()
  sockets.length = 0
  realSocketFactory.current = null
  configureClientPlatform('discord-embedded', 'token')
  cacheActivitySessionToken('test-activity-session')
  renewSession.mockReset().mockImplementation(async () => {
    cacheActivitySessionToken(`renewed-activity-session-${renewSession.mock.calls.length}`)
  })
  configureActivitySessionRenewal(renewSession)
  fetchMock.mockReset().mockImplementation(async () => Response.json({ userId: 'a1' }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  disconnect()
  resetDraft()
  clearSelections()
  flush()
  clearActivitySessionToken()
  configureActivitySessionRenewal(null)
  configureClientPlatform('discord-embedded', 'token')
  realSocketFactory.current = null
})

describe('selected session transport', () => {
  test('connects from a split-effect callback using the scheduled clock reset without diagnostics', async () => {
    syncDraftServerTime(100_000, Date.now())
    flush()
    expect(draftNow()).toBe(100_000)
    const capture = OBSERVE?.diagnostics.capture()
    if (!capture) throw new Error('Expected Solid development diagnostics')
    const dispose = createRoot(stop => {
      createEffect(
        () => 'session-1',
        sessionId => {
          // ActivityShell transitions reset the draft immediately before connecting.
          resetDraft()
          connectToSession(target, sessionId, null)
        },
      )
      return stop
    })
    try {
      flush()
      const socket = latestSocket()
      socket.emit('open')
      socket.message(initMessage({ serverNow: undefined, timerEndsAt: 11_000 }))
      flush()
      expect(capture.events).toEqual([])
      await vi.advanceTimersByTimeAsync(7_000)
      // The reset clock is local time. An inherited 90-second offset would
      // falsely make this connection's activity newer than the expired deadline.
      expect(sockets).toHaveLength(2)
      expect(socket.shouldReconnect).toBe(false)
    } finally {
      dispose()
      capture.stop()
    }
  })

  test('hydrates previews before sending, including an init and preview in the same tick', () => {
    expect(DEV).toBeDefined()
    const socket = connect({ seatIndex: 2, previews: { bans: {}, picks: { 2: ['civ-1'] } } })
    socket.message({ type: 'preview', previews: { bans: {}, picks: { 2: ['civ-2'] } } })
    expect(sendPreview('pick', ['civ-2'])).toBe(true)
    expect(socket.sent).toEqual([])
    expect(sendPreview('pick', ['civ-3'])).toBe(true)
    expect(socket.sent.map(value => JSON.parse(value))).toEqual([
      { type: 'preview', action: 'pick', civIds: ['civ-3'] },
    ])
    flush()
    expect(connectionStatus()).toBe('connected')
    expect(snapshot(draftStore.previews.picks)).toEqual({ 2: ['civ-2'] })
  })

  test('a newer reconnect snapshot replaces optimistic picks and rejects the old socket', () => {
    const first = connect()
    flush()
    sendPick('civ-2')
    setSelectedLeader('civ-2')
    flush()
    expect(getOptimisticSeatPick(0)).toBe('civ-2')

    connectToSession(target, 'session-1', null, { forceReconnect: true })
    const second = latestSocket()
    expect(second).not.toBe(first)
    expect(first.shouldReconnect).toBe(false)
    second.emit('open')
    const newerState = { ...activeState(), picks: [{ seatIndex: 0, civId: 'civ-3', stepIndex: 0 }] }
    second.message(initMessage({ state: newerState, previews: { bans: {}, picks: { 0: ['civ-3'] } } }))
    first.message({ ...initMessage({ state: activeState() }), type: 'update', events: [] })
    first.emit('close', { code: 4401 })
    flush()
    expect(draftStore.state?.picks[0]?.civId).toBe('civ-3')
    expect(getOptimisticSeatPick(0)).toBeNull()
    expect(selectedLeader()).toBeNull()
    expect(connectionStatus()).toBe('connected')
    expect(connectionError()).toBeNull()
    expect(sendPreview('pick', ['civ-3'])).toBe(true)
    expect(second.sent).toEqual([])
  })

  test('reconnects after a stale deadline, retains callbacks, and only forces once per deadline', async () => {
    const onStateChanged = vi.fn()
    connectToSession(target, 'session-1', null, { onStateChanged })
    const first = latestSocket()
    first.emit('open')
    first.message(initMessage({ timerEndsAt: 11_000 }))
    flush()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(sockets).toHaveLength(2)
    expect(first.shouldReconnect).toBe(false)
    const second = latestSocket()
    second.emit('open')
    second.message(initMessage({ serverNow: 10_000, timerEndsAt: 11_000 }))
    second.message({
      type: 'session-started',
      lobbyId: 'lobby-1',
      matchId: 'match-2',
      steamLobbyLink: null,
      sessionAccessToken: null,
      mode: '2v2',
    })
    flush()
    expect(onStateChanged).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'match-2' }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sockets).toHaveLength(2)
    second.message({ ...initMessage({ serverNow: 30_000, timerEndsAt: 32_000 }), type: 'update', events: [] })
    flush()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(sockets).toHaveLength(3)
    expect(second.shouldReconnect).toBe(false)
  })

  test('keeps incoming activity in server time before the clock signal commits', async () => {
    const socket = connect({ serverNow: 100_000, timerEndsAt: 90_000 })
    socket.message({ type: 'preview', previews: { bans: {}, picks: {} } })
    flush()
    await vi.advanceTimersByTimeAsync(1_000)
    // This expired timer has newer socket activity, so it is not stale.
    expect(sockets).toHaveLength(1)
    expect(connectionStatus()).toBe('connected')
  })

  test.each([11_000, null])(
    'deduplicates reconnects with map vote deadline %s and the active-step fallback',
    async endsAt => {
      const message = initMessage({
        timerEndsAt: endsAt == null ? 11_000 : null,
        mapVote: { ...EMPTY_MAP_VOTE_SNAPSHOT, enabled: true, phase: 'voting', endsAt },
      })
      const first = connect(message)
      flush()
      await vi.advanceTimersByTimeAsync(7_000)
      expect(sockets).toHaveLength(2)
      expect(first.shouldReconnect).toBe(false)
      const second = latestSocket()
      second.emit('open')
      second.message({ ...message, serverNow: 10_000 })
      flush()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(sockets).toHaveLength(2)
    },
  )

  test.each(['complete', 'cancelled'] as const)(
    'a %s update disconnects immediately and leaves the final snapshot',
    status => {
      const socket = connect()
      flush()
      setSelectedLeader('civ-2')
      socket.message({
        ...initMessage({ state: { ...activeState(), status }, completedAt: 12_000 }),
        type: 'update',
        events: [],
      })
      expect(socket.shouldReconnect).toBe(false)
      expect(sendStart()).toBe(false)
      socket.message(initMessage())
      socket.emit('open')
      flush()
      expect(draftStore.state?.status).toBe(status)
      expect(connectionStatus()).toBe('disconnected')
      expect(selectedLeader()).toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  test('keeps the socket during the swap window and disconnects at finalization', () => {
    const socket = connect({ state: { ...activeState(), status: 'complete' }, swapState: { completedSwaps: [] } })
    flush()
    expect(connectionStatus()).toBe('connected')
    expect(socket.closeCalls).toEqual([])
    socket.message({
      ...initMessage({ state: { ...activeState(), status: 'complete' }, swapState: null }),
      type: 'update',
      events: [],
    })
    flush()
    expect(socket.shouldReconnect).toBe(false)
    expect(connectionStatus()).toBe('disconnected')
  })

  test('disconnect for a hidden Activity keeps its draft but stops background work', async () => {
    const first = connect()
    flush()
    const initial = snapshot(draftStore.state)
    disconnect()
    flush()
    expect(first.shouldReconnect).toBe(false)
    expect(snapshot(draftStore.state)).toEqual(initial)
    expect(vi.getTimerCount()).toBe(0)
    first.message(initMessage({ state: { ...activeState(), status: 'cancelled' } }))
    await vi.advanceTimersByTimeAsync(90_000)
    expect(sockets).toHaveLength(1)
    expect(snapshot(draftStore.state)).toEqual(initial)

    const second = connect({ hostId: 'a2' })
    flush()
    expect(sockets).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(connectionStatus()).toBe('connected')
    expect(draftStore.hostId).toBe('a2')
  })

  test('rejects pending config work on replacement and cannot acknowledge it from the old socket', async () => {
    const first = connect()
    flush()
    const pending = sendConfig(120, 150).then(
      () => 'saved',
      error => (error as Error).message,
    )
    connectToSession(target, 'session-2', null)
    first.message({ ...initMessage(), type: 'update', events: [] })
    expect(await pending).toBe('The lobby disconnected before the change was confirmed.')
    flush()
    expect(connectionStatus()).toBe('connecting')
    expect(draftStore.state?.matchId).toBe('match-1')
    expect(vi.getTimerCount()).toBe(1)
  })

  test('room denial stops retries without clearing Activity auth and preserves its error through a synchronous close callback', async () => {
    const socket = connect()
    flush()
    const pending = sendConfig(120, 150).then(
      () => 'saved',
      error => (error as Error).message,
    )
    socket.emit('close', { code: 4403, reason: 'room denied' })
    flush()
    expect(socket.shouldReconnect).toBe(false)
    expect(connectionStatus()).toBe('error')
    expect(connectionError()).toBe('Could not open this activity.')
    expect(connectionCloseReason()).toBe('room denied')
    expect(getActivitySessionToken()).toBe('test-activity-session')
    expect(renewSession).not.toHaveBeenCalled()
    expect(await pending).toBe('The lobby disconnected before the change was confirmed.')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a closed overview watcher ignores late responses and disconnect callbacks', () => {
    const onConnected = vi.fn()
    const onStateChanged = vi.fn()
    const onDisconnected = vi.fn()
    const onError = vi.fn()
    const watcher = watchLobbyState(target, {
      channelId: 'channel-1',
      userId: 'a1',
      onConnected,
      onStateChanged,
      onDisconnected,
      onError,
    })
    const socket = latestSocket()
    socket.emit('open')
    socket.emit('message', {
      data: JSON.stringify({ type: 'overview', snapshot: { channelId: 'channel-1', options: [] } }),
    })
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    watcher.close()
    watcher.close()
    socket.emit('open')
    socket.emit('error')
    socket.emit('message', { data: JSON.stringify({ type: 'overview', snapshot: null }) })
    expect(socket.closeCalls).toHaveLength(1)
    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('socket Activity auth recovery', () => {
  test('real retries preserve increasing backoff without replacing the wrapper or resetting its budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { nativeSockets, partySockets } = await useRealPartySocket({
      minReconnectionDelay: 1_000,
      maxReconnectionDelay: 10_000,
      reconnectionDelayGrowFactor: 1.3,
    })
    connectToSession(target, 'session-1', 'room-access-token')
    await vi.advanceTimersByTimeAsync(0)
    const partySocket = partySockets[0]!
    const reconnect = vi.spyOn(partySocket, 'reconnect')
    expect(partySocket.partySocketOptions).toMatchObject({ maxRetries: 12 })
    nativeSockets[0]!.failUpgrade()
    await vi.advanceTimersByTimeAsync(999)
    expect(nativeSockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(nativeSockets).toHaveLength(2)
    expect(partySocket.retryCount).toBe(1)
    nativeSockets[1]!.failUpgrade()
    await vi.advanceTimersByTimeAsync(1_299)
    expect(nativeSockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(nativeSockets).toHaveLength(3)
    expect(partySocket.retryCount).toBe(2)
    expect(partySockets).toHaveLength(1)
    expect(reconnect).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(renewSession).not.toHaveBeenCalled()
  })

  test('the installed PartySocket keeps synthetic-close errors recoverable and stops at its actual retry limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { nativeSockets, partySockets } = await useRealPartySocket()
    connectToSession(target, 'session-1', 'room-access-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(nativeSockets).toHaveLength(1)
    const partySocket = partySockets[0]!
    const reconnect = vi.spyOn(partySocket, 'reconnect')
    const order: string[] = []
    const internalCloseCodes: number[] = []
    // The installed browser event clone loses the synthetic close's numeric
    // code. onclose still receives the original 1000; both precede the error.
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- The original synthetic event is only available here.
    partySocket.onclose = event => internalCloseCodes.push(event.code)
    partySocket.addEventListener('close', () => order.push('close'))
    partySocket.addEventListener('error', () => order.push('error'))
    for (let retry = 1; retry <= 12; retry += 1) {
      nativeSockets.at(-1)!.failUpgrade()
      flush()
      expect(partySocket.shouldReconnect).toBe(true)
      expect(connectionStatus()).toBe('reconnecting')
      await vi.advanceTimersByTimeAsync(1)
      expect(nativeSockets).toHaveLength(retry + 1)
    }
    nativeSockets.at(-1)!.failUpgrade()
    await settleAsync()
    expect(internalCloseCodes[0]).toBe(1000)
    expect(order.slice(0, 2)).toEqual(['close', 'error'])
    expect(partySocket.retryCount).toBe(12)
    expect(partySocket.shouldReconnect).toBe(false)
    expect(connectionStatus()).toBe('error')
    expect(connectionError()).toBe('Reopen the activity to reconnect.')
    expect(nativeSockets).toHaveLength(13)
    expect(partySockets).toHaveLength(1)
    expect(reconnect).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(renewSession).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('the installed PartySocket does not construct a native socket after cancellation during its async query', async () => {
    const { nativeSockets, partySockets } = await useRealPartySocket()
    clearActivitySessionToken()
    const renewal = deferred<void>()
    renewSession.mockImplementation(async () => {
      await renewal.promise
      cacheActivitySessionToken('fresh-after-real-socket-close')
    })
    connectToSession(target, 'session-1', 'room-access-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(renewSession).toHaveBeenCalledTimes(1)
    disconnect()
    renewal.resolve()
    await settleAsync()
    await vi.advanceTimersByTimeAsync(0)
    expect(nativeSockets).toHaveLength(0)
    expect(partySockets[0]?.shouldReconnect).toBe(false)
    expect(connectionStatus()).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['session', 'overview'] as const)('%s uses fresh credentials on retries', async kind => {
    const { socket, close } = startTransport(kind)
    expect(socket.options.query).toBeTypeOf('function')
    expect(socket.options).not.toHaveProperty('minReconnectionDelay')
    expect(socket.options).not.toHaveProperty('reconnectionDelayGrowFactor')
    expect(await socket.resolveQuery()).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'test-activity-session',
      ...(kind === 'session' ? { accessToken: 'room-access-token' } : {}),
    })
    cacheActivitySessionToken('new-activity-session')
    socket.emit('close', { code: 1006 })
    expect(await socket.resolveQuery()).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'new-activity-session',
      ...(kind === 'session' ? { accessToken: 'room-access-token' } : {}),
    })
    expect(renewSession).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    close()
  })

  test.each([
    ['session', 'missing'],
    ['session', 'near expiry'],
    ['session', 'expired'],
    ['overview', 'missing'],
    ['overview', 'near expiry'],
    ['overview', 'expired'],
  ] as const)('%s renews a %s token before connecting and before reconnecting', async (kind, condition) => {
    const invalidateToken = () => {
      if (condition === 'missing') {
        clearActivitySessionToken()
      } else {
        cacheActivitySessionToken('expiring-activity-session', condition === 'expired' ? 1 : 29)
        if (condition === 'expired') vi.setSystemTime(Date.now() + 2_000)
      }
    }
    invalidateToken()
    const { socket, close } = startTransport(kind)
    expect(await socket.resolveQuery()).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'renewed-activity-session-1',
      ...(kind === 'session' ? { accessToken: 'room-access-token' } : {}),
    })
    invalidateToken()
    socket.emit('close', { code: 1006 })
    expect(await socket.resolveQuery()).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'renewed-activity-session-2',
      ...(kind === 'session' ? { accessToken: 'room-access-token' } : {}),
    })
    expect(renewSession).toHaveBeenCalledTimes(2)
    close()
  })

  test.each(['session', 'overview'] as const)('%s cookie auth never requests an Activity token', async kind => {
    configureClientPlatform('web', 'cookie')
    clearActivitySessionToken()
    const { socket, close } = startTransport(kind)
    expect(await socket.resolveQuery()).toEqual(kind === 'session' ? { accessToken: 'room-access-token' } : {})
    socket.emit('error')
    expect(await socket.resolveQuery()).toEqual(kind === 'session' ? { accessToken: 'room-access-token' } : {})
    expect(renewSession).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    close()
  })

  test.each(['session', 'overview'] as const)('%s ignores renewal after close', async kind => {
    clearActivitySessionToken()
    const renewal = deferred<void>()
    renewSession.mockImplementation(async () => {
      await renewal.promise
      cacheActivitySessionToken('fresh-after-close')
    })
    const { socket, close, onError } = startTransport(kind)
    const query = socket.resolveQuery()
    await settleAsync()
    expect(renewSession).toHaveBeenCalledTimes(1)
    close()
    renewal.resolve()
    expect(await query).toBeNull()
    socket.emit('open')
    socket.emit('error')
    flush()
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.queries).toEqual([])
    expect(socket.closeCalls).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    expect(connectionStatus()).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a replacement connection shares renewal but rejects the previous query', async () => {
    clearActivitySessionToken()
    const renewal = deferred<void>()
    renewSession.mockImplementation(async () => {
      await renewal.promise
      cacheActivitySessionToken('fresh-for-replacement')
    })
    connectToSession(target, 'session-1', 'old-room-token')
    const first = latestSocket()
    const firstQuery = first.resolveQuery()
    await settleAsync()
    connectToSession(target, 'session-2', 'new-room-token')
    const second = latestSocket()
    const secondQuery = second.resolveQuery()
    renewal.resolve()
    expect(await firstQuery).toBeNull()
    expect(await secondQuery).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'fresh-for-replacement',
      accessToken: 'new-room-token',
    })
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(first.shouldReconnect).toBe(false)
    second.emit('open')
    flush()
    expect(connectionStatus()).toBe('connected')
  })

  test.each(['session', 'overview'] as const)('%s stops the wrapper after failed missing-token renewal', async kind => {
    clearActivitySessionToken()
    renewSession.mockRejectedValue(new Error('SDK failed'))
    const { socket, close, onError } = startTransport(kind)
    expect(await socket.resolveQuery()).toBeNull()
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.closeCalls).toHaveLength(1)
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    socket.emit('error')
    socket.emit('close', { code: 4401 })
    await settleAsync()
    expect(renewSession).toHaveBeenCalledTimes(1)
    if (kind === 'session') {
      expect(connectionStatus()).toBe('error')
      expect(connectionError()).toBe('Reopen the activity to sign in again.')
    } else {
      expect(onError).toHaveBeenCalledExactlyOnceWith('Reopen the activity to sign in again.')
    }
    expect(vi.getTimerCount()).toBe(0)
    close()
  })

  test.each(['session', 'overview'] as const)('%s renews rejected auth once', async kind => {
    const { socket, close, onError } = startTransport(kind)
    await socket.resolveQuery()
    socket.emit('open')
    socket.emit('close', { code: 4401, reason: 'expired' })
    expect(await socket.resolveQuery()).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'renewed-activity-session-1',
      ...(kind === 'session' ? { accessToken: 'room-access-token' } : {}),
    })
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(socket.shouldReconnect).toBe(true)
    // A successful upgrade alone is not proof that the server accepted auth.
    socket.emit('open')
    socket.emit('close', { code: 4401, reason: 'still rejected' })
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    if (kind === 'session') expect(connectionStatus()).toBe('error')
    else expect(onError).toHaveBeenCalledTimes(1)
    close()
  })

  test('session and overview socket rejection recovery share one OAuth renewal', async () => {
    const session = startTransport('session')
    const overview = startTransport('overview')
    await session.socket.resolveQuery()
    await overview.socket.resolveQuery()
    session.socket.emit('close', { code: 4401 })
    overview.socket.emit('close', { code: 4401 })
    const queries = await Promise.all([session.socket.resolveQuery(), overview.socket.resolveQuery()])
    expect(queries).toEqual([
      { [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'renewed-activity-session-1', accessToken: 'room-access-token' },
      { [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'renewed-activity-session-1' },
    ])
    expect(renewSession).toHaveBeenCalledTimes(1)
    overview.close()
  })

  test.each(['session', 'overview'] as const)('%s cancels rejection recovery on close', async kind => {
    const renewal = deferred<void>()
    renewSession.mockImplementation(async () => {
      await renewal.promise
      cacheActivitySessionToken('fresh-after-rejection')
    })
    const { socket, close, onError } = startTransport(kind)
    await socket.resolveQuery()
    socket.emit('close', { code: 4401 })
    const retryQuery = socket.resolveQuery()
    await settleAsync()
    close()
    renewal.resolve()
    expect(await retryQuery).toBeNull()
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.reconnectCalls).toBe(0)
    expect(onError).not.toHaveBeenCalled()
    flush()
    expect(connectionStatus()).toBe('disconnected')
  })

  test.each(['successful probe', 'network failure', 'unmarked 401'] as const)(
    'synthetic 1000-before-error keeps the session retryable after a %s without forcing OAuth',
    async outcome => {
      if (outcome === 'network failure') fetchMock.mockRejectedValue(new TypeError('Network unavailable'))
      if (outcome === 'unmarked 401')
        fetchMock.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }))
      const { socket } = startTransport('session')
      await socket.resolveQuery()
      const order: string[] = []
      socket.addEventListener('close', event => order.push(`close:${event.code}`))
      socket.addEventListener('error', () => order.push('error'))
      socket.emit('error')
      await settleAsync()
      expect(order).toEqual(['close:1000', 'error'])
      expect(socket.shouldReconnect).toBe(true)
      expect(connectionStatus()).toBe('reconnecting')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/me')
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      expect(headers.get(CIVUP_ACTIVITY_SESSION_HEADER)).toBe('test-activity-session')
      expect(await socket.resolveQuery()).toEqual({
        [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'test-activity-session',
        accessToken: 'room-access-token',
      })
      socket.emit('error')
      await socket.resolveQuery()
      await settleAsync()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(renewSession).not.toHaveBeenCalled()
    },
  )

  test.each(['session', 'overview'] as const)('%s only renews marked upgrade failures', async kind => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          { error: 'Expired Activity session' },
          {
            status: 401,
            headers: { 'X-CivUp-Activity-Session-Rejected': '1' },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json({ userId: 'a1' }))
    const { socket, close, onError } = startTransport(kind)
    await socket.resolveQuery()
    socket.emit('error')
    expect(await socket.resolveQuery()).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'renewed-activity-session-1',
      ...(kind === 'session' ? { accessToken: 'room-access-token' } : {}),
    })
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    socket.emit('error')
    await socket.resolveQuery()
    await settleAsync()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    socket.emit('close', { code: 4401 })
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(renewSession).toHaveBeenCalledTimes(1)
    if (kind === 'overview') expect(onError).toHaveBeenCalledTimes(1)
    close()
  })

  test('a failed marked-401 probe renewal stops retries rather than immediately renewing again', async () => {
    renewSession.mockRejectedValue(new Error('SDK unavailable'))
    fetchMock.mockResolvedValue(
      Response.json(
        { error: 'Expired Activity session' },
        {
          status: 401,
          headers: { 'X-CivUp-Activity-Session-Rejected': '1' },
        },
      ),
    )
    const { socket } = startTransport('session')
    await socket.resolveQuery()
    socket.emit('error')
    expect(await socket.resolveQuery()).toBeNull()
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(connectionStatus()).toBe('error')
    expect(connectionError()).toBe('Reopen the activity to sign in again.')
  })

  test.each(['session', 'overview'] as const)('%s stops after rejected-token renewal fails', async kind => {
    const { socket, close, onError } = startTransport(kind)
    await socket.resolveQuery()
    renewSession.mockRejectedValue(new Error('SDK unavailable'))
    socket.emit('close', { code: 4401 })
    expect(await socket.resolveQuery()).toBeNull()
    await settleAsync()
    for (let i = 0; i < 3; i += 1) {
      socket.emit('error')
      socket.emit('close', { code: 4401 })
    }
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.closeCalls).toHaveLength(1)
    expect(socket.reconnectCalls).toBe(0)
    expect(sockets).toHaveLength(1)
    expect(renewSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    if (kind === 'session') expect(connectionStatus()).toBe('error')
    else expect(onError).toHaveBeenCalledTimes(1)
    close()
  })

  test.each(['session', 'overview'] as const)('%s probes once until authenticated data arrives', async kind => {
    const { socket, close } = startTransport(kind)
    await socket.resolveQuery()
    socket.emit('error')
    await socket.resolveQuery()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    socket.emit('open')
    socket.emit('error')
    await socket.resolveQuery()
    // A transient upgrade does not start another probe/renewal budget.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    socket.emit('open')
    if (kind === 'session') {
      socket.message(initMessage())
    } else {
      socket.emit('message', {
        data: JSON.stringify({ type: 'overview', snapshot: { channelId: 'channel-1', options: [] } }),
      })
    }
    socket.emit('error')
    await socket.resolveQuery()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    socket.emit('error')
    await socket.resolveQuery()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(1)
    expect(socket.reconnectCalls).toBe(0)
    expect(renewSession).not.toHaveBeenCalled()
    close()
  })

  test('a stale draft timer does not replace a socket during failed connection retries', async () => {
    const socket = connect({ timerEndsAt: 11_000 })
    await socket.resolveQuery()
    socket.emit('error')
    await socket.resolveQuery()
    flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connectionStatus()).toBe('reconnecting')
    expect(sockets).toHaveLength(1)
    expect(socket.reconnectCalls).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(renewSession).not.toHaveBeenCalled()
  })

  test('a slow HTTP auth probe times out without blocking retries or forcing renewal', async () => {
    const response = deferred<Response>()
    fetchMock.mockReturnValue(response.promise)
    const { socket } = startTransport('session')
    await socket.resolveQuery()
    socket.emit('error')
    const nextQuery = socket.resolveQuery()
    await settleAsync()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await nextQuery).toEqual({
      [CIVUP_ACTIVITY_SESSION_QUERY_PARAM]: 'test-activity-session',
      accessToken: 'room-access-token',
    })
    expect(signal?.aborted).toBe(true)
    expect(renewSession).not.toHaveBeenCalled()
    socket.emit('error')
    await socket.resolveQuery()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    response.resolve(Response.json({ userId: 'a1' }))
    await settleAsync()
  })

  test.each(['session', 'overview'] as const)('%s cancels probes and ignores late results', async kind => {
    const response = deferred<Response>()
    fetchMock.mockReturnValue(response.promise)
    const { socket, close, onError } = startTransport(kind)
    await socket.resolveQuery()
    socket.emit('error')
    const nextQuery = socket.resolveQuery()
    await settleAsync()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    close()
    expect(signal?.aborted).toBe(true)
    expect(await nextQuery).toBeNull()
    response.resolve(Response.json({ userId: 'a1' }))
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.closeCalls).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    expect(renewSession).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each([
    ['session', 'error'],
    ['session', 'close'],
    ['overview', 'error'],
    ['overview', 'close'],
  ] as const)('%s stops exhausted %s retries', async (kind, event) => {
    const { socket, close, onError } = startTransport(kind)
    const interrupt = () => socket.emit(event, event === 'close' ? { code: 1006 } : {})
    await socket.resolveQuery()
    for (let retry = 1; retry <= 12; retry += 1) {
      interrupt()
      await settleAsync()
      expect(socket.retryCount).toBe(retry)
      expect(socket.shouldReconnect).toBe(true)
      // Retry 12 is already scheduled before close dispatch, not yet exhausted.
      if (kind === 'session') expect(connectionStatus()).toBe('reconnecting')
      expect(await socket.resolveQuery()).not.toBeNull()
    }
    interrupt()
    await settleAsync()
    expect(socket.queryRetryCounts).toEqual(Array.from({ length: 13 }, (_, i) => i))
    expect(socket.retryCount).toBe(12)
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.closeCalls).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(event === 'error' ? 1 : 0)
    expect(renewSession).not.toHaveBeenCalled()
    if (kind === 'session') {
      expect(connectionStatus()).toBe('error')
      expect(connectionError()).toBe('Reopen the activity to reconnect.')
    } else {
      expect(onError).toHaveBeenCalledExactlyOnceWith('Reopen the activity to reconnect.')
    }
    expect(vi.getTimerCount()).toBe(0)
    close()
  })

  test('auth rejection after the final attempt stops the exhausted wrapper without trying to revive it', async () => {
    const { socket } = startTransport('session')
    await socket.resolveQuery()
    for (let retry = 1; retry <= 12; retry += 1) {
      socket.emit('close', { code: 1006 })
      await socket.resolveQuery()
    }
    socket.emit('close', { code: 4401 })
    await settleAsync()
    expect(socket.shouldReconnect).toBe(false)
    expect(socket.reconnectCalls).toBe(0)
    expect(renewSession).not.toHaveBeenCalled()
    expect(connectionStatus()).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('overview room denial is fatal without clearing Activity credentials', async () => {
    const { socket, close, onError } = startTransport('overview')
    await socket.resolveQuery()
    socket.emit('close', { code: 4403 })
    expect(socket.shouldReconnect).toBe(false)
    expect(onError).toHaveBeenCalledExactlyOnceWith('Could not open this activity.')
    expect(getActivitySessionToken()).toBe('test-activity-session')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(renewSession).not.toHaveBeenCalled()
    close()
  })
})

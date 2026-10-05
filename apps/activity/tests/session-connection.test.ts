import type { DraftState } from '@civup/game'
import type { SessionServerMessage } from '@civup/session'
import { createDraft, default2v2, EMPTY_MAP_VOTE_SNAPSHOT } from '@civup/game'
import { createEffect, createRoot, DEV, flush, OBSERVE, snapshot } from 'solid-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'
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
import { draftNow, draftStore, getOptimisticSeatPick, resetDraft, syncDraftServerTime } from '../src/client/stores/draft-store'
import { clearSelections, selectedLeader, setSelectedLeader } from '../src/client/stores/ui-store'

const { sockets, FakePartySocket } = vi.hoisted(() => {
  interface SocketEvent { type: string, data: string, code: number, reason: string }
  const instances: Socket[] = []
  class Socket {
    readonly listeners = new Map<string, ((event: SocketEvent) => void)[]>()
    readonly sent: string[] = []
    readonly closeCalls: { code: number, reason: string }[] = []
    retryCount = 0
    readyState = 0
    shouldReconnect = true
    constructor(readonly options: Record<string, unknown>) { instances.push(this) }
    addEventListener(type: string, listener: (event: SocketEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }
    send(data: string) { this.sent.push(data) }
    close(code = 1000, reason = '') {
      this.shouldReconnect = false
      this.closeCalls.push({ code, reason })
      this.emit('close', { code, reason })
    }
    emit(type: string, event: Partial<SocketEvent> = {}) {
      if (type === 'open') this.readyState = 1
      if (type === 'close') this.readyState = 3
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data: '', code: 0, reason: '', ...event })
    }
    message(message: SessionServerMessage) { this.emit('message', { data: JSON.stringify(message) }) }
  }
  return { sockets: instances, FakePartySocket: Socket }
})

vi.mock('partysocket', () => ({ default: FakePartySocket }))

const target = { host: 'activity.example.com', prefix: 'api/parties' }
type InitMessage = Extract<SessionServerMessage, { type: 'init' }>

function activeState(): DraftState {
  return {
    ...createDraft('match-1', default2v2, [
      { playerId: 'a1', displayName: 'A1', team: 0 },
      { playerId: 'b1', displayName: 'B1', team: 1 },
      { playerId: 'a2', displayName: 'A2', team: 0 },
      { playerId: 'b2', displayName: 'B2', team: 1 },
    ], Array.from({ length: 40 }, (_, i) => `civ-${i + 1}`)),
    status: 'active',
    currentStepIndex: 0,
    steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60 }],
  }
}

function initMessage(overrides: Partial<InitMessage> = {}): InitMessage {
  return {
    type: 'init', state: activeState(), seatIndex: 0, hostId: 'a1',
    serverNow: Date.now(), timerEndsAt: Date.now() + 60_000, completedAt: null,
    mapVote: EMPTY_MAP_VOTE_SNAPSHOT, previews: { bans: {}, picks: {} }, swapState: null,
    ...overrides,
  }
}

function latestSocket() {
  const socket = sockets.at(-1)
  if (!socket) throw new Error('Expected a test socket')
  return socket
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
  configureClientPlatform('discord-embedded', 'token')
  cacheActivitySessionToken('test-activity-session')
})

afterEach(() => {
  disconnect()
  resetDraft()
  clearSelections()
  flush()
  clearActivitySessionToken()
  configureClientPlatform('discord-embedded', 'token')
})

describe('selected session transport', () => {
  test('connects from a split-effect callback using the scheduled clock reset without diagnostics', async () => {
    syncDraftServerTime(100_000, Date.now())
    flush()
    expect(draftNow()).toBe(100_000)
    const capture = OBSERVE?.diagnostics.capture()
    if (!capture) throw new Error('Expected Solid development diagnostics')
    const dispose = createRoot(stop => {
      createEffect(() => 'session-1', sessionId => {
        // ActivityShell transitions reset the draft immediately before connecting.
        resetDraft()
        connectToSession(target, sessionId, null)
      })
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
    }
    finally {
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
    expect(socket.sent.map(value => JSON.parse(value))).toEqual([{ type: 'preview', action: 'pick', civIds: ['civ-3'] }])
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
    second.message({ type: 'session-started', lobbyId: 'lobby-1', matchId: 'match-2', steamLobbyLink: null, sessionAccessToken: null, mode: '2v2' })
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

  test.each([11_000, null])('deduplicates reconnects with map vote deadline %s and the active-step fallback', async endsAt => {
    const message = initMessage({ timerEndsAt: endsAt == null ? 11_000 : null, mapVote: { ...EMPTY_MAP_VOTE_SNAPSHOT, enabled: true, phase: 'voting', endsAt } })
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
  })

  test.each(['complete', 'cancelled'] as const)('a %s update disconnects immediately and leaves the final snapshot', status => {
    const socket = connect()
    flush()
    setSelectedLeader('civ-2')
    socket.message({ ...initMessage({ state: { ...activeState(), status }, completedAt: 12_000 }), type: 'update', events: [] })
    expect(socket.shouldReconnect).toBe(false)
    expect(sendStart()).toBe(false)
    socket.message(initMessage())
    socket.emit('open')
    flush()
    expect(draftStore.state?.status).toBe(status)
    expect(connectionStatus()).toBe('disconnected')
    expect(selectedLeader()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('keeps the socket during the swap window and disconnects at finalization', () => {
    const socket = connect({ state: { ...activeState(), status: 'complete' }, swapState: { completedSwaps: [] } })
    flush()
    expect(connectionStatus()).toBe('connected')
    expect(socket.closeCalls).toEqual([])
    socket.message({ ...initMessage({ state: { ...activeState(), status: 'complete' }, swapState: null }), type: 'update', events: [] })
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
    const pending = sendConfig(120, 150).then(() => 'saved', error => (error as Error).message)
    connectToSession(target, 'session-2', null)
    first.message({ ...initMessage(), type: 'update', events: [] })
    expect(await pending).toBe('The lobby disconnected before the change was confirmed.')
    flush()
    expect(connectionStatus()).toBe('connecting')
    expect(draftStore.state?.matchId).toBe('match-1')
    expect(vi.getTimerCount()).toBe(1)
  })

  test('fatal close stops retries and preserves its error through a synchronous close callback', async () => {
    const socket = connect()
    flush()
    const pending = sendConfig(120, 150).then(() => 'saved', error => (error as Error).message)
    socket.emit('close', { code: 4401, reason: 'expired' })
    flush()
    expect(socket.shouldReconnect).toBe(false)
    expect(connectionStatus()).toBe('error')
    expect(connectionError()).toBe('Activity session expired. Reopen the activity.')
    expect(connectionCloseReason()).toBe('expired')
    expect(await pending).toBe('The lobby disconnected before the change was confirmed.')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a closed overview watcher ignores late responses and disconnect callbacks', () => {
    const onConnected = vi.fn()
    const onStateChanged = vi.fn()
    const onDisconnected = vi.fn()
    const onError = vi.fn()
    const watcher = watchLobbyState(target, { channelId: 'channel-1', userId: 'a1', onConnected, onStateChanged, onDisconnected, onError })
    const socket = latestSocket()
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({ type: 'overview', snapshot: { channelId: 'channel-1', options: [] } }) })
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

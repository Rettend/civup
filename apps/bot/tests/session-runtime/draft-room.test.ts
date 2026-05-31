import type { DraftState } from '@civup/game'
import type { RoomRecord } from '../../src/session-runtime/draft-room-domain.ts'
import type { DraftRuntimeEnv } from '../../src/session-runtime/draft-room.ts'
import { createDraft, draftFormatMap, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { createRoomRecord, ROOM_RECORD_KEY } from '../../src/session-runtime/draft-room-domain.ts'
import { censorDraftStateForSeat, SessionDraftRuntime } from '../../src/session-runtime/draft-room.ts'
import { EMPTY_STORED_MAP_VOTE_STATE } from '../../src/session-runtime/map-vote-room-state.ts'
import { createFakeSessionWebSocket } from '../helpers/session-runtime.ts'

class TestStorage {
  alarm: number | null = null

  constructor(private room: RoomRecord | null) {}

  async get<T>(key: string): Promise<T | undefined> {
    return key === ROOM_RECORD_KEY && this.room ? this.room as T : undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    if (key === ROOM_RECORD_KEY) this.room = value as RoomRecord
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime()
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null
  }
}

class TestSessionDraftRuntime extends SessionDraftRuntime<DraftRuntimeEnv> {
  readonly waitUntilPromises: Promise<unknown>[]

  constructor(storage: TestStorage, env: DraftRuntimeEnv = {}) {
    const waitUntilPromises: Promise<unknown>[] = []
    super({
      storage,
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise)
        void promise.catch(() => {})
      },
      getWebSockets: () => [],
    } as unknown as DurableObjectState, env)
    this.waitUntilPromises = waitUntilPromises
  }

  async runAlarm(now: number): Promise<boolean> {
    return await this.handleDraftRuntimeAlarmIfDue(now)
  }

  async readRoom(): Promise<RoomRecord | null> {
    return await this.getRoomRecord()
  }

  debugActionsEnabledForTest(): boolean {
    return this.debugActiveBotActionsEnabled()
  }

  protected override random(): number {
    return 0
  }
}

describe('draft runtime alarm recovery', () => {
  test('censors blind-pick submissions to opponents but not teammates', () => {
    const state: DraftState = {
      matchId: 'blind-pick-censor-test',
      formatId: 'default-2v2-blind-pick',
      currentStepIndex: 0,
      steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60, blind: true, blindPickRound: 0, fallbackPickOrder: [0, 1, 2, 3] }],
      seats: [
        { playerId: 'a1', displayName: 'A1', team: 0 },
        { playerId: 'b1', displayName: 'B1', team: 1 },
        { playerId: 'a2', displayName: 'A2', team: 0 },
        { playerId: 'b2', displayName: 'B2', team: 1 },
      ],
      submissions: {
        0: ['civ-a1'],
        1: ['civ-b1'],
        2: ['civ-a2'],
      },
      bans: [],
      picks: [],
      availableCivIds: ['civ-a1', 'civ-b1', 'civ-a2', 'civ-b2'],
      status: 'active',
      cancelReason: null,
      pendingBlindBans: [],
    }

    expect(censorDraftStateForSeat(state, 0).submissions).toEqual({
      0: ['civ-a1'],
      1: ['__blind__'],
      2: ['civ-a2'],
    })
    expect(censorDraftStateForSeat(state, 1).submissions).toEqual({
      0: ['__blind__'],
      1: ['civ-b1'],
      2: ['__blind__'],
    })
    expect(censorDraftStateForSeat(state, -1).submissions).toEqual({
      0: ['__blind__'],
      1: ['__blind__'],
      2: ['__blind__'],
    })
  })

  test('debug active bot timers can use the lobby fill debug flag', () => {
    const runtime = new TestSessionDraftRuntime(new TestStorage(null), { ENABLE_DEBUG_LOBBY_FILL: '1' })

    expect(runtime.debugActionsEnabledForTest()).toBe(true)
  })

  test('debug active bot timers require the lobby fill debug flag', async () => {
    const format = draftFormatMap.get('default-1v1')
    expect(format).toBeDefined()
    if (!format) return

    const seats = [
      { playerId: 'p1', displayName: 'Player One' },
      { playerId: 'bot:p2', displayName: 'Debug Bot' },
    ]
    const state = createDraft('debug-bot-match', format, seats, ['civ-1', 'civ-2', 'civ-3', 'civ-4'])
    const room = createRoomRecord({
      matchId: 'debug-bot-match',
      hostId: 'p1',
      formatId: format.id,
      seats,
      civPool: ['civ-1', 'civ-2', 'civ-3', 'civ-4'],
    }, state, EMPTY_STORED_MAP_VOTE_STATE)
    const runtime = new TestSessionDraftRuntime(new TestStorage(room))
    expect(runtime.debugActionsEnabledForTest()).toBe(false)

    const socket = createFakeSessionWebSocket({ id: 'conn-p1', sessionId: 'debug-bot-match', playerId: 'p1', kind: 'draft', connectedAt: 1 })

    await runtime.webSocketMessage(socket.connection, JSON.stringify({ type: 'start' }))

    expect(runtime.waitUntilPromises).toHaveLength(0)
  })

  test('timeout-cancels active drafts when timeout resolution cannot recover the step', async () => {
    const seats = [
      { playerId: 'p1', displayName: 'Player One' },
      { playerId: 'p2', displayName: 'Player Two' },
    ]
    const format = draftFormatMap.get('red-death-1v1')
    expect(format).toBeDefined()
    if (!format) return

    const started = processDraftInput(createDraft('match-red-death-timeout', format, seats, ['civ-1']), { type: 'START' })
    expect(isDraftError(started)).toBe(false)
    if (isDraftError(started)) return

    const state: DraftState = {
      ...started.state,
      availableCivIds: [],
      dealtCivIds: ['civ-1'],
    }
    const room = createRoomRecord({
      matchId: 'match-red-death-timeout',
      hostId: 'p1',
      formatId: 'red-death-1v1',
      seats,
      civPool: ['civ-1'],
    }, state, EMPTY_STORED_MAP_VOTE_STATE, {
      timerEndsAt: 100,
      alarmStepIndex: state.currentStepIndex,
    })
    const storage = new TestStorage(room)
    const runtime = new TestSessionDraftRuntime(storage)
    const errors: unknown[][] = []
    const originalConsoleError = console.error
    const originalConsoleLog = console.log
    console.error = (...args: unknown[]) => { errors.push(args) }
    console.log = () => {}

    try {
      const handled = await runtime.runAlarm(200)
      const nextRoom = await runtime.readRoom()

      expect(handled).toBe(true)
      expect(nextRoom?.state.status).toBe('cancelled')
      expect(nextRoom?.state.cancelReason).toBe('timeout')
      expect(nextRoom?.timerEndsAt).toBeNull()
      expect(nextRoom?.alarmStepIndex).toBe(-1)
      expect(storage.alarm).toBeNull()
      expect(errors.some(args => String(args[0]).includes('timeout resolution failed'))).toBe(true)
    }
    finally {
      console.error = originalConsoleError
      console.log = originalConsoleLog
    }
  })
})

import type { DraftState } from '@civup/game'
import type { DraftRuntimeEnv } from '../../src/session-runtime/draft-room.ts'
import type { RoomRecord } from '../../src/session-runtime/draft-room-domain.ts'
import { createDraft, draftFormatMap, isDraftError, processDraftInput } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { SessionDraftRuntime } from '../../src/session-runtime/draft-room.ts'
import { createRoomRecord, ROOM_RECORD_KEY } from '../../src/session-runtime/draft-room-domain.ts'
import { EMPTY_STORED_MAP_VOTE_STATE } from '../../src/session-runtime/map-vote-room-state.ts'

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
  constructor(storage: TestStorage) {
    super({
      storage,
      waitUntil: (promise: Promise<unknown>) => { void promise },
    } as unknown as DurableObjectState, {} as DraftRuntimeEnv)
  }

  async runAlarm(now: number): Promise<boolean> {
    return await this.handleDraftRuntimeAlarmIfDue(now)
  }

  async readRoom(): Promise<RoomRecord | null> {
    return await this.getRoomRecord()
  }

  protected override random(): number {
    return 0
  }
}

describe('draft runtime alarm recovery', () => {
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

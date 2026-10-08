/** @jsxImportSource @solidjs/web */

import type { DraftState, DraftStep } from '@civup/game'
import type { SessionServerMessage } from '@civup/session'
import { cleanup, within } from '@solidjs/testing-library'
import { flush, snapshot } from 'solid-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EMPTY_MAP_VOTE_SNAPSHOT } from '@civup/game'
import { LeaderGridOverlay } from '../src/client/components/draft/LeaderGridOverlay'
import { PlayerSlot } from '../src/client/components/draft/PlayerSlot'
import { cacheActivitySessionToken, clearActivitySessionToken } from '../src/client/lib/activity-session'
import { configureClientPlatform } from '../src/client/platform/runtime'
import { connectToSession, disconnect } from '../src/client/stores/connection-store'
import { draftStore, getOptimisticSeatPick, resetDraft } from '../src/client/stores/draft-store'
import {
  clearSelections,
  hydratedPickPreviewToken,
  pickSelections,
  selectedLeader,
  setGridExpanded,
  setGridOpen,
  setGridViewMode,
  setHydratedPickPreviewToken,
  setSelectedLeader,
} from '../src/client/stores/ui-store'
import { createActiveDraftState, fireUiEvent as fireEvent, renderUi as render, TEST_LEADER_IDS } from './ui-fixtures'

const { sockets, FakePartySocket } = vi.hoisted(() => {
  interface SocketEvent {
    type: string
    data: string
    code: number
    reason: string
  }
  class Socket {
    readonly listeners = new Map<string, ((event: SocketEvent) => void)[]>()
    readonly sent: string[] = []
    readyState = 0
    shouldReconnect = true
    retryCount = 0

    constructor(_options: unknown) {
      instances.push(this)
    }

    addEventListener(type: string, listener: (event: SocketEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }

    send(data: string) {
      this.sent.push(data)
    }

    emit(type: string, event: Partial<SocketEvent> = {}) {
      if (type === 'open') this.readyState = 1
      if (type === 'close') this.readyState = 3
      for (const listener of this.listeners.get(type) ?? []) listener({ type, data: '', code: 0, reason: '', ...event })
    }

    close() {
      this.shouldReconnect = false
      this.emit('close')
    }

    message(message: SessionServerMessage) {
      this.emit('message', { data: JSON.stringify(message) })
      flush()
    }
  }
  const instances: Socket[] = []
  return { sockets: instances, FakePartySocket: Socket }
})

vi.mock('partysocket', () => ({ default: FakePartySocket }))

type InitMessage = Extract<SessionServerMessage, { type: 'init' }>
const pickStep: DraftStep = { action: 'pick', seats: 'all', count: 1, timer: 60 }
const target = { host: 'activity.example.com', prefix: 'api/parties' }

function initMessage(overrides: Partial<InitMessage> = {}): InitMessage {
  return {
    type: 'init',
    state: createActiveDraftState({ formatId: '2v2', steps: [pickStep] }),
    seatIndex: 0,
    hostId: 'host-1',
    serverNow: Date.now(),
    timerEndsAt: Date.now() + 60_000,
    completedAt: null,
    mapVote: EMPTY_MAP_VOTE_SNAPSHOT,
    previews: { bans: {}, picks: {} },
    swapState: null,
    ...overrides,
  }
}

function connect(overrides: Partial<InitMessage> = {}) {
  connectToSession(target, 'session-1', null)
  const socket = sockets.at(-1)!
  socket.emit('open')
  socket.message(initMessage(overrides))
  return socket
}

function mountDraft() {
  const ownSlot = render(() => <PlayerSlot seatIndex={0} />)
  const overlay = render(() => <LeaderGridOverlay />)
  const clickLeader = (name: string) => fireEvent.click(within(overlay.container).getByAltText(name).closest('button')!)
  return { ownSlot, overlay, clickLeader }
}

function echoPick(socket: InstanceType<typeof FakePartySocket>, civId: string) {
  socket.message({ type: 'preview', previews: { bans: {}, picks: { 0: [civId] } } })
}

function previewImage(container: HTMLElement, name: string) {
  const image = within(container).getByAltText(name)
  expect(image.className).toContain('anim-portrait-in')
  expect(image.className).not.toContain('opacity-0')
  expect(image.parentElement?.className).toContain('opacity-50')
  return image
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true)
  disconnect()
  resetDraft()
  clearSelections()
  setGridOpen(true)
  setGridExpanded(false)
  setGridViewMode('grid')
  flush()
  sockets.length = 0
  configureClientPlatform('discord-embedded', 'token')
  cacheActivitySessionToken('test-activity-session')
})

afterEach(() => {
  cleanup()
  disconnect()
  resetDraft()
  clearSelections()
  flush()
  clearActivitySessionToken()
})

describe('local draft pick previews', () => {
  test.each([false, true])('starts the own preview before the throttle or server echo (blind: %s)', async blind => {
    const socket = connect({ state: createActiveDraftState({ formatId: '2v2', steps: [{ ...pickStep, blind }] }) })
    const { ownSlot, clickLeader } = mountDraft()

    clickLeader('Abraham Lincoln')

    const image = previewImage(ownSlot.container, 'Abraham Lincoln')
    expect(selectedLeader()).toBe(TEST_LEADER_IDS.abrahamLincoln)
    expect(snapshot(draftStore.previews.picks)).toEqual({})
    expect(socket.sent).toEqual([])

    await vi.advanceTimersByTimeAsync(59)
    expect(socket.sent).toEqual([])
    expect(within(ownSlot.container).getByAltText('Abraham Lincoln')).toBe(image)

    await vi.advanceTimersByTimeAsync(1)
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      { type: 'preview', action: 'pick', civIds: [TEST_LEADER_IDS.abrahamLincoln] },
    ])
    echoPick(socket, TEST_LEADER_IDS.abrahamLincoln)
    expect(within(ownSlot.container).getByAltText('Abraham Lincoln')).toBe(image)
  })

  test('keeps a newer local selection when an older server echo arrives', async () => {
    const socket = connect()
    const { ownSlot, overlay, clickLeader } = mountDraft()
    clickLeader('Abraham Lincoln')
    await vi.advanceTimersByTimeAsync(60)
    clickLeader('John Curtin')
    const image = previewImage(ownSlot.container, 'John Curtin')

    echoPick(socket, TEST_LEADER_IDS.abrahamLincoln)

    expect(snapshot(draftStore.previews.picks)).toEqual({ 0: [TEST_LEADER_IDS.abrahamLincoln] })
    expect(pickSelections()).toEqual([TEST_LEADER_IDS.johnCurtin])
    expect(within(ownSlot.container).queryByAltText('Abraham Lincoln')).toBeNull()
    expect(within(ownSlot.container).getByAltText('John Curtin')).toBe(image)
    overlay.unmount()
    render(() => <LeaderGridOverlay />)
    expect(pickSelections()).toEqual([TEST_LEADER_IDS.johnCurtin])
    expect(within(ownSlot.container).getByAltText('John Curtin')).toBe(image)
  })

  test('clears the own preview immediately and does not restore it from a delayed echo or overlay remount', async () => {
    const socket = connect()
    const { ownSlot, overlay, clickLeader } = mountDraft()
    clickLeader('Abraham Lincoln')
    await vi.advanceTimersByTimeAsync(60)
    clickLeader('Abraham Lincoln')

    expect(ownSlot.container.querySelector('img')).toBeNull()
    echoPick(socket, TEST_LEADER_IDS.abrahamLincoln)
    expect(snapshot(draftStore.previews.picks)).toEqual({ 0: [TEST_LEADER_IDS.abrahamLincoln] })
    expect(pickSelections()).toEqual([])
    expect(ownSlot.container.querySelector('img')).toBeNull()

    overlay.unmount()
    render(() => <LeaderGridOverlay />)
    expect(pickSelections()).toEqual([])
    expect(ownSlot.container.querySelector('img')).toBeNull()
    await vi.advanceTimersByTimeAsync(60)
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'preview', action: 'pick', civIds: [] })
  })

  test('hydrates the own selection from a fresh reconnect snapshot', () => {
    const socket = connect({ previews: { bans: {}, picks: { 0: [TEST_LEADER_IDS.abrahamLincoln] } } })
    const { ownSlot, clickLeader } = mountDraft()
    clickLeader('John Curtin')
    previewImage(ownSlot.container, 'John Curtin')

    connectToSession(target, 'session-1', null, { forceReconnect: true })
    const reconnected = sockets.at(-1)!
    reconnected.emit('open')
    reconnected.message(initMessage({ previews: { bans: {}, picks: { 0: [TEST_LEADER_IDS.montezuma] } } }))

    expect(socket.shouldReconnect).toBe(false)
    expect(pickSelections()).toEqual([TEST_LEADER_IDS.montezuma])
    previewImage(ownSlot.container, 'Montezuma')
    expect(within(ownSlot.container).queryByAltText('John Curtin')).toBeNull()
  })

  test.each(['missing', 'previous init', 'previous step'] as const)(
    'uses the server preview while the local hydration context is %s',
    context => {
      connect({ previews: { bans: {}, picks: { 0: [TEST_LEADER_IDS.abrahamLincoln] } } })
      setSelectedLeader(TEST_LEADER_IDS.johnCurtin)
      if (context === 'previous init') setHydratedPickPreviewToken(`${draftStore.initVersion - 1}:0:0`)
      if (context === 'previous step') setHydratedPickPreviewToken(`${draftStore.initVersion}:1:0`)
      flush()

      const { container } = render(() => <PlayerSlot seatIndex={0} />)

      previewImage(container, 'Abraham Lincoln')
      expect(within(container).queryByAltText('John Curtin')).toBeNull()
    },
  )

  test('leaves teammates on server previews and does not populate an opponent slot', () => {
    const socket = connect({ previews: { bans: {}, picks: { 2: [TEST_LEADER_IDS.johnCurtin] } } })
    const teammate = render(() => <PlayerSlot seatIndex={2} />)
    const opponent = render(() => <PlayerSlot seatIndex={1} />)
    const { ownSlot, clickLeader } = mountDraft()

    clickLeader('Abraham Lincoln')

    previewImage(ownSlot.container, 'Abraham Lincoln')
    previewImage(teammate.container, 'John Curtin')
    expect(opponent.container.querySelector('img')).toBeNull()
    expect(socket.sent).toEqual([])
    socket.message({ type: 'preview', previews: { bans: {}, picks: { 2: [TEST_LEADER_IDS.montezuma] } } })
    previewImage(teammate.container, 'Montezuma')
    previewImage(ownSlot.container, 'Abraham Lincoln')
  })

  test('does not use local selections for a captain picking for a teammate', () => {
    connect({
      state: createActiveDraftState({ formatId: '2v2', steps: [{ ...pickStep, seats: [2] }] }),
      previews: { bans: {}, picks: { 0: [TEST_LEADER_IDS.johnCurtin], 2: [TEST_LEADER_IDS.montezuma] } },
    })
    const teammate = render(() => <PlayerSlot seatIndex={2} />)
    const { ownSlot, clickLeader } = mountDraft()

    clickLeader('Abraham Lincoln')

    expect(selectedLeader()).toBe(TEST_LEADER_IDS.abrahamLincoln)
    previewImage(ownSlot.container, 'John Curtin')
    previewImage(teammate.container, 'Montezuma')
  })

  test.each(['spectator', 'reveal', 'CivBlitz'] as const)('does not show a lingering local pick for %s', context => {
    connect({
      seatIndex: context === 'spectator' ? null : 0,
      state: createActiveDraftState({
        formatId: '2v2',
        steps: [{ ...pickStep, reveal: context === 'reveal', civBlitz: context === 'CivBlitz' }],
      }),
    })
    setSelectedLeader(TEST_LEADER_IDS.abrahamLincoln)
    setHydratedPickPreviewToken(`${draftStore.initVersion}:0:0`)
    flush()

    const { container } = render(() => <PlayerSlot seatIndex={0} />)

    expect(container.querySelector('img')).toBeNull()
  })

  test('keeps a confirmed optimistic pick ahead of local and echoed previews', async () => {
    const socket = connect({ previews: { bans: {}, picks: { 0: [TEST_LEADER_IDS.abrahamLincoln] } } })
    const { ownSlot, overlay, clickLeader } = mountDraft()
    clickLeader('John Curtin')
    fireEvent.click(within(overlay.container).getByRole('button', { name: 'Confirm Pick' }))

    expect(getOptimisticSeatPick(0)).toBe(TEST_LEADER_IDS.johnCurtin)
    expect(selectedLeader()).toBeNull()
    expect(hydratedPickPreviewToken()).toBeNull()
    const image = within(ownSlot.container).getByAltText('John Curtin')
    expect(image.parentElement?.className).not.toContain('opacity-50')
    expect(within(ownSlot.container).queryByAltText('Abraham Lincoln')).toBeNull()
    await vi.advanceTimersByTimeAsync(60)
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      { type: 'pick', civId: TEST_LEADER_IDS.johnCurtin },
    ])
    echoPick(socket, TEST_LEADER_IDS.abrahamLincoln)
    expect(selectedLeader()).toBeNull()
    expect(within(ownSlot.container).getByAltText('John Curtin')).toBe(image)
  })

  test.each(['locked', 'revealed', 'visible submission', 'hidden submission'] as const)(
    'keeps %s portraits ahead of the previous local preview',
    status => {
      const socket = connect()
      const { ownSlot, clickLeader } = mountDraft()
      clickLeader('Abraham Lincoln')
      const state = createActiveDraftState({ formatId: '2v2', steps: [{ ...pickStep, blind: true }] })
      if (status === 'locked') state.picks = [{ seatIndex: 0, civId: TEST_LEADER_IDS.johnCurtin, stepIndex: 0 }]
      if (status === 'visible submission') state.submissions = { 0: [TEST_LEADER_IDS.johnCurtin] }
      if (status === 'hidden submission') state.submissions = { 0: ['__blind__'] }
      if (status === 'revealed') {
        state.steps = [{ ...pickStep, reveal: true }]
        state.blindPickReveal = {
          round: 0,
          picks: [{ seatIndex: 0, civId: TEST_LEADER_IDS.johnCurtin, stepIndex: 0 }],
          conflictCivIds: [TEST_LEADER_IDS.johnCurtin],
          conflictedSeatIndexes: [0],
          maxRedrafts: 2,
        }
      }
      socket.message({ ...initMessage({ state }), type: 'update', events: [] })

      expect(within(ownSlot.container).queryByAltText('Abraham Lincoln')).toBeNull()
      expect(pickSelections()).toEqual([])
      if (status === 'hidden submission') {
        expect(ownSlot.container.querySelector('img')).toBeNull()
      } else {
        const image = within(ownSlot.container).getByAltText('John Curtin')
        expect(image.parentElement?.className).not.toContain('opacity-50')
        if (status === 'revealed') expect(image.parentElement?.className).toContain('opacity-80')
      }
    },
  )

  test('prunes a local preview when its leader is no longer available', () => {
    const socket = connect()
    const { ownSlot, clickLeader } = mountDraft()
    clickLeader('Abraham Lincoln')
    const state: DraftState = createActiveDraftState({
      formatId: '2v2',
      steps: [pickStep],
      availableCivIds: [TEST_LEADER_IDS.johnCurtin],
    })
    socket.message({ ...initMessage({ state }), type: 'update', events: [] })

    expect(pickSelections()).toEqual([])
    expect(ownSlot.container.querySelector('img')).toBeNull()
  })
})

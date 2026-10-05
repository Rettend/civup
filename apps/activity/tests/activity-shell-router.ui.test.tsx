import type { ActivityControllerContextValue } from '../src/client/activity/activity-context'
import type {
  ActivityLaunchSelection,
  ActivityLaunchSnapshot,
  ActivityStateChange,
  ActivityTargetOption,
  LobbySnapshot,
  SelectedSessionStateChange,
  SessionSocketTarget,
} from '../src/client/stores'
import type { ActivityIdentity } from '@civup/utils'
import { useNavigate } from '@solidjs/router'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { flush } from 'solid-js'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@civup/utils'
import { useActivityController } from '../src/client/activity/activity-context'
import App, { ActivityRouter } from '../src/client/App'
import { BrowserLaunchValidationError } from '../src/client/platform/browser-platform'

interface OwnedSocket {
  id: string
  closed: boolean
  change?: (change: SelectedSessionStateChange) => void
}

interface OwnedWatch {
  channelId: string
  closed: boolean
  change: (change: ActivityStateChange) => void
}

const mocks = vi.hoisted(() => ({
  discord: vi.fn(),
  browserSession: vi.fn(),
  browserChannel: vi.fn(),
  launch: vi.fn(),
  select: vi.fn(),
  authenticated: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  resetDraft: vi.fn(),
  watch: vi.fn(),
  relayDevLog: vi.fn(),
  sockets: [] as OwnedSocket[],
  watches: [] as OwnedWatch[],
  overviewOptions: [] as ActivityTargetOption[],
  controllers: [] as ActivityControllerContextValue[],
  reset: () => {},
  setConnectionStatus: (_status: string) => {},
  dispose: () => {},
}))

vi.mock('../src/client/stores', async () => {
  const { createRoot, createSignal, createStore } = await import('solid-js')
  return createRoot(dispose => {
    mocks.dispose = dispose
    const [status, setStatus] = createSignal('disconnected')
    const [draftStore, setDraft] = createStore({ state: null, swapState: null })
    mocks.connect.mockImplementation(
      (
        _target: SessionSocketTarget,
        id: string,
        _token: string | null,
        options?: { onStateChanged?: OwnedSocket['change'] },
      ) => {
        for (const socket of mocks.sockets) socket.closed = true
        mocks.sockets.push({ id, closed: false, change: options?.onStateChanged })
        setStatus('connected')
      },
    )
    mocks.disconnect.mockImplementation(() => {
      for (const socket of mocks.sockets) socket.closed = true
      setStatus('disconnected')
    })
    mocks.resetDraft.mockImplementation(() =>
      setDraft(draft => {
        draft.state = null
      }),
    )
    mocks.watch.mockImplementation(
      (_target: SessionSocketTarget, options: { channelId: string; onStateChanged: OwnedWatch['change'] }) => {
        const watch = { channelId: options.channelId, closed: false, change: options.onStateChanged }
        mocks.watches.push(watch)
        queueMicrotask(() => {
          if (watch.closed) return
          watch.change({
            type: 'overview',
            snapshot: {
              channelId: watch.channelId,
              options: mocks.overviewOptions.map(option => ({
                ...option,
                hostId: 'player-1',
                memberPlayerIds: ['player-1'],
              })),
            },
          })
        })
        return {
          close: () => {
            watch.closed = true
          },
        }
      },
    )
    mocks.reset = () => setStatus('disconnected')
    mocks.setConnectionStatus = setStatus
    return {
      connectionStatus: status,
      connectionCloseReason: () => null,
      connectToSession: mocks.connect,
      disconnect: mocks.disconnect,
      draftStore,
      fetchActivityLaunchSnapshot: mocks.launch,
      resetDraft: mocks.resetDraft,
      selectActivityTarget: mocks.select,
      setAuthenticatedUser: mocks.authenticated,
      setIsMiniView: vi.fn(),
      setIsMobileLayout: vi.fn(),
      watchLobbyState: mocks.watch,
    }
  })
})

vi.mock('../src/client/platform/discord-platform', () => ({ bootstrapDiscordPlatform: mocks.discord }))
vi.mock('../src/client/lib/dev-log', () => ({ relayDevLog: mocks.relayDevLog }))
vi.mock('../src/client/platform/browser-platform', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/client/platform/browser-platform')>()),
  bootstrapBrowserSession: mocks.browserSession,
  bootstrapBrowserChannel: mocks.browserChannel,
}))
vi.mock('../src/client/lib/admin-capabilities', () => ({
  NO_ACTIVITY_ADMIN_CAPABILITIES: { autosaveCatalog: false, playerDataExport: false },
  fetchActivityAdminCapabilities: vi.fn(async () => ({ autosaveCatalog: false, playerDataExport: false })),
}))
vi.mock('../src/client/components/ui/UiScaleController', () => ({ UiScaleController: () => null }))
vi.mock('../src/client/pages/draft', () => ({
  DraftPage: (props: { matchId: string; onSwitchTarget?: () => void }) => (
    <Page title={`Draft ${props.matchId}`} onOverview={props.onSwitchTarget} />
  ),
}))
vi.mock('../src/client/pages/draft-setup', () => ({
  DraftSetupPage: (props: {
    lobby?: LobbySnapshot
    onSwitchTarget?: () => void
    onLobbyStarted: (id: string, link: null, token: null) => void
  }) => (
    <Page
      title={`Lobby ${props.lobby?.id}`}
      onOverview={props.onSwitchTarget}
      onStart={() => props.onLobbyStarted('match-1', null, null)}
    />
  ),
}))
vi.mock('../src/client/pages/lobby-overview', () => ({
  LobbyOverviewPage: (props: { onResume?: () => Promise<void>; onPractice: () => void }) => (
    <Page title="Overview" onResume={props.onResume} onPractice={props.onPractice} />
  ),
}))
vi.mock('../src/client/pages/uploads/AutosaveCatalogPage', () => ({ default: () => <Page title="Uploads" /> }))
vi.mock('../src/client/pages/practice/PracticePage', () => ({
  default: () => (
    <main>
      <h1>Practice</h1>
      <a href="/overview" noscroll>
        Embedded overview
      </a>
    </main>
  ),
}))

function Page(props: {
  title: string
  onOverview?: () => void
  onResume?: () => Promise<void>
  onPractice?: () => void
  onStart?: () => void
}) {
  const controller = useActivityController()
  mocks.controllers.push(controller)
  const navigate = useNavigate()
  return (
    <main>
      <h1>{props.title}</h1>
      <button onClick={() => (props.onOverview ?? controller.openOverview)()}>Overview</button>
      <button onClick={() => props.onResume?.()}>Resume</button>
      <button onClick={() => props.onPractice?.()}>Practice</button>
      <button onClick={() => props.onStart?.()}>Start</button>
      <button onClick={() => navigate(-1)}>Back</button>
      <a href="/uploads" noscroll>
        Uploads
      </a>
      <a href="/web/session/session-web" noscroll>
        Browser session
      </a>
      <a href="/overview" noscroll>
        Embedded overview
      </a>
      <a href="/web/session/session-next" noscroll>
        Next session
      </a>
      <a href="/web/channel/channel-1" noscroll>
        Browser overview
      </a>
    </main>
  )
}

const identity: ActivityIdentity = { userId: 'player-1', displayName: 'Player', avatarUrl: null }

function matchSelection(id = 'match-1', lobbyId = 'session-1'): ActivityLaunchSelection & { kind: 'match' } {
  return {
    kind: 'match',
    matchId: id,
    lobbyId,
    mode: 'ffa',
    steamLobbyLink: null,
    sessionAccessToken: null,
    option: {
      kind: 'match',
      id,
      lobbyId,
      matchId: id,
      channelId: 'channel-1',
      mode: 'ffa',
      status: 'drafting',
      participantCount: 2,
      targetSize: 2,
      redDeath: false,
      civBlitz: false,
      isMember: true,
      isHost: true,
      updatedAt: 1,
    },
  }
}

function lobbySelection(): ActivityLaunchSelection & { kind: 'lobby' } {
  const option: ActivityTargetOption = {
    ...matchSelection().option,
    kind: 'lobby',
    id: 'lobby-1',
    lobbyId: 'lobby-1',
    matchId: null,
    status: 'open',
  }
  return {
    kind: 'lobby',
    option,
    pendingJoin: false,
    joinEligibility: { canJoin: true, blockedReason: null, pendingSlot: null },
    lobby: {
      id: 'lobby-1',
      revision: 1,
      mode: 'ffa',
      hostId: 'player-1',
      status: 'open',
      steamLobbyLink: null,
      minRole: null,
      maxRole: null,
      entries: [{ playerId: 'player-1', displayName: 'Player' }, null],
      minPlayers: 2,
      targetSize: 2,
      draftConfig: {
        banTimerSeconds: 60,
        pickTimerSeconds: 60,
        leaderPoolSize: 12,
        leaderDataVersion: 'live',
        mapVoteEnabled: false,
        blindBans: true,
        blindPicks: false,
        simultaneousPick: false,
        permanentAlly: false,
        redDeath: false,
        dealOptionsSize: null,
        civBlitz: false,
        civBlitzOptionCount: null,
        civBlitzExcludeBbgExpanded: true,
        randomDraft: false,
        hiddenDraft: false,
        duplicateFactions: false,
      },
      serverDefaults: { banTimerSeconds: 60, pickTimerSeconds: 60 },
    },
  }
}

function snapshot(selection: ActivityLaunchSelection | null): ActivityLaunchSnapshot {
  return { selection, options: selection ? [selection.option] : [] }
}

function browserSession(selection = matchSelection('match-web', 'session-web')) {
  return {
    identity,
    context: {
      status: 'available',
      sessionId: selection.lobbyId,
      matchId: selection.matchId,
      phase: 'draft',
      selection,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function heading(name: string) {
  await screen.findByRole('heading', { name })
}

let expectedLaunchErrors: unknown[][] = []

beforeEach(() => {
  expectedLaunchErrors = []
  for (const mock of [
    mocks.discord,
    mocks.browserSession,
    mocks.browserChannel,
    mocks.launch,
    mocks.select,
    mocks.authenticated,
    mocks.connect,
    mocks.disconnect,
    mocks.resetDraft,
    mocks.watch,
    mocks.relayDevLog,
  ])
    mock.mockClear()
  mocks.sockets.length = 0
  mocks.watches.length = 0
  mocks.controllers.length = 0
  mocks.overviewOptions = [matchSelection().option]
  mocks.reset()
  flush()
  window.history.replaceState(null, '', '/')
  mocks.discord.mockResolvedValue({ identity, channelId: 'channel-1' })
  mocks.launch.mockResolvedValue(snapshot(matchSelection()))
  mocks.select.mockResolvedValue({ ok: true, snapshot: snapshot(matchSelection()) })
  mocks.browserSession.mockResolvedValue(browserSession())
  mocks.browserChannel.mockResolvedValue({
    identity,
    context: { status: 'available', channelId: 'channel-1', snapshot: snapshot(null) },
  })
  vi.spyOn(console, 'warn')
  vi.spyOn(console, 'error')
})

afterEach(() => {
  cleanup()
  expect(mocks.sockets.every(socket => socket.closed)).toBe(true)
  expect(mocks.watches.every(watch => watch.closed)).toBe(true)
  expect(console.warn).not.toHaveBeenCalled()
  expect(vi.mocked(console.error).mock.calls).toEqual(expectedLaunchErrors)
  expect(mocks.relayDevLog.mock.calls).toEqual(
    expectedLaunchErrors.map(([label, error]) => [
      'error',
      label === 'Browser app setup failed:' ? 'Browser app setup failed' : 'Activity app setup failed',
      error,
    ]),
  )
})

afterAll(() => mocks.dispose())

describe('the rendered Activity router and shell', () => {
  test.each([new Error('SDK implementation details'), 'Unexpected SDK response', null])(
    'shows a launch message instead of arbitrary Discord errors (%s)',
    async error => {
      expectedLaunchErrors.push(['Discord SDK setup failed:', error])
      mocks.discord.mockRejectedValue(error)
      render(() => <App />)
      await screen.findByText('Could not open the activity.')
      expect(screen.queryByText('Unknown error')).toBeNull()
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(mocks.connect).not.toHaveBeenCalled()
    },
  )

  test('instructs a player without a channel to open the activity from Discord', async () => {
    mocks.discord.mockResolvedValue({ identity, channelId: null })
    render(() => <App />)
    await screen.findByText('Open this activity from Discord.')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  test.each([
    new Error('Browser implementation details'),
    'Unexpected browser response',
    new ApiError('Database driver details', 500, { error: 'Database driver details' }),
    new ApiError('Browser access is disabled', 500, { error: 'Browser access is disabled' }),
    new Error('Browser access is disabled'),
  ])('shows a launch message instead of arbitrary browser errors (%s)', async error => {
    window.history.replaceState(null, '', '/web/session/session-web')
    expectedLaunchErrors.push(['Browser app setup failed:', error])
    mocks.browserSession.mockRejectedValue(error)
    render(() => <App />)
    await screen.findByText('Could not open the activity.')
    expect(screen.queryByText(String(error))).toBeNull()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  test.each([
    [503, 'Browser access is disabled'],
    [403, 'This activity is only available in the configured Discord server'],
    [404, 'Session not found'],
  ])('shows deliberate browser validation to the player (%s)', async (status, message) => {
    window.history.replaceState(null, '', '/web/session/session-web')
    const error = new BrowserLaunchValidationError(message, status)
    expectedLaunchErrors.push(['Browser app setup failed:', error])
    mocks.browserSession.mockRejectedValue(error)
    render(() => <App />)
    await screen.findByText(message)
    expect(screen.queryByText('Could not open the activity.')).toBeNull()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  test('keeps the ended-session message without opening a socket', async () => {
    window.history.replaceState(null, '', '/web/session/session-web')
    mocks.browserSession.mockResolvedValue({
      identity,
      context: { status: 'ended', sessionId: 'session-web', matchId: 'match-web', phase: 'cancelled' },
    })
    render(() => <App />)
    await screen.findByText('This session has ended.')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  test('keeps the embedded shell and selected socket across child routes, then disposes for another surface', async () => {
    render(() => <App />)
    await heading('Draft match-1')
    const controller = mocks.controllers.at(-1)
    const selectedSocket = mocks.sockets.at(-1)!
    fireEvent.click(screen.getByRole('link', { name: 'Uploads' }))
    await heading('Uploads')
    expect(window.location.pathname).toBe('/uploads')
    expect(mocks.controllers.at(-1)).toBe(controller)
    expect(selectedSocket.closed).toBe(false)
    expect(mocks.discord).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('link', { name: 'Browser session' }))
    await heading('Draft match-web')
    expect(selectedSocket.closed).toBe(true)
    expect(mocks.controllers.at(-1)).not.toBe(controller)
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['session-web'])
    expect(mocks.browserSession).toHaveBeenCalledTimes(1)
    expect(mocks.resetDraft).toHaveBeenCalled()
  })

  test('keeps one browser shell while replacing selected session sockets', async () => {
    window.history.replaceState(null, '', '/web/session/session-web')
    mocks.browserSession.mockImplementation(async (id: string) => browserSession(matchSelection(`match-${id}`, id)))
    render(() => <App />)
    await heading('Draft match-session-web')
    const controller = mocks.controllers.at(-1)
    const selectedSocket = mocks.sockets.at(-1)!
    fireEvent.click(screen.getByRole('link', { name: 'Next session' }))
    await heading('Draft match-session-next')
    expect(mocks.controllers.at(-1)).toBe(controller)
    expect(selectedSocket.closed).toBe(true)
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['session-next'])
    expect(mocks.discord).not.toHaveBeenCalled()
    selectedSocket.change?.({
      type: 'session-started',
      lobbyId: 'session-web',
      matchId: 'stale-match',
      steamLobbyLink: null,
      sessionAccessToken: null,
      mode: 'ffa',
    })
    flush()
    expect(screen.getByRole('heading').textContent).toBe('Draft match-session-next')
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['session-next'])
  })

  test('keeps a browser session URL stable as the lobby starts its draft', async () => {
    const selection = lobbySelection()
    mocks.browserSession.mockResolvedValue({
      identity,
      context: { status: 'available', sessionId: 'lobby-1', matchId: null, phase: 'open', selection },
    })
    window.history.replaceState(null, '', '/web/session/lobby-1')
    render(() => <App />)
    await heading('Lobby lobby-1')
    expect(mocks.watches).toHaveLength(0)
    const controller = mocks.controllers.at(-1)
    const selectedSocket = mocks.sockets.at(-1)!
    selectedSocket.change?.({
      type: 'session-started',
      lobbyId: 'lobby-1',
      matchId: 'match-1',
      steamLobbyLink: null,
      sessionAccessToken: null,
      mode: 'ffa',
    })
    await heading('Draft match-1')
    expect(window.location.pathname).toBe('/web/session/lobby-1')
    expect(mocks.controllers.at(-1)).toBe(controller)
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['lobby-1'])
  })

  test('returns from browser overview to its session and disposes for practice', async () => {
    window.history.replaceState(null, '', '/web/session/session-web')
    render(() => <App />)
    await heading('Draft match-web')
    const controller = mocks.controllers.at(-1)
    const selectedSocket = mocks.sockets.at(-1)!
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    await heading('Overview')
    expect(window.location.pathname).toBe('/web/channel/channel-1')
    expect(new URLSearchParams(window.location.search).get('returnTo')).toBe('/web/session/session-web')
    expect(mocks.controllers.at(-1)).toBe(controller)
    expect(selectedSocket.closed).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await heading('Draft match-web')
    expect(window.location.pathname).toBe('/web/session/session-web')
    expect(mocks.controllers.at(-1)).toBe(controller)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    await heading('Overview')
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }))
    await heading('Practice')
    expect(new URLSearchParams(window.location.search).get('returnTo')).toBe(
      '/web/channel/channel-1?returnTo=%2Fweb%2Fsession%2Fsession-web',
    )
    expect(mocks.sockets.every(socket => socket.closed)).toBe(true)
    expect(mocks.watches.every(watch => watch.closed)).toBe(true)
  })

  test('preserves overview, browser back, and explicit resume guards', async () => {
    render(() => <App />)
    await heading('Draft match-1')
    const controller = mocks.controllers.at(-1)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    await heading('Overview')
    expect(window.location.pathname).toBe('/overview')
    expect(mocks.sockets.every(socket => socket.closed)).toBe(true)
    expect(mocks.watches.filter(watch => !watch.closed)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(window.location.pathname).toBe('/draft/match-1'))
    await heading('Draft match-1')
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    await heading('Overview')
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await heading('Draft match-1')
    expect(mocks.controllers.at(-1)).toBe(controller)
    expect(mocks.sockets.filter(socket => !socket.closed)).toHaveLength(1)
    expect(mocks.watches.every(watch => watch.closed)).toBe(true)
  })

  test('moves a lobby into its draft without recreating the shell', async () => {
    mocks.launch.mockResolvedValue(snapshot(lobbySelection()))
    mocks.overviewOptions = [lobbySelection().option]
    render(() => <App />)
    await heading('Lobby lobby-1')
    const controller = mocks.controllers.at(-1)
    const watch = mocks.watches.at(-1)!
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await heading('Draft match-1')
    expect(window.location.pathname).toBe('/draft/match-1')
    expect(mocks.controllers.at(-1)).toBe(controller)
    expect(watch.closed).toBe(true)
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['lobby-1'])
  })

  test('rejects a launch response that arrives after practice disposes the embedded shell', async () => {
    const pending = deferred<ActivityLaunchSnapshot>()
    window.history.replaceState(null, '', '/overview')
    mocks.launch.mockResolvedValue(snapshot(null))
    mocks.overviewOptions = []
    render(() => <App />)
    await heading('Overview')
    mocks.launch.mockImplementation(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(2))
    const watch = mocks.watches.at(-1)!
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }))
    await heading('Practice')
    expect(watch.closed).toBe(true)
    const connections = mocks.connect.mock.calls.length
    pending.resolve(snapshot(matchSelection('stale-match')))
    await pending.promise
    flush()
    expect(window.location.pathname).toBe('/practice/great-people')
    expect(mocks.connect).toHaveBeenCalledTimes(connections)
    expect(mocks.sockets.every(socket => socket.closed)).toBe(true)
    watch.change({ type: 'overview', snapshot: { channelId: 'channel-1', options: [] } })
    flush()
    expect(window.location.pathname).toBe('/practice/great-people')
    expect(mocks.connect).toHaveBeenCalledTimes(connections)
  })

  test('rejects a browser refresh overtaken by a newer selected-session update', async () => {
    window.history.replaceState(null, '', '/web/session/session-web')
    render(() => <App />)
    await heading('Draft match-web')
    const pending = deferred<ReturnType<typeof browserSession>>()
    mocks.browserSession.mockImplementation(() => pending.promise)
    mocks.setConnectionStatus('error')
    flush()
    await waitFor(() => expect(mocks.browserSession).toHaveBeenCalledTimes(2))
    mocks.sockets.at(-1)!.change?.({
      type: 'session-started',
      lobbyId: 'session-web',
      matchId: 'match-new',
      steamLobbyLink: null,
      sessionAccessToken: null,
      mode: 'ffa',
    })
    await heading('Draft match-new')
    pending.resolve(browserSession())
    await pending.promise
    flush()
    expect(window.location.pathname).toBe('/web/session/session-web')
    expect(screen.getByRole('heading').textContent).toBe('Draft match-new')
    expect(mocks.connect).toHaveBeenCalledTimes(2)
  })

  test('does not let an old session refresh block refreshing the next session', async () => {
    window.history.replaceState(null, '', '/web/session/session-web')
    render(() => <App />)
    await heading('Draft match-web')
    const pending = deferred<ReturnType<typeof browserSession>>()
    mocks.browserSession.mockImplementation((id: string) =>
      id === 'session-web' ? pending.promise : Promise.resolve(browserSession(matchSelection('match-next', id))),
    )
    mocks.setConnectionStatus('error')
    flush()
    await waitFor(() => expect(mocks.browserSession).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('link', { name: 'Next session' }))
    await heading('Draft match-next')
    mocks.setConnectionStatus('error')
    flush()
    await waitFor(() => expect(mocks.browserSession).toHaveBeenCalledTimes(4))
    pending.resolve(browserSession())
    await pending.promise
    flush()
    expect(window.location.pathname).toBe('/web/session/session-next')
    expect(screen.getByRole('heading').textContent).toBe('Draft match-next')
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['session-next'])
  })

  test.each(['/', '/web/session/session-web'])(
    'closes hidden session sockets and reconnects only while mounted at %s',
    async path => {
      window.history.replaceState(null, '', path)
      const { unmount } = render(() => <App />)
      const name = path === '/' ? 'Draft match-1' : 'Draft match-web'
      await heading(name)
      const selectedSocket = mocks.sockets.at(-1)!
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      flush()
      expect(selectedSocket.closed).toBe(true)
      expect(screen.getByRole('heading').textContent).toBe(name)
      expect(mocks.sockets.every(socket => socket.closed)).toBe(true)
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await waitFor(() => expect(mocks.sockets.filter(socket => !socket.closed)).toHaveLength(1))
      expect(mocks.sockets.at(-1)).not.toBe(selectedSocket)
      unmount()
      const connections = mocks.connect.mock.calls.length
      document.dispatchEvent(new Event('visibilitychange'))
      flush()
      expect(mocks.connect).toHaveBeenCalledTimes(connections)
    },
  )

  test('stops a hidden channel watch, recreates it on return, and ignores its old callbacks', async () => {
    window.history.replaceState(null, '', '/web/channel/channel-1')
    mocks.overviewOptions = []
    const { unmount } = render(() => <App />)
    await heading('Overview')
    await waitFor(() => expect(mocks.watches).toHaveLength(1))
    const initialWatch = mocks.watches[0]!
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    flush()
    expect(initialWatch.closed).toBe(true)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(mocks.watches.filter(watch => !watch.closed)).toHaveLength(1))
    expect(mocks.watches.at(-1)).not.toBe(initialWatch)
    initialWatch.change({ type: 'overview', snapshot: null })
    flush()
    expect(screen.getByRole('heading').textContent).toBe('Overview')
    expect(mocks.sockets).toHaveLength(0)
    unmount()
    const watches = mocks.watches.length
    document.dispatchEvent(new Event('visibilitychange'))
    flush()
    expect(mocks.watches).toHaveLength(watches)
  })

  test('rejects an old browser bootstrap after navigating to another session', async () => {
    const pending = deferred<ReturnType<typeof browserSession>>()
    mocks.browserSession.mockImplementation((id: string) =>
      id === 'session-web' ? pending.promise : Promise.resolve(browserSession(matchSelection('match-next', id))),
    )
    window.history.replaceState(null, '', '/web/session/session-web')
    const { container } = render(() => <App />)
    await waitFor(() => expect(mocks.browserSession).toHaveBeenCalledWith('session-web'))
    const link = document.createElement('a')
    link.href = '/web/session/session-next'
    link.setAttribute('noscroll', '')
    container.appendChild(link)
    fireEvent.click(link, { button: 0 })
    await heading('Draft match-next')
    pending.resolve(browserSession())
    await pending.promise
    flush()
    expect(window.location.pathname).toBe('/web/session/session-next')
    expect(mocks.sockets.filter(socket => !socket.closed).map(socket => socket.id)).toEqual(['session-next'])
    expect(mocks.connect).not.toHaveBeenCalledWith(
      expect.anything(),
      'session-web',
      expect.anything(),
      expect.anything(),
    )
  })

  test('ignores Discord authentication completed after unmount', async () => {
    const pending = deferred<{ identity: ActivityIdentity; channelId: string }>()
    mocks.discord.mockImplementation(() => pending.promise)
    const { unmount } = render(() => <App />)
    await waitFor(() => expect(mocks.discord).toHaveBeenCalled())
    unmount()
    pending.resolve({ identity, channelId: 'channel-1' })
    await pending.promise
    flush()
    expect(mocks.authenticated).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  test('retains the current explicit path, optional practice param, and wildcard patterns', () => {
    const cases = [
      ['/', ''],
      ['/overview', '/overview'],
      ['/uploads', '/uploads'],
      ['/lobby/lobby-1', '/lobby/:lobbyId'],
      ['/draft/match-1', '/draft/:matchId'],
      ['/web/channel/channel-1', '/web/channel/:channelId'],
      ['/web/session/session-1', '/web/session/:sessionId'],
      ['/practice', '/practice'],
      ['/practice/great-people', '/practice/:game'],
    ] as const
    for (const [path, pattern] of cases) expect(ActivityRouter.match(path).at(-1)?.pattern).toBe(pattern)
    expect(ActivityRouter.match('/unknown/path').at(-1)?.pattern).toBe('/*all')
  })

  test('redirects unknown paths into the embedded overview', async () => {
    window.history.replaceState(null, '', '/unknown/path')
    render(() => <App />)
    await heading('Overview')
    expect(window.location.pathname).toBe('/overview')
    expect(mocks.discord).toHaveBeenCalledTimes(1)
    expect(mocks.browserSession).not.toHaveBeenCalled()
  })
})

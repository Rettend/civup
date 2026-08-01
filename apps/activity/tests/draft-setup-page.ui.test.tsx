/** @jsxImportSource solid-js */

import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createJoinEligibility, createLobbySnapshot, createWaitingDraftState } from './ui-fixtures'
import { resetUiMocks, storeSpies, uiMockState } from './ui-mocks'

const { DraftSetupPage } = await import('../src/client/pages/draft-setup')
const { formatRating, formatRecord, formatWinRate } = await import('../src/client/pages/draft-setup/DraftSetupPlayersPanel')

const onLobbyStarted = mock(() => {})

async function selectDropdownOption(label: string, optionLabel: string) {
  const trigger = screen.getByRole('button', { name: label })
  fireEvent.focus(trigger)
  fireEvent.keyDown(trigger.parentElement as HTMLElement, { key: 'Enter' })
  const dropdown = trigger.parentElement as HTMLElement
  const option = Array.from(dropdown.querySelectorAll('button')).find(candidate => candidate.textContent?.includes(optionLabel))
  if (!option) throw new Error(`Missing dropdown option: ${optionLabel}`)
  fireEvent.click(option)
}

function expectTextInOrder(container: HTMLElement, labels: string[]) {
  const text = container.textContent ?? ''
  let previousIndex = -1
  for (const label of labels) {
    const nextIndex = text.indexOf(label)
    expect(nextIndex).toBeGreaterThan(previousIndex)
    previousIndex = nextIndex
  }
}

function hasIconClass(container: HTMLElement, iconClass: string) {
  return Array.from(container.querySelectorAll('span')).some(element => element.className.includes(iconClass))
}

function createLobbySnapshotFromConfigPatch(mode: string, revision: number, patch: Record<string, unknown>) {
  const lobby = createLobbySnapshot({ mode, revision })
  return {
    ...lobby,
    targetSize: typeof patch.targetSize === 'number' ? patch.targetSize : lobby.targetSize,
    draftConfig: {
      ...lobby.draftConfig,
      banTimerSeconds: typeof patch.banTimerSeconds === 'number' || patch.banTimerSeconds === null ? patch.banTimerSeconds : lobby.draftConfig.banTimerSeconds,
      pickTimerSeconds: typeof patch.pickTimerSeconds === 'number' || patch.pickTimerSeconds === null ? patch.pickTimerSeconds : lobby.draftConfig.pickTimerSeconds,
      leaderPoolSize: typeof patch.leaderPoolSize === 'number' || patch.leaderPoolSize === null ? patch.leaderPoolSize : lobby.draftConfig.leaderPoolSize,
      leaderDataVersion: patch.leaderDataVersion === 'beta' || patch.leaderDataVersion === 'live' ? patch.leaderDataVersion : lobby.draftConfig.leaderDataVersion,
      mapVoteEnabled: typeof patch.mapVoteEnabled === 'boolean' ? patch.mapVoteEnabled : lobby.draftConfig.mapVoteEnabled,
      blindBans: typeof patch.blindBans === 'boolean' ? patch.blindBans : lobby.draftConfig.blindBans,
      blindPicks: typeof patch.blindPicks === 'boolean' ? patch.blindPicks : lobby.draftConfig.blindPicks,
      simultaneousPick: typeof patch.simultaneousPick === 'boolean' ? patch.simultaneousPick : lobby.draftConfig.simultaneousPick,
      permanentAlly: typeof patch.permanentAlly === 'boolean' ? patch.permanentAlly : lobby.draftConfig.permanentAlly,
      redDeath: typeof patch.redDeath === 'boolean' ? patch.redDeath : lobby.draftConfig.redDeath,
      dealOptionsSize: typeof patch.dealOptionsSize === 'number' || patch.dealOptionsSize === null ? patch.dealOptionsSize : lobby.draftConfig.dealOptionsSize,
      civBlitz: typeof patch.civBlitz === 'boolean' ? patch.civBlitz : lobby.draftConfig.civBlitz,
      civBlitzOptionCount: typeof patch.civBlitzOptionCount === 'number' || patch.civBlitzOptionCount === null ? patch.civBlitzOptionCount : lobby.draftConfig.civBlitzOptionCount,
      civBlitzExcludeBbgExpanded: typeof patch.civBlitzExcludeBbgExpanded === 'boolean' ? patch.civBlitzExcludeBbgExpanded : lobby.draftConfig.civBlitzExcludeBbgExpanded,
      randomDraft: typeof patch.randomDraft === 'boolean' ? patch.randomDraft : lobby.draftConfig.randomDraft,
      hiddenDraft: typeof patch.hiddenDraft === 'boolean' ? patch.hiddenDraft : lobby.draftConfig.hiddenDraft,
      duplicateFactions: typeof patch.duplicateFactions === 'boolean' ? patch.duplicateFactions : lobby.draftConfig.duplicateFactions,
      closed: typeof patch.closed === 'boolean' ? patch.closed : lobby.draftConfig.closed,
    },
  }
}

function queryUiScaleControl() {
  return document.querySelector('[aria-label="UI Scale"]')
}

describe('DraftSetupPage UI', () => {
  beforeEach(() => {
    resetUiMocks()
    uiMockState.draftState = createWaitingDraftState()
    onLobbyStarted.mockClear()
  })

  test('shows the host open-lobby flow with start and cancel affordances', () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
        ],
      })}
      />
    ))

    expect(screen.getByRole('heading', { name: 'Draft Setup' })).toBeTruthy()
    expect(screen.getByText('Players')).toBeTruthy()
    expect(screen.getByText('Config')).toBeTruthy()
    expect(queryUiScaleControl()).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start Draft' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Cancel Lobby' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: /Game settings/ })).toBeTruthy()
  })

  test('shows accessible source server icons only for mixed-server rosters', () => {
    const singleGuildLobby = createLobbySnapshot({
      entries: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null, sourceGuild: { id: '111111111111111111', name: 'Server Alpha', iconUrl: 'https://cdn.discordapp.com/alpha.png' } },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, sourceGuild: { id: '111111111111111111', name: 'Server Alpha', iconUrl: 'https://cdn.discordapp.com/alpha.png' } },
        null,
        null,
      ],
    })
    const view = render(() => <DraftSetupPage lobby={singleGuildLobby} />)
    expect(screen.queryByRole('img', { name: 'Server Alpha' })).toBeNull()
    view.unmount()

    render(() => <DraftSetupPage lobby={createLobbySnapshot({
      entries: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null, sourceGuild: { id: '111111111111111111', name: 'Server Alpha', iconUrl: 'https://cdn.discordapp.com/alpha.png' } },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, sourceGuild: { id: '222222222222222222', name: 'Server Beta', iconUrl: null } },
        null,
        null,
      ],
    })}
    />)
    expect(screen.getByRole('img', { name: 'Server Alpha' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Server Beta' })).toBeTruthy()
  })

  test('shows lobby access as an open-by-default config switch', async () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
        ],
      })}
      />
    ))

    const configCard = screen.getByText('Config').closest('.bg-bg-subtle') as HTMLElement
    const accessSwitch = screen.getByRole('switch', { name: 'Lobby Open' })

    expectTextInOrder(configCard, ['Lobby Open', 'Map Vote'])
    expect(accessSwitch.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Close Lobby' })).toBeNull()

    fireEvent.click(accessSwitch)

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([mode, lobbyId, userId, patch]) => mode === '2v2' && lobbyId === 'lobby-1' && userId === 'host-1' && patch.closed === true)).toBe(true))

    cleanup()
    storeSpies.updateLobbyConfig.mockClear()

    const closedLobby = createLobbySnapshot()
    render(() => (
      <DraftSetupPage lobby={{
        ...closedLobby,
        draftConfig: { ...closedLobby.draftConfig, closed: true },
      }} />
    ))

    const closedSwitch = screen.getByRole('switch', { name: 'Lobby Closed' })
    const closedTrack = closedSwitch.querySelector('div') as HTMLElement

    expect(closedSwitch.getAttribute('aria-checked')).toBe('false')
    expect(closedTrack.className).toContain('bg-[#a78bfa]/18')

    fireEvent.click(closedSwitch)

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([mode, lobbyId, userId, patch]) => mode === 'ffa' && lobbyId === 'lobby-1' && userId === 'host-1' && patch.closed === false)).toBe(true))
  })

  test('does not show a manual first-pick control in 1v1 lobbies', () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '1v1',
        targetSize: 2,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
        ],
      })}
      />
    ))

    expect(screen.queryByRole('button', { name: 'Randomize First Pick' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Shuffle teams' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Start Draft' })).toBeTruthy()
  })

  test('uses a constrained desktop shell so the action row stays in view', () => {
    const { container } = render(() => <DraftSetupPage lobby={createLobbySnapshot({ mode: '2v2' })} />)

    const shell = container.firstElementChild as HTMLElement
    const content = shell.querySelector('.mx-auto') as HTMLElement
    const grid = content.querySelector('.grid') as HTMLElement
    const actions = content.lastElementChild as HTMLElement
    const playersCard = screen.getByText('Players').closest('.bg-bg-subtle') as HTMLElement
    const configCard = screen.getByText('Config').closest('.bg-bg-subtle') as HTMLElement

    expect(shell.className).toContain('flex')
    expect(shell.className).toContain('flex-col')
    expect(shell.className).toContain('draft-setup-shell')
    expect(shell.className).toContain('lg:h-[var(--civup-scaled-viewport-height,100dvh)]')
    expect(shell.className).toContain('lg:min-h-0')
    expect(content.className).toContain('flex-1')
    expect(content.className).toContain('min-h-0')
    expect(content.className).toContain('lg:overflow-hidden')
    expect(content.className.includes('lg:h-dvh')).toBe(false)
    expect(grid.className.includes('lg:flex-1')).toBe(false)
    expect(grid.className).toContain('lg:min-h-0')
    expect(grid.className).toContain('lg:overflow-hidden')
    expect(grid.className).toContain('lg:max-h-[432px]')
    expect(actions.className).toContain('lg:mt-auto')
    expect(playersCard.className).toContain('lg:h-full')
    expect(configCard.className).toContain('lg:h-full')
  })

  test('shows host not-ready team lobby state when more players are required', () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        minPlayers: 4,
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          null,
          null,
          null,
        ],
      })}
      />
    ))

    expect(screen.getByText('Team A')).toBeTruthy()
    expect(screen.getByText('Team B')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start Draft' }).hasAttribute('disabled')).toBe(true)
  })

  test('shows the last used arrange action with the matching icon', () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        lastArrange: { strategy: 'shuffle-teams', at: 123 },
      })}
      />
    ))

    const shuffleIndicator = screen.getByTitle('Teams shuffled') as HTMLElement
    expect(shuffleIndicator).toBeTruthy()
    expect(shuffleIndicator.getAttribute('aria-label')).toBe('Last used: Teams shuffled')
    expect(shuffleIndicator.textContent).toBe('Last used:')
    expect(hasIconClass(shuffleIndicator, 'i-ph:arrows-clockwise-bold')).toBe(true)

    cleanup()
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        lastArrange: { strategy: 'balance', at: 124 },
      })}
      />
    ))

    const balanceIndicator = screen.getByTitle('Teams balanced') as HTMLElement
    expect(balanceIndicator).toBeTruthy()
    expect(balanceIndicator.getAttribute('aria-label')).toBe('Last used: Teams balanced')
    expect(balanceIndicator.textContent).toBe('Last used:')
    expect(hasIconClass(balanceIndicator, 'i-ph:scales-bold')).toBe(true)
  })

  test('shows a joined player waiting for the host and able to leave the lobby', () => {
    uiMockState.userId = 'player-2'
    uiMockState.displayName = 'Player 2'
    uiMockState.draftHostId = 'host-1'

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    expect(screen.getByText('Waiting for host')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave Lobby' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Join Lobby' })).toBeNull()
  })

  test('shows spectator join-pending and blocked-join states', () => {
    uiMockState.userId = 'spectator-1'
    uiMockState.displayName = 'Spectator'

    render(() => (
      <DraftSetupPage
        lobby={createLobbySnapshot()}
        showJoinPending
        joinEligibility={createJoinEligibility({ pendingSlot: 2 })}
      />
    ))

    const pendingJoinButton = screen.getByRole('button', { name: 'Join Lobby' })
    expect(pendingJoinButton.hasAttribute('disabled')).toBe(true)
    expect(pendingJoinButton.getAttribute('title')).toBe('Joining lobby...')

    cleanup()
    render(() => (
      <DraftSetupPage
        lobby={createLobbySnapshot()}
        joinEligibility={createJoinEligibility({ canJoin: false, blockedReason: 'You are already in another open lobby.', pendingSlot: null })}
      />
    ))

    const blockedJoinButton = screen.getByRole('button', { name: 'Join Lobby' })
    expect(blockedJoinButton.hasAttribute('disabled')).toBe(true)
    expect(blockedJoinButton.getAttribute('title')).toBe('You are already in another open lobby.')
    expect(screen.getByText('Spectating')).toBeTruthy()
  })

  test('shows a spectator who can join or leave through lobby affordances', () => {
    uiMockState.userId = 'spectator-1'
    uiMockState.displayName = 'Spectator'

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} joinEligibility={createJoinEligibility()} />)

    expect(screen.getByRole('button', { name: 'Join Lobby' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByText('Spectating')).toBeTruthy()
  })

  test('renders the mini setup shell for compact future page flows', () => {
    uiMockState.isMiniView = true

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    expect(screen.getByText('Draft Setup')).toBeTruthy()
    expect(screen.getByText('2/4')).toBeTruthy()
  })

  test('keeps mixed-server identity visible in the compact setup shell', () => {
    uiMockState.isMiniView = true
    render(() => <DraftSetupPage lobby={createLobbySnapshot({
      entries: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null, sourceGuild: { id: '111111111111111111', name: 'Server Alpha', iconUrl: 'https://cdn.discordapp.com/alpha.png' } },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, sourceGuild: { id: '222222222222222222', name: 'Server Beta', iconUrl: null } },
        null,
        null,
      ],
    })}
    />)

    expect(screen.getByRole('img', { name: 'Server Alpha' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Server Beta' })).toBeTruthy()
  })

  test('lets the host update real config toggles and numeric fields in a 2v2 lobby', async () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
        ],
      })}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Ban Draft' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Captain Pick' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Random draft' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Duplicate leaders' }))

    const leadersInput = screen.getByRole('spinbutton', { name: 'Leaders' })
    fireEvent.input(leadersInput, { target: { value: '12' } })
    fireEvent.blur(leadersInput)

    const banInput = screen.getByRole('spinbutton', { name: 'Ban Timer (minutes)' })
    fireEvent.input(banInput, { target: { value: '2' } })
    fireEvent.blur(banInput)

    const pickInput = screen.getByRole('spinbutton', { name: 'Pick Timer (minutes)' })
    fireEvent.input(pickInput, { target: { value: '3' } })
    fireEvent.blur(pickInput)

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.length).toBeGreaterThanOrEqual(7))

    const patches = storeSpies.updateLobbyConfig.mock.calls.map(call => call[3] as Record<string, unknown>)
    expect(patches.some(patch => patch.blindBans === false)).toBe(true)
    expect(patches.some(patch => patch.teamFormationEnabled === true)).toBe(true)
    expect(patches.some(patch => patch.randomDraft === true)).toBe(true)
    expect(patches.some(patch => patch.duplicateFactions === true)).toBe(true)
    expect(patches.some(patch => patch.leaderPoolSize === 12)).toBe(true)
    expect(patches.some(patch => patch.banTimerSeconds === 120)).toBe(true)
    expect(patches.some(patch => patch.pickTimerSeconds === 180)).toBe(true)

    cleanup()
    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Red Death' }))

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => (patch as Record<string, unknown>).redDeath === true && patch.targetSize === 10)).toBe(true))
  })

  test('shows captains and an unassigned pool when Captain Pick is enabled', () => {
    const lobby = createLobbySnapshot({ mode: '2v2', targetSize: 4 })
    render(() => <DraftSetupPage lobby={{
      ...lobby,
      draftConfig: { ...lobby.draftConfig, teamFormationEnabled: true },
      entries: [
        { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
        { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
        { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
      ],
    }} />)

    expect(screen.getByText('Captains')).toBeTruthy()
    expect(screen.getByText('Unassigned players')).toBeTruthy()
    expect(screen.getByText('Team A captain')).toBeTruthy()
    expect(screen.getByText('Team B captain')).toBeTruthy()
  })

  test('hides invalid ban and pick config while hidden draft is on', () => {
    const hiddenLobby = createLobbySnapshot({
      draftConfig: {
        ...createLobbySnapshot().draftConfig,
        hiddenDraft: true,
      },
    })

    render(() => <DraftSetupPage lobby={hiddenLobby} />)

    expect(screen.getByRole('switch', { name: 'Hidden draft' })).toBeTruthy()
    expect(screen.getByText('Map Vote')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ban Blind' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ban Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pick Blind' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pick Draft' })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: 'Leaders' })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: 'Ban Timer (minutes)' })).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: 'Pick Timer (minutes)' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Random draft' })).toBeNull()

    cleanup()
    uiMockState.userId = 'player-2'
    uiMockState.displayName = 'Player 2'

    render(() => <DraftSetupPage lobby={hiddenLobby} />)

    const configCard = screen.getByText('Config').closest('.bg-bg-subtle') as HTMLElement
    expect(configCard.textContent).toContain('Hidden draft')
    expect(configCard.textContent).toContain('Map Vote')
    expect(configCard.textContent).not.toContain('Ban Timer')
    expect(configCard.textContent).not.toContain('Pick Timer')
    expect(configCard.textContent).not.toContain('Random draft')
    expect(configCard.textContent).not.toContain('Leaders')
  })

  test('renders CivBlitz setup options without the BBG Beta row', async () => {
    const lobby = createLobbySnapshot({ mode: '2v2', targetSize: 4 })
    render(() => (
      <DraftSetupPage lobby={{
        ...lobby,
        draftConfig: { ...lobby.draftConfig, civBlitz: true },
      }} />
    ))

    const configCard = screen.getByText('Config').closest('.bg-bg-subtle') as HTMLElement
    const civBlitzSwitch = screen.getByRole('switch', { name: 'CivBlitz' })
    const bbgExpandedSwitch = screen.getByRole('switch', { name: 'BBG Expanded' })
    const bbgExpandedLabel = screen.getByText('BBG Expanded')
    const civBlitzTrack = civBlitzSwitch.querySelector('div') as HTMLElement
    const bbgExpandedTrack = bbgExpandedSwitch.querySelector('div') as HTMLElement

    expect(screen.getByText('CivBlitz 2v2')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'BBG Beta' })).toBeNull()
    expectTextInOrder(configCard, ['Map Vote', 'BBG Expanded', 'Game Mode'])
    expectTextInOrder(configCard, ['CivBlitz', 'Red Death'])
    expect(civBlitzSwitch.getAttribute('aria-checked')).toBe('true')
    expect(bbgExpandedSwitch.getAttribute('aria-checked')).toBe('false')
    expect(civBlitzTrack.className).toContain('bg-cyan-300/18')
    expect(bbgExpandedLabel.className).not.toContain('cyan')
    expect(bbgExpandedTrack.className).not.toContain('cyan')

    fireEvent.click(bbgExpandedSwitch)

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => (patch as Record<string, unknown>).civBlitzExcludeBbgExpanded === false)).toBe(true))

  })

  test('queues overlapping optimistic config saves with the latest switch state', async () => {
    let resolveFirstSave: () => void = () => {}
    const firstSave = new Promise<void>((resolve) => { resolveFirstSave = resolve })
    let callIndex = 0

    storeSpies.updateLobbyConfig.mockImplementation(async (mode, _lobbyId, _userId, patch) => {
      callIndex += 1
      if (callIndex === 1) await firstSave
      return { ok: true, lobby: createLobbySnapshotFromConfigPatch(mode, callIndex + 1, patch) }
    })

    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
        ],
      })}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Ban Draft' }))
    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.length).toBe(1))

    const randomDraftSwitch = screen.getByRole('switch', { name: 'Random draft' })
    expect(randomDraftSwitch.hasAttribute('disabled')).toBe(false)

    fireEvent.click(randomDraftSwitch)
    await Promise.resolve()

    expect(storeSpies.updateLobbyConfig.mock.calls.length).toBe(1)

    resolveFirstSave()

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.length).toBe(2))

    const patches = storeSpies.updateLobbyConfig.mock.calls.map(call => call[3] as Record<string, unknown>)
    const firstPatch = patches[0]!
    const secondPatch = patches[1]!
    expect(firstPatch.blindBans).toBe(false)
    expect(secondPatch.blindBans).toBe(false)
    expect(secondPatch.randomDraft).toBe(true)
    expect(randomDraftSwitch.hasAttribute('disabled')).toBe(false)
  })

  test('keeps a refocused timer input active when an older blur save finishes', async () => {
    let resolveSave: () => void = () => {}
    const save = new Promise<void>((resolve) => { resolveSave = resolve })

    storeSpies.updateLobbyConfig.mockImplementation(async (mode, _lobbyId, _userId, patch) => {
      await save
      return { ok: true, lobby: createLobbySnapshotFromConfigPatch(mode, 2, patch) }
    })

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    const banInput = screen.getByRole('spinbutton', { name: 'Ban Timer (minutes)' }) as HTMLInputElement

    banInput.focus()
    fireEvent.focus(banInput)
    fireEvent.input(banInput, { target: { value: '2' } })
    fireEvent.blur(banInput)

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.length).toBe(1))

    banInput.focus()
    fireEvent.focus(banInput)
    fireEvent.input(banInput, { target: { value: '2.5' } })

    resolveSave()

    await waitFor(() => expect((document.activeElement as HTMLInputElement | null)?.value).toBe('2.5'))
    expect(document.activeElement).toBe(banInput)
  })

  test('covers the host 2v2 extra-team toggle flow', async () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 4,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
        ],
      })}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Add two extra teams' }))

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => patch.targetSize === 8)).toBe(true))
  })

  test('covers the host FFA extra-seat toggle flow', async () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: 'ffa',
        targetSize: 8,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      })}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Add more seats' }))

    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => patch.targetSize === 12)).toBe(true))
  })

  test('covers ranked host dropdown flows with fetched matchmaking roles', async () => {
    uiMockState.fetchLobbyRankedRolesResult = {
      options: [
        { tier: 'bronze', rank: 1, roleId: 'bronze', label: 'Bronze', color: '#cd7f32' },
        { tier: 'gold', rank: 2, roleId: 'gold', label: 'Gold', color: '#facc15' },
        { tier: 'platinum', rank: 3, roleId: 'platinum', label: 'Platinum', color: '#67e8f9' },
      ],
    }

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    await selectDropdownOption('Game Mode', '3v3')
    await waitFor(() => expect(storeSpies.updateLobbyMode).toHaveBeenCalledWith('ffa', 'lobby-1', 'host-1', '3v3'))

    cleanup()
    render(() => <DraftSetupPage lobby={createLobbySnapshot()} prefetchedRankedRoleOptions={uiMockState.fetchLobbyRankedRolesResult?.options ?? []} />)

    await selectDropdownOption('Minimum matchmaking rank', 'Gold')
    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => patch.minRole === 'gold' && patch.maxRole === null)).toBe(true))
    await waitFor(() => expect(storeSpies.fetchLobbyRankedRoles).toHaveBeenCalledWith('ffa', 'lobby-1'))
    expect(screen.getAllByText('Gold').length).toBeGreaterThan(0)

    cleanup()
    render(() => <DraftSetupPage lobby={createLobbySnapshot()} prefetchedRankedRoleOptions={uiMockState.fetchLobbyRankedRolesResult?.options ?? []} />)

    await selectDropdownOption('Maximum matchmaking rank', 'Bronze')
    await waitFor(() => expect(storeSpies.updateLobbyConfig.mock.calls.some(([, , , patch]) => patch.minRole === null && patch.maxRole === 'bronze')).toBe(true))
  })

  test('shows fill-test-players availability and action feedback for hosts', async () => {
    uiMockState.canFillLobbyWithTestPlayersResult = true
    uiMockState.fillLobbyWithTestPlayersResult = { ok: true, addedCount: 2 }

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} prefetchedFillTestPlayersAvailable />)

    const fillButton = await screen.findByRole('button', { name: 'Fill Test Players' })
    fireEvent.click(fillButton)

    await waitFor(() => expect(storeSpies.fillLobbyWithTestPlayers).toHaveBeenCalledWith('ffa', 'lobby-1', 'host-1'))
  })

  test('lets non-host users join and leave the lobby through page actions', async () => {
    uiMockState.userId = 'spectator-1'
    uiMockState.displayName = 'Spectator'

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} joinEligibility={createJoinEligibility({ pendingSlot: 2 })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Join Lobby' }))
    await waitFor(() => expect(storeSpies.placeLobbySlot).toHaveBeenCalledWith('ffa', {
      lobbyId: 'lobby-1',
      userId: 'spectator-1',
      targetSlot: 2,
      displayName: 'Spectator',
      avatarUrl: null,
    }))

    cleanup()
    uiMockState.userId = 'player-2'
    uiMockState.displayName = 'Player 2'

    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Leave Lobby' }))
    await waitFor(() => expect(storeSpies.removeLobbySlot).toHaveBeenCalledWith('ffa', {
      lobbyId: 'lobby-1',
      userId: 'player-2',
      slot: 1,
    }))
  })

  test('drops a dragged player when hovering the realistic chip surface', async () => {
    render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)

    const draggedChip = screen.getByText('Player 2').closest('[data-slot="1"]') as HTMLElement
    const emptyChip = screen.getAllByText('[empty]')[0]!.closest('[data-slot="2"]') as HTMLElement
    const emptyLabel = emptyChip.querySelector('span') as HTMLElement
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: () => {},
      getData: () => 'player-2',
    }

    fireEvent.dragStart(draggedChip, { dataTransfer })
    fireEvent.dragOver(emptyChip, { dataTransfer })

    fireEvent.drop(emptyLabel, { dataTransfer })

    await waitFor(() => expect(storeSpies.placeLobbySlot).toHaveBeenCalledWith('ffa', {
      lobbyId: 'lobby-1',
      userId: 'host-1',
      targetSlot: 2,
      playerId: 'player-2',
      displayName: 'Host Player',
      avatarUrl: null,
    }))
  })

  test('keeps occupied-seat dragging on the row while leaving nested content interactive', async () => {
    const { container } = render(() => <DraftSetupPage lobby={createLobbySnapshot()} />)
    const arrangeOverlay = container.querySelector('[aria-hidden]') as HTMLElement

    const hostChip = screen.getByText('Host Player').closest('[data-slot="0"]') as HTMLElement
    const playerChip = screen.getByText('Player 2').closest('[data-slot="1"]') as HTMLElement
    const hostBadge = screen.getByText('Host')
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: () => {},
      getData: () => 'player-2',
    }

    fireEvent.dragStart(playerChip, { dataTransfer })
    fireEvent.dragEnter(hostChip, { dataTransfer })
    fireEvent.dragOver(hostChip, { dataTransfer })
    fireEvent.drop(hostBadge, { dataTransfer })

    await waitFor(() => expect(storeSpies.placeLobbySlot).toHaveBeenCalledWith('ffa', {
      lobbyId: 'lobby-1',
      userId: 'host-1',
      targetSlot: 0,
      playerId: 'player-2',
      displayName: 'Host Player',
      avatarUrl: null,
    }))

    expect(hostBadge.className).toContain('text-[10px]')
    expect(arrangeOverlay.className).toContain('pointer-events-none')
  })

  test('formats missing player popover stats as default baseline values', () => {
    expect(formatRating(null)).toBe('1000')
    expect(formatRating(null, true)).toBe('Unranked')
    expect(formatRecord(null)).toBe('0-0')
    expect(formatWinRate(null)).toBe('0%')
  })

  test('blocks removing extra 2v2 teams while Teams C and D are occupied', () => {
    render(() => (
      <DraftSetupPage lobby={createLobbySnapshot({
        mode: '2v2',
        targetSize: 8,
        entries: [
          { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
          { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
          { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
          { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
          { playerId: 'player-5', displayName: 'Player 5', avatarUrl: null },
          { playerId: 'player-6', displayName: 'Player 6', avatarUrl: null },
          null,
          null,
        ],
      })}
      />
    ))

    const removeExtraTeamsButton = screen.getByRole('button', { name: 'Remove extra teams' })
    expect(removeExtraTeamsButton.hasAttribute('disabled')).toBe(true)
    expect(removeExtraTeamsButton.getAttribute('title')).toBe('Clear Teams C and D before removing them.')
  })

  test('covers host lobby actions and non-host read-only config states through the page shell', async () => {
    render(() => (
      <DraftSetupPage
        lobby={createLobbySnapshot({
          mode: '2v2',
          targetSize: 4,
          entries: [
            { playerId: 'host-1', displayName: 'Host Player', avatarUrl: null },
            { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null },
            { playerId: 'player-3', displayName: 'Player 3', avatarUrl: null },
            { playerId: 'player-4', displayName: 'Player 4', avatarUrl: null },
          ],
        })}
        onLobbyStarted={onLobbyStarted}
      />
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Shuffle players' }))
    await waitFor(() => expect(storeSpies.arrangeLobbySlots).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1', 'randomize'))

    expect(screen.queryByRole('button', { name: 'Shuffle teams' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Auto-balance teams' }))
    await waitFor(() => expect(storeSpies.arrangeLobbySlots).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1', 'balance'))

    fireEvent.click(screen.getByRole('button', { name: 'Start Draft' }))
    await waitFor(() => expect(storeSpies.startLobbyDraft).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1'))
    expect(onLobbyStarted).toHaveBeenCalledWith('match-1', 'steam://joinlobby/289070/example', 'session-token')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Lobby' }))
    await waitFor(() => expect(storeSpies.cancelLobby).toHaveBeenCalledWith('2v2', 'lobby-1', 'host-1'))

    cleanup()
    uiMockState.userId = 'player-2'
    uiMockState.displayName = 'Player 2'

    render(() => <DraftSetupPage lobby={createLobbySnapshot({ mode: '2v2' })} />)

    expect(screen.getByText('Waiting for host')).toBeTruthy()
    const readonlyLobbyAccess = screen.getByText('Lobby Open') as HTMLElement
    expect(readonlyLobbyAccess.className).toContain('text-note')
    expect(screen.queryByRole('switch', { name: 'Lobby Open' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Blind Bans' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ban Draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start Draft' })).toBeNull()
    expect(screen.getByText('Pick')).toBeTruthy()
    expect(screen.getByText('Ban')).toBeTruthy()
    expect(screen.getByText('Map Vote')).toBeTruthy()
    expect(screen.getByText('Random draft')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Leave Lobby' })).toBeTruthy()

    const configCard = screen.getByText('Config').closest('.bg-bg-subtle') as HTMLElement
    expectTextInOrder(configCard, [
      'Lobby Open',
      'Ban',
      'Pick',
      'Map Vote',
      'Min rank',
      'Max rank',
      'Leaders',
      'Ban Timer',
      'Pick Timer',
      'Random draft',
      'Hidden draft',
      'Duplicate leaders',
    ])
    expect((screen.getByText('BLIND') as HTMLElement).className).toContain('text-accent')
    expect((screen.getByText('DRAFT') as HTMLElement).className).toContain('text-accent')
    expect(configCard.textContent?.includes('Game Mode')).toBe(false)
    expect(configCard.textContent?.includes('Red Death')).toBe(false)
  })
})

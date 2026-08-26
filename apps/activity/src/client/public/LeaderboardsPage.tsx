import type {
  PublicCivLeaderboardMetric,
  PublicCivLeaderboardScope,
  PublicLeaderboardResponse,
  PublicPlayerLeaderboardBoard,
  PublicPlayerLeaderboardMode,
} from '@civup/utils'
import {
  isPublicLeaderboardResponse,
  PUBLIC_CIV_LEADERBOARD_METRICS,
  PUBLIC_CIV_LEADERBOARD_SCOPES,
  PUBLIC_PLAYER_LEADERBOARD_MODES,
  sortPublicCivLeaderboardRows,
} from '@civup/utils'
import { createMemo, createSignal, For, Show } from 'solid-js'
import type { JSX } from 'solid-js'

type LeaderboardTab = 'players' | 'civilizations'
type LoadState = 'loading' | 'ready' | 'error'

const PLAYER_MODE_LABELS: Record<PublicPlayerLeaderboardMode, string> = {
  duel: 'Duel',
  duo: 'Duo',
  squad: 'Squad',
  ffa: 'FFA',
  'red-death': 'Red Death',
}

const CIV_SCOPE_LABELS: Record<PublicCivLeaderboardScope, string> = {
  all: 'All modes',
  duel: 'Duel',
  duo: 'Duo',
  squad: 'Squad',
}

const CIV_METRIC_LABELS: Record<PublicCivLeaderboardMetric, string> = {
  picked: 'Picked',
  winrate: 'Win rate',
  banned: 'Banned',
}

export default function LeaderboardsPage() {
  const memoizedPayloads = new Map<string, PublicLeaderboardResponse>()
  const [loadState, setLoadState] = createSignal<LoadState>('loading')
  const [payload, setPayload] = createSignal<PublicLeaderboardResponse | null>(null)
  const [catalogPayload, setCatalogPayload] = createSignal<PublicLeaderboardResponse | null>(null)
  const [selectedServerId, setSelectedServerId] = createSignal<string | null>(null)
  const [tab, setTab] = createSignal<LeaderboardTab>('players')
  const [playerMode, setPlayerMode] = createSignal<PublicPlayerLeaderboardMode>('duel')
  const [civScope, setCivScope] = createSignal<PublicCivLeaderboardScope>('all')
  const [civMetric, setCivMetric] = createSignal<PublicCivLeaderboardMetric>('picked')
  let requestVersion = 0

  const loadServer = async (serverId: string | null, force = false) => {
    const version = ++requestVersion
    const cached = serverId ? memoizedPayloads.get(serverId) : undefined
    setSelectedServerId(serverId)
    if (cached && !force) {
      setPayload(cached)
      setCatalogPayload(cached)
      setLoadState('ready')
      return
    }

    setLoadState('loading')
    setPayload(null)
    try {
      const url = new URL('/api/public/leaderboards', window.location.origin)
      if (serverId) url.searchParams.set('server', serverId)
      const response = await globalThis.fetch(url)
      if (!response.ok) throw new Error('Leaderboard request failed')
      const result: unknown = await response.json()
      if (!isPublicLeaderboardResponse(result)) throw new Error('Leaderboard response was invalid')
      if (version !== requestVersion) return

      memoizedPayloads.set(result.server.id, result)
      setSelectedServerId(result.server.id)
      setPayload(result)
      setCatalogPayload(result)
      setLoadState('ready')
    }
    catch {
      if (version !== requestVersion) return
      setLoadState('error')
    }
  }

  const playerBoard = createMemo(() => payload()?.players[playerMode()] ?? null)
  const civBoard = createMemo(() => payload()?.civilizations[civScope()] ?? null)
  const civRows = createMemo(() => sortPublicCivLeaderboardRows(civMetric(), civBoard()?.rows ?? []))
  const sourceUpdatedAt = createMemo(() => {
    const current = payload()
    if (!current) return null
    return tab() === 'players'
      ? current.sourceSnapshots.players[playerMode()]
      : current.sourceSnapshots.civilizations[civScope()]
  })

  void loadServer(null)

  const selectTab = (next: LeaderboardTab) => {
    setTab(next)
  }
  const selectPlayerMode = (next: PublicPlayerLeaderboardMode) => {
    setPlayerMode(next)
  }
  const selectCivScope = (next: PublicCivLeaderboardScope) => {
    setCivScope(next)
  }
  const selectCivMetric = (next: PublicCivLeaderboardMetric) => {
    setCivMetric(next)
  }
  const selectServer = (serverId: string) => {
    void loadServer(serverId)
  }

  return (
    <section aria-labelledby="leaderboards-heading">
      <div class="max-w-3xl">
        <p class="text-accent text-sm font-bold uppercase tracking-[0.2em]">Standings</p>
        <h1 id="leaderboards-heading" class="mt-3 text-4xl font-black">Leaderboards</h1>
        <p class="text-fg-muted mt-4 text-lg leading-8">
          Ratings stay scoped to the selected server. There is no fabricated cross-server aggregate.
        </p>
      </div>

      <div class="border-border bg-bg-subtle mt-8 rounded-xl border p-4 sm:p-5">
        <div class="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0 sm:w-80">
            <label class="text-fg-muted mb-2 block text-sm font-bold" for="leaderboard-server">Supported server</label>
            <select
              id="leaderboard-server"
              class="focus-ring border-border bg-bg-elevated text-fg w-full rounded-md border px-3 py-2.5"
              value={selectedServerId() ?? ''}
              disabled={!catalogPayload() || loadState() === 'loading'}
              onChange={event => selectServer(event.currentTarget.value)}
            >
              <For each={catalogPayload()?.servers ?? []}>
                {server => <option value={server.id}>{server.displayName ?? server.id}</option>}
              </For>
            </select>
          </div>
          <div class="border-border bg-bg-elevated inline-flex self-start rounded-lg border p-1" role="group" aria-label="Leaderboard category">
            <TabButton selected={tab() === 'players'} onClick={() => selectTab('players')}>Players</TabButton>
            <TabButton selected={tab() === 'civilizations'} onClick={() => selectTab('civilizations')}>Civilizations</TabButton>
          </div>
        </div>
      </div>

      <Show when={loadState() === 'loading'}>
        <StatusPanel title="Loading leaderboards" body="Fetching the latest cached standings." busy />
      </Show>
      <Show when={loadState() === 'error'}>
        <StatusPanel title="Leaderboards unavailable" body="The standings could not be loaded. Try again shortly.">
          <button class="focus-ring bg-accent text-bg mt-5 rounded-md px-4 py-2 font-bold" type="button" onClick={() => { void loadServer(selectedServerId(), true) }}>Try again</button>
        </StatusPanel>
      </Show>

      <Show when={loadState() === 'ready' && payload()} keyed>
        {current => (
          <div class="mt-8">
            <p class="text-fg-muted mb-5 text-sm">
              {current.seasonPolicy === 'ppl-seasons' ? 'Current PPL season policy' : 'All-time server policy'}
              <span aria-hidden="true"> · </span>
              Generated {formatUpdatedAt(current.generatedAt)}
              <Show when={sourceUpdatedAt()}>
                {timestamp => <><span aria-hidden="true"> · </span>Snapshot updated {formatUpdatedAt(timestamp())}</>}
              </Show>
            </p>

            <Show when={tab() === 'players'} fallback={<CivilizationLeaderboards board={civBoard()} rows={civRows()} scope={civScope()} metric={civMetric()} onScope={selectCivScope} onMetric={selectCivMetric} />}>
              <PlayerLeaderboards board={playerBoard()} mode={playerMode()} onMode={selectPlayerMode} />
            </Show>
          </div>
        )}
      </Show>
    </section>
  )
}

function PlayerLeaderboards(props: {
  board: PublicPlayerLeaderboardBoard | null
  mode: PublicPlayerLeaderboardMode
  onMode: (mode: PublicPlayerLeaderboardMode) => void
}) {
  return (
    <>
      <ChoiceButtons label="Player mode">
        <For each={PUBLIC_PLAYER_LEADERBOARD_MODES}>
          {mode => <ChoiceButton selected={props.mode === mode} onClick={() => props.onMode(mode)}>{PLAYER_MODE_LABELS[mode]}</ChoiceButton>}
        </For>
      </ChoiceButtons>
      <Show when={props.board?.available} fallback={<StatusPanel title="Snapshot unavailable" body="This player leaderboard has not been generated yet." />}>
        <Show when={(props.board?.rows.length ?? 0) > 0} fallback={<StatusPanel title="No ranked players yet" body="No players have completed enough games to qualify for this mode." />}>
          <div class="border-border mt-5 overflow-x-auto rounded-xl border" tabindex="0" aria-label={`${PLAYER_MODE_LABELS[props.mode]} player leaderboard table`}>
            <table class="w-full min-w-155 border-collapse text-left">
              <thead class="bg-bg-elevated text-fg-subtle text-xs uppercase tracking-wider">
                <tr><th class="px-4 py-3" scope="col">Rank</th><th class="px-4 py-3" scope="col">Player</th><th class="px-4 py-3 text-right" scope="col">RP</th><th class="px-4 py-3 text-right" scope="col">Record</th><th class="px-4 py-3 text-right" scope="col">Win rate</th></tr>
              </thead>
              <tbody class="divide-border-subtle divide-y">
                <For each={props.board?.rows ?? []}>
                  {row => (
                    <tr class="bg-bg-subtle hover:bg-bg-elevated">
                      <td class="px-4 py-3 font-black">#{row.rank}<Show when={row.placementAdjustment}>{adjustment => <span class="text-fg-subtle ml-1 text-xs" title={`Raw rank ${adjustment().rawRank}; adjusted ${adjustment().places} places for activity`}>↓{adjustment().places}</span>}</Show></td>
                      <th class="px-4 py-3 font-bold" scope="row">{row.displayName}</th>
                      <td class="px-4 py-3 text-right tabular-nums">{row.rating} RP</td>
                      <td class="px-4 py-3 text-right tabular-nums">{row.wins}/{row.games}</td>
                      <td class="text-fg-muted px-4 py-3 text-right tabular-nums">{formatPercent(row.winRatePct)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <p class="text-fg-subtle mt-3 text-xs">↓ indicates a visible activity placement adjustment. Rating values are unchanged.</p>
        </Show>
      </Show>
    </>
  )
}

function CivilizationLeaderboards(props: {
  board: PublicLeaderboardResponse['civilizations'][PublicCivLeaderboardScope] | null
  rows: PublicLeaderboardResponse['civilizations'][PublicCivLeaderboardScope]['rows']
  scope: PublicCivLeaderboardScope
  metric: PublicCivLeaderboardMetric
  onScope: (scope: PublicCivLeaderboardScope) => void
  onMetric: (metric: PublicCivLeaderboardMetric) => void
}) {
  return (
    <>
      <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <ChoiceButtons label="Civilization mode scope">
          <For each={PUBLIC_CIV_LEADERBOARD_SCOPES}>
            {scope => <ChoiceButton selected={props.scope === scope} onClick={() => props.onScope(scope)}>{CIV_SCOPE_LABELS[scope]}</ChoiceButton>}
          </For>
        </ChoiceButtons>
        <ChoiceButtons label="Civilization metric">
          <For each={PUBLIC_CIV_LEADERBOARD_METRICS}>
            {metric => <ChoiceButton selected={props.metric === metric} onClick={() => props.onMetric(metric)}>{CIV_METRIC_LABELS[metric]}</ChoiceButton>}
          </For>
        </ChoiceButtons>
      </div>
      <Show when={props.board?.available} fallback={<StatusPanel title="Snapshot unavailable" body="This civilization leaderboard has not been generated yet." />}>
        <Show when={props.board?.historyInitialized} fallback={<StatusPanel title="History unavailable" body="Civilization history has not been initialized for this server." />}>
          <Show when={props.rows.length > 0} fallback={<StatusPanel title="No civilization data yet" body="No completed games are available for this view." />}>
            <div class="border-border mt-5 overflow-x-auto rounded-xl border" tabindex="0" aria-label={`${CIV_SCOPE_LABELS[props.scope]} civilization leaderboard table`}>
              <table class="w-full min-w-190 border-collapse text-left">
                <thead class="bg-bg-elevated text-fg-subtle text-xs uppercase tracking-wider">
                  <tr><th class="px-4 py-3" scope="col">Rank</th><th class="px-4 py-3" scope="col">Leader</th><th class="px-4 py-3 text-right" scope="col">Picks</th><th class="px-4 py-3 text-right" scope="col">Pick rate</th><th class="px-4 py-3 text-right" scope="col">Wins</th><th class="px-4 py-3 text-right" scope="col">Win rate</th><th class="px-4 py-3 text-right" scope="col">Bans</th></tr>
                </thead>
                <tbody class="divide-border-subtle divide-y">
                  <For each={props.rows}>
                    {(row, index) => (
                      <tr class="bg-bg-subtle hover:bg-bg-elevated">
                        <td class="px-4 py-3 font-black">#{index() + 1}</td>
                        <th class="px-4 py-3 font-bold" scope="row">{row.name}</th>
                        <td class="px-4 py-3 text-right tabular-nums">{row.picks}</td>
                        <td class="text-fg-muted px-4 py-3 text-right tabular-nums">{formatNullablePercent(row.pickRatePct)}</td>
                        <td class="px-4 py-3 text-right tabular-nums">{row.wins}</td>
                        <td class="text-fg-muted px-4 py-3 text-right tabular-nums">{formatNullablePercent(row.winRatePct)}</td>
                        <td class="px-4 py-3 text-right tabular-nums">{row.bans}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <p class="text-fg-subtle mt-3 text-xs">{props.board?.label} · {props.board?.completedGames} completed games</p>
          </Show>
        </Show>
      </Show>
    </>
  )
}

function TabButton(props: { selected: boolean, onClick: () => void, children: string }) {
  return <button class={props.selected ? 'focus-ring bg-accent text-bg rounded-md px-4 py-2 text-sm font-bold' : 'focus-ring text-fg-muted hover:text-fg rounded-md px-4 py-2 text-sm font-bold'} type="button" aria-pressed={props.selected} onClick={props.onClick}>{props.children}</button>
}

function ChoiceButtons(props: { label: string, children: JSX.Element }) {
  return <div class="flex flex-wrap gap-2" role="group" aria-label={props.label}>{props.children}</div>
}

function ChoiceButton(props: { selected: boolean, onClick: () => void, children: string }) {
  return <button class={props.selected ? 'focus-ring border-accent bg-accent-subtle text-accent rounded-md border px-3 py-2 text-sm font-bold' : 'focus-ring border-border text-fg-muted hover:border-border-hover hover:text-fg rounded-md border px-3 py-2 text-sm font-bold'} type="button" aria-pressed={props.selected} onClick={props.onClick}>{props.children}</button>
}

function StatusPanel(props: { title: string, body: string, busy?: boolean, children?: JSX.Element }) {
  return (
    <div class="border-border bg-bg-subtle mt-5 rounded-xl border px-5 py-8 text-center" role={props.busy ? 'status' : undefined} aria-live="polite">
      <h2 class="text-lg font-black">{props.title}</h2>
      <p class="text-fg-muted mt-2">{props.body}</p>
      {props.children}
    </div>
  )
}

function formatUpdatedAt(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`
}

function formatNullablePercent(value: number | null): string {
  return value == null ? '—' : formatPercent(value)
}

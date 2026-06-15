<<<<<<< New base: chore: update leader desc
import { CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import type { Leader } from '@civup/game'
import { betaLeaderDataVersionLabel, getLeaders, liveLeaderDataVersionLabel } from '@civup/game'
import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show } from 'solid-js'
import { useActivityController } from '~/client/activity/activity-context'
import { Dropdown } from '~/client/components/ui/Dropdown'
import { buildActivitySessionHeaders, getActivitySessionToken } from '~/client/lib/activity-session'
import { openExternalLink } from '~/client/platform/external-links'
import { isMiniView } from '~/client/stores'

interface AutosaveUploadCatalogRow {
  id: string
  uploadedAt: number
  uploaderUserId: string
  uploaderDisplayName: string | null
  channelId: string | null
  matchId: string | null
  fileName: string
  fileSizeBytes: number
  etag: string | null
  status: string
  downloadCount: number
  parseStatus: string
  parseError: string | null
  saveCount: number | null
  maxTurn: number | null
  latestSaveName: string | null
  playerCount: number | null
  gameMode: string | null
  leadersJson: string | null
  civsJson: string | null
  playersJson: string | null
  mapFile: string | null
  modsJson: string | null
  bbgDetected: boolean
  bbgTitle: string | null
  bbgVersion: string | null
  notes: string | null
}

interface AutosaveUploadCatalogResponse {
  uploads?: AutosaveUploadCatalogRow[]
  error?: string
}

interface AutosaveParsedPlayer {
  slot: number | null
  playerName: string | null
  leader: string | null
  civilization: string | null
  isHuman: boolean | null
  alive: boolean | null
}

interface CatalogLeaderCard {
  key: string
  slot: number | null
  playerName: string | null
  leaderName: string
  portraitUrl: string | null
  isHuman: boolean | null
  searchText: string
}

interface CatalogMetaItem {
  value: string
  title?: string
}

interface DecoratedAutosaveUpload {
  row: AutosaveUploadCatalogRow
  bbgVersion: string | null
  bbgLabel: string | null
  mapLabel: string | null
  leaders: CatalogLeaderCard[]
  searchText: string
}

type CatalogAction = 'delete' | 'reparse'

const CATALOG_LEADERS = dedupeCatalogLeaders([...getLeaders('beta'), ...getLeaders('live')])
const TEAM_SLOT_PATTERN = [0, 1, 1, 0, 1, 0] as const
const REPARSE_POLL_DELAYS_MS = [2000, 5000, 5000, 5000, 5000] as const

export default function AutosaveCatalogPage() {
  const activity = useActivityController()
  const [uploads, setUploads] = createSignal<AutosaveUploadCatalogRow[]>([])
  const [loading, setLoading] = createSignal(false)
  const [hasLoaded, setHasLoaded] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal('')
  const [modeFilter, setModeFilter] = createSignal('')
  const [mapFilter, setMapFilter] = createSignal('')
  const [bbgFilter, setBbgFilter] = createSignal('')
  const [downloadingId, setDownloadingId] = createSignal<string | null>(null)
  const [pendingAction, setPendingAction] = createSignal<{ id: string, action: CatalogAction } | null>(null)
  const [pollingReparseIds, setPollingReparseIds] = createSignal<Set<string>>(new Set())
  let loaded = false
  let disposed = false

  onCleanup(() => {
    disposed = true
  })

  const loadUploads = async (options: { showLoading?: boolean, showError?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true
    const showError = options.showError ?? true
    if (showLoading) setLoading(true)
    if (showError) setError(null)
    try {
      const response = await fetch('/api/uploads/autosaves', {
        headers: buildActivitySessionHeaders(),
      })
      const payload = await response.json().catch(() => null) as AutosaveUploadCatalogResponse | null
      if (!response.ok) throw new Error(payload?.error ?? 'Failed')
      if (disposed) return
      setUploads(payload?.uploads ?? [])
    }
    catch (err) {
      if (showError && !disposed) setError(err instanceof Error && err.message.trim().length > 0 ? err.message : 'Failed')
    }
    finally {
      if (!disposed) {
        if (showLoading) setLoading(false)
        setHasLoaded(true)
      }
    }
  }

  createEffect(() => {
    const state = activity.state()
    if (loaded || state.status === 'loading') return
    loaded = true
    if (!activity.canViewAutosaveCatalog()) {
      setError('Forbidden')
      return
    }
    void loadUploads()
  })

  const decoratedUploads = createMemo(() => uploads().map(row => decorateUpload(row)))
  const modeOptions = createMemo(() => uniqueSorted(decoratedUploads().map(item => item.row.gameMode)))
  const mapOptions = createMemo(() => uniqueSorted(decoratedUploads().map(item => item.mapLabel)))
  const bbgOptions = createMemo(() => uniqueSorted(decoratedUploads().map(item => item.bbgVersion)))
  const filteredUploads = createMemo(() => {
    const query = normalizeSearchText(search())
    const mode = modeFilter()
    const map = mapFilter()
    const bbg = bbgFilter()
    return decoratedUploads().filter((item) => {
      const row = item.row
      if (mode && row.gameMode !== mode) return false
      if (map && item.mapLabel !== map) return false
      if (bbg && item.bbgVersion !== bbg) return false
      if (!query) return true
      return item.searchText.includes(query)
    })
  })

  const downloadUpload = async (row: AutosaveUploadCatalogRow) => {
    if (downloadingId()) return
    setDownloadingId(row.id)
    try {
      const url = buildExternalDownloadUrl(row)
      console.debug('[autosave-catalog] download open', { id: row.id, fileName: row.fileName, url })
      const opened = await openExternalLink(url)
      if (!opened) window.open(url, '_blank', 'noopener')
      setUploads(current => current.map(candidate => candidate.id === row.id
        ? { ...candidate, downloadCount: candidate.downloadCount + 1 }
        : candidate))
      console.debug('[autosave-catalog] download opened', { id: row.id, opened })
    }
    catch (err) {
      console.error('[autosave-catalog] download failed', { id: row.id, fileName: row.fileName }, err)
      const url = buildExternalDownloadUrl(row)
      window.open(url, '_blank', 'noopener')
    }
    finally {
      setDownloadingId(null)
    }
  }

  const reparseUpload = async (row: AutosaveUploadCatalogRow) => {
    await runCatalogAction(row, 'reparse')
  }

  const deleteUpload = async (row: AutosaveUploadCatalogRow) => {
    await runCatalogAction(row, 'delete')
  }

  const isReparsePolling = (id: string) => pollingReparseIds().has(id)

  const setReparsePolling = (id: string, enabled: boolean) => {
    setPollingReparseIds((current) => {
      const next = new Set(current)
      if (enabled) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const pollReparseStatus = async (id: string) => {
    if (isReparsePolling(id)) return
    setReparsePolling(id, true)
    try {
      for (const delayMs of REPARSE_POLL_DELAYS_MS) {
        await delay(delayMs)
        if (disposed) return
        await loadUploads({ showLoading: false, showError: false })
        if (disposed) return
        const row = uploads().find(candidate => candidate.id === id)
        if (!row || row.parseStatus !== 'pending') return
      }
    }
    finally {
      if (!disposed) setReparsePolling(id, false)
    }
  }

  const runCatalogAction = async (row: AutosaveUploadCatalogRow, action: CatalogAction) => {
    if (pendingAction()) return
    setPendingAction({ id: row.id, action })
    setError(null)
    try {
      const response = await fetch(`/api/uploads/autosaves/${encodeURIComponent(row.id)}${action === 'reparse' ? '/reparse' : ''}`, {
        method: action === 'reparse' ? 'POST' : 'DELETE',
        headers: buildActivitySessionHeaders(),
      })
      const payload = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(payload?.error ?? 'Failed')

      if (action === 'delete') {
        setUploads(current => current.filter(candidate => candidate.id !== row.id))
      }
      else {
        setUploads(current => current.map(candidate => candidate.id === row.id
          ? { ...candidate, parseStatus: 'pending', parseError: null }
          : candidate))
        void pollReparseStatus(row.id)
      }
    }
    catch (err) {
      setError(err instanceof Error && err.message.trim().length > 0 ? err.message : 'Failed')
    }
    finally {
      setPendingAction(null)
    }
  }

  const pageContent = () => (
    <main class="text-fg bg-bg font-sans relative min-h-screen overflow-y-auto">
      <div class="flex gap-2 items-center z-20 absolute top-12 right-4 sm:top-4 sm:right-6">
        <button
          type="button"
          class="text-sm text-fg-muted border border-border-subtle rounded-md flex h-9 cursor-pointer gap-2 px-3 transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted disabled:opacity-50"
          title="Refresh saved games"
          aria-label="Refresh saved games"
          disabled={loading()}
          onClick={() => void loadUploads()}
        >
          <span class={loading() ? 'i-gg:spinner text-sm animate-spin' : 'i-ph-arrow-clockwise-bold text-sm'} />
          Refresh
        </button>
        <button
          type="button"
          class="text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted"
          title="Lobby Overview"
          aria-label="Lobby Overview"
          onClick={() => activity.openOverview()}
        >
          <span class="i-ph-squares-four-bold text-base" />
        </button>
      </div>
      <div class="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6">
        <header class="flex items-center gap-3 pr-24">
          <h1 class="text-xl font-semibold">Saved Games</h1>
        </header>

        <div class="flex flex-wrap items-center gap-3">
          <div class="relative min-w-56 max-w-sm flex-1 max-sm:basis-full">
            <div class="i-ph-magnifying-glass-bold text-sm text-fg-subtle left-3 top-1/2 absolute -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search leaders, players..."
              value={search()}
              class="text-sm text-fg px-3.5 py-2 pl-9 rounded-lg w-full bg-bg/60 border border-border outline-none transition-all duration-150 placeholder:text-fg-subtle/60 focus:border-border-hover focus:bg-bg/80"
              onInput={event => setSearch(event.currentTarget.value)}
            />
          </div>
          <Dropdown
            ariaLabel="Mode filter"
            class="w-32"
            tone="neutral"
            value={modeFilter()}
            options={[{ value: '', label: 'All modes' }, ...modeOptions().map(mode => ({ value: mode, label: mode }))]}
            onChange={setModeFilter}
          />
          <Dropdown
            ariaLabel="Map filter"
            class="w-36"
            tone="neutral"
            value={mapFilter()}
            options={[{ value: '', label: 'All maps' }, ...mapOptions().map(map => ({ value: map, label: map }))]}
            onChange={setMapFilter}
          />
          <Dropdown
            ariaLabel="BBG filter"
            class="w-32"
            tone="neutral"
            value={bbgFilter()}
            options={[{ value: '', label: 'All BBG' }, ...bbgOptions().map(bbg => ({ value: bbg, label: bbg }))]}
            onChange={setBbgFilter}
          />
          <div class="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <span>{filteredUploads().length} / {uploads().length}</span>
            <span class="i-ph-archive-bold text-sm" />
          </div>
        </div>

        <Show when={error()}>
          <div class="rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">{error()}</div>
        </Show>

        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <Show when={loading() && !hasLoaded()}>
            <For each={[0, 1, 2, 3]}>{() => <CatalogCardSkeleton />}</For>
          </Show>
          <Index each={filteredUploads()}>
            {item => {
              const row = () => item().row
              const action = () => pendingAction()
              return (
              <article class="rounded-xl border border-border-subtle bg-bg-subtle/45 p-3">
                <div class="flex items-center gap-3">
                  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <Show when={row().gameMode}>
                      <span class="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-bold text-accent">{row().gameMode}</span>
                    </Show>
                    <Show when={row().maxTurn != null}>
                      <span class="rounded-full border border-fg-muted/25 bg-fg-muted/10 px-2 py-0.5 text-xs font-bold text-fg-muted">T{row().maxTurn}</span>
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      class="grid size-8 cursor-pointer place-items-center rounded-md text-fg-muted opacity-75 transition hover:bg-bg-muted hover:opacity-100 disabled:pointer-events-none disabled:cursor-default disabled:opacity-40"
                      title="Reparse metadata"
                      aria-label="Reparse metadata"
                      disabled={action() != null || isReparsePolling(row().id)}
                      onClick={() => void reparseUpload(row())}
                    >
                      <span class={(action()?.id === row().id && action()?.action === 'reparse') || isReparsePolling(row().id) ? 'i-gg:spinner text-base animate-spin' : 'i-ph-arrow-clockwise-bold text-base'} />
                    </button>
                    <button
                      type="button"
                      class="grid size-8 cursor-pointer place-items-center rounded-md text-danger opacity-75 transition hover:bg-danger/10 hover:opacity-100 disabled:pointer-events-none disabled:cursor-default disabled:opacity-40"
                      title="Delete upload"
                      aria-label="Delete upload"
                      disabled={action() != null}
                      onClick={() => void deleteUpload(row())}
                    >
                      <span class={action()?.id === row().id && action()?.action === 'delete' ? 'i-gg:spinner text-base animate-spin' : 'i-ph-trash-bold text-base'} />
                    </button>
                    <button
                      type="button"
                      class="grid size-8 cursor-pointer place-items-center rounded-md text-accent opacity-75 transition hover:bg-accent/10 hover:opacity-100 disabled:pointer-events-none disabled:cursor-default disabled:opacity-40"
                      title="Download autosave zip"
                      aria-label="Download autosave zip"
                      disabled={downloadingId() != null}
                      onClick={() => void downloadUpload(row())}
                    >
                      <span class={downloadingId() === row().id ? 'i-gg:spinner text-base animate-spin' : 'i-ph-download-simple-bold text-base'} />
                    </button>
                  </div>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                  <For each={buildMetaItems(item())}>
                    {(meta, index) => (
                      <>
                        <Show when={index() > 0}>
                          <span class="text-fg-muted/40">·</span>
                        </Show>
                        <span class="text-fg-muted" title={meta.title}>{meta.value}</span>
                      </>
                    )}
                  </For>
                </div>

                <Show when={item().leaders.length > 0}>
                  <div class="mt-3">
                    <PlayerColumns leaders={item().leaders} />
                  </div>
                </Show>
                <div class="mt-3 truncate text-xs text-fg-muted/75">
                  {formatDate(row().uploadedAt)} by {row().uploaderDisplayName ?? row().uploaderUserId}
                </div>
              </article>
              )
            }}
          </Index>
        </div>

        <Show when={!loading() && !error() && filteredUploads().length === 0}>
          <div class="rounded-xl border border-border-subtle bg-bg-subtle/40 px-4 py-3 text-sm text-fg-muted">Empty</div>
        </Show>
      </div>
    </main>
  )

  return (
    <Show when={isMiniView()} fallback={pageContent()}>
      <main class="text-fg bg-bg font-sans h-screen overflow-hidden p-3">
        <div class="shrink-0 h-5 relative">
          <span class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs tracking-widest font-bold uppercase text-white">
            Saved Games
          </span>
          <span class="text-sm text-fg-muted font-mono text-right right-0 top-1/2 absolute tabular-nums -translate-y-1/2 inline-flex items-center gap-1">
            <span>{filteredUploads().length}/{uploads().length}</span>
            <span class="i-ph-archive-bold text-sm" />
          </span>
        </div>
      </main>
    </Show>
  )
}

function CatalogCardSkeleton() {
  return (
    <article class="rounded-xl border border-border-subtle bg-bg-subtle/35 p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <div class="h-5 w-10 animate-pulse rounded-full bg-bg-muted" />
          <div class="h-5 w-12 animate-pulse rounded-full bg-bg-muted" />
        </div>
        <div class="flex gap-1">
          <div class="size-8 animate-pulse rounded-md bg-bg-muted" />
          <div class="size-8 animate-pulse rounded-md bg-bg-muted" />
          <div class="size-8 animate-pulse rounded-md bg-bg-muted" />
        </div>
      </div>
      <div class="mt-3 h-3 w-3/4 animate-pulse rounded bg-bg-muted" />
      <div class="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
        <For each={[0, 1, 2, 3]}>{() => (
          <div class="flex items-center gap-2">
            <div class="size-8 shrink-0 animate-pulse rounded-full bg-bg-muted" />
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="h-3 w-4/5 animate-pulse rounded bg-bg-muted" />
              <div class="h-2.5 w-2/3 animate-pulse rounded bg-bg-muted" />
            </div>
          </div>
        )}</For>
      </div>
      <div class="mt-4 h-3 w-1/2 animate-pulse rounded bg-bg-muted" />
    </article>
  )
}

function PlayerColumns(props: { leaders: CatalogLeaderCard[] }) {
  const columns = splitPlayerColumns(props.leaders)
  if (!columns) {
    return <div class="grid gap-1"><For each={props.leaders}>{leader => <PlayerRow leader={leader} />}</For></div>
  }

  return (
    <div class="grid grid-cols-2 gap-x-3 gap-y-1">
      <div class="grid min-w-0 gap-1">
        <For each={columns.left}>{leader => <PlayerRow leader={leader} />}</For>
      </div>
      <div class="grid min-w-0 gap-1">
        <For each={columns.right}>{leader => <PlayerRow leader={leader} />}</For>
      </div>
    </div>
  )
}

function PlayerRow(props: { leader: CatalogLeaderCard }) {
  const initial = () => props.leader.leaderName.slice(0, 1).toUpperCase() || '?'
  const playerName = () => formatCatalogPlayerName(props.leader)
  const playerClass = () => props.leader.isHuman === false
    ? 'truncate text-xs text-fg-muted'
    : 'truncate text-xs font-bold text-fg'

  return (
    <div class="flex min-w-0 items-center gap-2 py-0.5">
      <Show
        when={props.leader.portraitUrl}
        fallback={<div class="grid size-8 shrink-0 place-items-center rounded-full border border-border-subtle bg-bg-muted text-xs font-bold text-fg-muted">{initial()}</div>}
      >
        <img
          src={props.leader.portraitUrl ?? ''}
          alt=""
          class="size-8 shrink-0 rounded-full object-cover"
          loading="lazy"
        />
      </Show>
      <div class="min-w-0">
        <div class={playerClass()}>{playerName()}</div>
        <div class="truncate text-[0.68rem] text-fg-muted">{props.leader.leaderName}</div>
      </div>
    </div>
  )
}

function splitPlayerColumns(leaders: CatalogLeaderCard[]): { left: CatalogLeaderCard[], right: CatalogLeaderCard[] } | null {
  if (leaders.length < 2 || leaders.length % 2 !== 0) return null

  const sorted = normalizeCatalogTeamDisplayOrder([...leaders].sort((left, right) => (left.slot ?? Number.MAX_SAFE_INTEGER) - (right.slot ?? Number.MAX_SAFE_INTEGER)))
  const columns: { left: CatalogLeaderCard[], right: CatalogLeaderCard[] } = { left: [], right: [] }
  sorted.forEach((leader, index) => {
    const team = TEAM_SLOT_PATTERN[index % TEAM_SLOT_PATTERN.length]
    if (team === 0) columns.left.push(leader)
    else columns.right.push(leader)
  })
  return columns
}

function normalizeCatalogTeamDisplayOrder(leaders: CatalogLeaderCard[]): CatalogLeaderCard[] {
  if (leaders.length !== 6) return leaders
  return [leaders[0]!, leaders[1]!, leaders[2]!, leaders[3]!, leaders[5]!, leaders[4]!]
}

function formatCatalogPlayerName(leader: CatalogLeaderCard): string {
  if (leader.playerName) return leader.playerName
  if (leader.isHuman === false) return 'AI'
  return 'Player'
}

function uniqueSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.length > 0))]
    .sort((left, right) => left.localeCompare(right))
}

function buildExternalDownloadUrl(row: AutosaveUploadCatalogRow): string {
  const url = new URL(`/api/uploads/autosaves/${encodeURIComponent(row.id)}/download`, window.location.origin)
  const token = getActivitySessionToken()
  if (token) url.searchParams.set(CIVUP_ACTIVITY_SESSION_QUERY_PARAM, token)
  return url.toString()
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const kb = value / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function formatDownloadCount(value: number): string {
  return value === 1 ? '1 Download' : `${value} Downloads`
}

function formatSaveCount(value: number): string {
  return value === 1 ? '1 Save' : `${value} Saves`
}

function buildMetaItems(item: DecoratedAutosaveUpload): CatalogMetaItem[] {
  const row = item.row
  const items: CatalogMetaItem[] = []
  if (item.bbgLabel) items.push({ value: item.bbgLabel, title: 'BBG version' })
  items.push({ value: `Size ${formatBytes(row.fileSizeBytes)}`, title: 'Uploaded zip size' })
  if (row.saveCount != null) items.push({ value: formatSaveCount(row.saveCount), title: 'Autosave files found' })
  if (row.downloadCount > 0) items.push({ value: formatDownloadCount(row.downloadCount), title: 'Times this game has been downloaded' })
  return items
}

function decorateUpload(row: AutosaveUploadCatalogRow): DecoratedAutosaveUpload {
  const bbgVersion = resolveBbgVersion(row)
  const bbgLabel = bbgVersion ? `BBG ${bbgVersion}` : null
  const mapLabel = formatMapFile(row.mapFile)
  const leaders = resolveLeaderCards(row)
  const searchText = normalizeSearchText([
    row.uploaderDisplayName,
    row.uploaderUserId,
    row.gameMode,
    mapLabel,
    bbgVersion,
    ...leaders.map(leader => leader.searchText),
  ].filter((value): value is string => value != null && value.length > 0).join(' '))

  return { row, bbgVersion, bbgLabel, mapLabel, leaders, searchText }
}

function resolveLeaderCards(row: AutosaveUploadCatalogRow): CatalogLeaderCard[] {
  const players = parsePlayers(row.playersJson)
  if (players.length > 0) {
    return players.map((player, index) => buildLeaderCard(player, index))
  }

  return parseLeaderCodes(row.leadersJson).map((leaderCode, index) => buildLeaderCard({
    slot: index,
    playerName: null,
    leader: leaderCode,
    civilization: null,
    isHuman: null,
    alive: null,
  }, index))
}

function buildLeaderCard(player: AutosaveParsedPlayer, index: number): CatalogLeaderCard {
  const leader = resolveCatalogLeader(player.leader, player.civilization)
  const leaderName = leader?.name ?? formatLeaderCode(player.leader)
  const civilizationName = leader?.civilization ?? formatCivilizationCode(player.civilization)
  const playerName = normalizeDisplayValue(player.playerName)
  const searchText = normalizeSearchText([
    playerName,
    leaderName,
    civilizationName,
    player.leader,
    player.civilization,
  ].filter((value): value is string => value != null && value.length > 0).join(' '))

  return {
    key: `${player.slot ?? index}:${player.leader ?? leaderName}`,
    slot: player.slot ?? index,
    playerName,
    leaderName,
    portraitUrl: leader?.portraitUrl ?? null,
    isHuman: player.isHuman,
    searchText,
  }
}

function parsePlayers(value: string | null): AutosaveParsedPlayer[] {
  const parsed = parseJsonArray(value)
  return parsed
    .map((item): AutosaveParsedPlayer | null => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      return {
        slot: typeof record.slot === 'number' && Number.isFinite(record.slot) ? record.slot : null,
        playerName: stringValue(record.playerName),
        leader: stringValue(record.leader),
        civilization: stringValue(record.civilization),
        isHuman: typeof record.isHuman === 'boolean' ? record.isHuman : null,
        alive: typeof record.alive === 'boolean' ? record.alive : null,
      }
    })
    .filter((item): item is AutosaveParsedPlayer => item != null && (item.leader != null || item.playerName != null))
}

function parseLeaderCodes(value: string | null): string[] {
  return parseJsonArray(value)
    .map(item => typeof item === 'string' ? normalizeDisplayValue(item) : null)
    .filter((item): item is string => item != null)
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

function resolveCatalogLeader(leaderCode: string | null, civilizationCode: string | null): Leader | null {
  if (!leaderCode) return null
  const codeLabel = formatLeaderCode(leaderCode)
  const codeText = normalizeSearchText(codeLabel)
  const codeTokens = tokenizeSearchText(`${codeLabel} ${leaderCode}`)
  const civilizationName = formatCivilizationCode(civilizationCode)
  const civilizationText = civilizationName ? normalizeSearchText(civilizationName) : null
  const candidates = civilizationText
    ? CATALOG_LEADERS.filter(leader => normalizeSearchText(leader.civilization) === civilizationText)
    : CATALOG_LEADERS

  return candidates.find(leader => leaderNameMatchesCode(leader, codeText, codeTokens))
    ?? CATALOG_LEADERS.find(leader => leaderNameMatchesCode(leader, codeText, codeTokens))
    ?? null
}

function leaderNameMatchesCode(leader: Leader, codeText: string, codeTokens: Set<string>): boolean {
  const leaderName = normalizeSearchText(leader.name)
  const shortLeaderName = normalizeSearchText(leader.name.replace(/\s*\([^)]*\)\s*/g, ' '))
  if (leaderName === codeText || shortLeaderName === codeText) return true
  if (codeText.endsWith(` ${leaderName}`) || codeText.endsWith(` ${shortLeaderName}`)) return true
  if (codeText.includes(leaderName) || codeText.includes(shortLeaderName)) return true
  if (shortLeaderName.includes(codeText) && codeText.length >= 4) return true

  const nameTokens = tokenizeSearchText(shortLeaderName)
  const requiredNameTokens = [...nameTokens].filter(token => !isLeaderOrdinalToken(token))
  return requiredNameTokens.length > 0 && requiredNameTokens.every(token => codeTokens.has(token))
}

function dedupeCatalogLeaders(leaders: Leader[]): Leader[] {
  const seen = new Set<string>()
  const result: Leader[] = []
  for (const leader of leaders) {
    const key = `${leader.civilization}:${leader.name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(leader)
  }
  return result
}

function resolveBbgVersion(row: AutosaveUploadCatalogRow): string | null {
  if (row.bbgVersion) return row.bbgVersion
  if (!row.bbgDetected) return null
  if (row.bbgTitle?.toLowerCase().includes('beta')) return betaLeaderDataVersionLabel
  return liveLeaderDataVersionLabel
}

function formatMapFile(value: string | null): string | null {
  const fileName = value?.split(/[\\/]/).pop()?.trim() ?? ''
  if (!fileName) return null
  return titleCaseWords(fileName.replace(/\.lua$/i, '').replace(/[_-]+/g, ' '))
}

function formatLeaderCode(value: string | null): string {
  if (!value) return 'Unknown leader'
  let normalized = value.replace(/^LEADER_/i, '')
  if (/^LIME_[A-Z0-9]+_/i.test(normalized)) normalized = normalized.replace(/^LIME_[A-Z0-9]+_/i, '')
  normalized = normalized.replace(/^JFD_/i, '')
  return titleCaseWords(normalized.replace(/_/g, ' '))
}

function isLeaderOrdinalToken(value: string): boolean {
  return /^(?:i|v|x)+$/i.test(value) || /^\d+$/.test(value)
}

function formatCivilizationCode(value: string | null): string | null {
  if (!value) return null
  return titleCaseWords(value.replace(/^CIVILIZATION_/i, '').replace(/_/g, ' '))
}

function titleCaseWords(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.length <= 2 ? word.toUpperCase() : `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`)
    .join(' ')
}

function normalizeDisplayValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? normalizeDisplayValue(value) : null
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function tokenizeSearchText(value: string): Set<string> {
  return new Set(normalizeSearchText(value).split(/\s+/).filter(token => token.length > 0))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
|||||||
=======
import { CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { useActivityController } from '~/client/activity/activity-context'
import { discordSdk } from '~/client/discord'
import { buildActivitySessionHeaders, getActivitySessionToken } from '~/client/lib/activity-session'

interface AutosaveUploadCatalogRow {
  id: string
  uploadedAt: number
  uploaderUserId: string
  uploaderDisplayName: string | null
  channelId: string | null
  matchId: string | null
  fileName: string
  fileSizeBytes: number
  etag: string | null
  status: string
  downloadCount: number
  parseStatus: string
  parseError: string | null
  saveCount: number | null
  maxTurn: number | null
  latestSaveName: string | null
  playerCount: number | null
  gameMode: string | null
  leadersJson: string | null
  civsJson: string | null
  playersJson: string | null
  mapFile: string | null
  modsJson: string | null
  bbgDetected: boolean
  bbgTitle: string | null
  bbgVersion: string | null
  notes: string | null
}

interface AutosaveUploadCatalogResponse {
  uploads?: AutosaveUploadCatalogRow[]
  error?: string
}

export default function AutosaveCatalogPage() {
  const activity = useActivityController()
  const [uploads, setUploads] = createSignal<AutosaveUploadCatalogRow[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal('')
  const [modeFilter, setModeFilter] = createSignal('')
  const [bbgFilter, setBbgFilter] = createSignal('')
  const [downloadingId, setDownloadingId] = createSignal<string | null>(null)
  let loaded = false

  const loadUploads = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/uploads/autosaves', {
        headers: buildActivitySessionHeaders(),
      })
      const payload = await response.json().catch(() => null) as AutosaveUploadCatalogResponse | null
      if (!response.ok) throw new Error(payload?.error ?? 'Failed')
      setUploads(payload?.uploads ?? [])
    }
    catch (err) {
      setError(err instanceof Error && err.message.trim().length > 0 ? err.message : 'Failed')
    }
    finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    const state = activity.state()
    if (loaded || state.status === 'loading') return
    loaded = true
    if (!activity.canViewAutosaveCatalog()) {
      setError('Forbidden')
      return
    }
    void loadUploads()
  })

  const modeOptions = createMemo(() => uniqueSorted(uploads().map(row => row.gameMode)))
  const bbgOptions = createMemo(() => uniqueSorted(uploads().map(row => row.bbgVersion)))
  const filteredUploads = createMemo(() => {
    const query = search().trim().toLowerCase()
    const mode = modeFilter()
    const bbg = bbgFilter()
    return uploads().filter((row) => {
      if (mode && row.gameMode !== mode) return false
      if (bbg && row.bbgVersion !== bbg) return false
      if (!query) return true
      return [
        row.fileName,
        row.uploaderDisplayName,
        row.uploaderUserId,
        row.matchId,
        row.leadersJson,
        row.bbgVersion,
        row.gameMode,
      ].some(value => value?.toLowerCase().includes(query))
    })
  })

  const downloadUpload = async (row: AutosaveUploadCatalogRow) => {
    if (downloadingId()) return
    setDownloadingId(row.id)
    try {
      const url = buildExternalDownloadUrl(row)
      console.debug('[autosave-catalog] download open', { id: row.id, fileName: row.fileName, url })
      const response = await discordSdk.commands.openExternalLink({ url })
      if (response?.opened !== true) window.open(url, '_blank', 'noopener')
      setUploads(current => current.map(candidate => candidate.id === row.id
        ? { ...candidate, downloadCount: candidate.downloadCount + 1 }
        : candidate))
      console.debug('[autosave-catalog] download opened', { id: row.id, opened: response?.opened ?? null })
    }
    catch (err) {
      console.error('[autosave-catalog] download failed', { id: row.id, fileName: row.fileName }, err)
      const url = buildExternalDownloadUrl(row)
      window.open(url, '_blank', 'noopener')
    }
    finally {
      setDownloadingId(null)
    }
  }

  return (
    <main class="text-fg bg-bg font-sans min-h-screen overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6">
        <header class="flex items-center gap-3">
          <button
            type="button"
            class="text-sm text-fg-muted rounded-md border border-border-subtle px-3 py-1.5 transition hover:text-fg hover:bg-bg-muted"
            onClick={() => activity.openOverview()}
          >
            Back
          </button>
          <h1 class="text-xl font-semibold">Catalog</h1>
          <button
            type="button"
            class="text-sm text-fg-muted ml-auto rounded-md border border-border-subtle px-3 py-1.5 transition hover:text-fg hover:bg-bg-muted disabled:opacity-50"
            disabled={loading()}
            onClick={() => void loadUploads()}
          >
            Refresh
          </button>
        </header>

        <div class="grid gap-3 rounded-xl border border-border-subtle bg-bg-subtle/40 p-3 sm:grid-cols-[minmax(14rem,1fr)_10rem_10rem_auto]">
          <label class="grid gap-1 text-xs font-semibold text-fg-muted">
            Search
            <input
              value={search()}
              class="h-9 rounded-md border border-border-subtle bg-bg px-3 text-sm text-fg outline-none focus:border-border-hover"
              onInput={event => setSearch(event.currentTarget.value)}
            />
          </label>
          <label class="grid gap-1 text-xs font-semibold text-fg-muted">
            Mode
            <select
              value={modeFilter()}
              class="h-9 rounded-md border border-border-subtle bg-bg px-3 text-sm text-fg outline-none focus:border-border-hover"
              onChange={event => setModeFilter(event.currentTarget.value)}
            >
              <option value="">All</option>
              <For each={modeOptions()}>{mode => <option value={mode}>{mode}</option>}</For>
            </select>
          </label>
          <label class="grid gap-1 text-xs font-semibold text-fg-muted">
            BBG
            <select
              value={bbgFilter()}
              class="h-9 rounded-md border border-border-subtle bg-bg px-3 text-sm text-fg outline-none focus:border-border-hover"
              onChange={event => setBbgFilter(event.currentTarget.value)}
            >
              <option value="">All</option>
              <For each={bbgOptions()}>{bbg => <option value={bbg}>{bbg}</option>}</For>
            </select>
          </label>
          <div class="self-end text-right text-sm text-fg-muted">{filteredUploads().length}</div>
        </div>

        <Show when={error()}>
          <div class="rounded-xl border border-danger/25 bg-danger/10 px-4 py-3 text-sm text-danger">{error()}</div>
        </Show>

        <Show when={loading()}>
          <div class="rounded-xl border border-border-subtle bg-bg-subtle/40 px-4 py-3 text-sm text-fg-muted">Loading</div>
        </Show>

        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <For each={filteredUploads()}>
            {row => (
              <article class="rounded-xl border border-border-subtle bg-bg-subtle/45 p-3">
                <div class="mb-3 flex items-start gap-3">
                  <div class="min-w-0 flex-1 truncate text-sm font-semibold" title={row.fileName}>{row.fileName}</div>
                  <button
                    type="button"
                    class="text-xs text-accent rounded-md border border-accent/30 px-2 py-1 font-semibold transition hover:border-accent/60 hover:bg-accent/10 disabled:pointer-events-none disabled:opacity-50"
                    disabled={downloadingId() != null}
                    onClick={() => void downloadUpload(row)}
                  >
                    {downloadingId() === row.id ? '...' : 'Download'}
                  </button>
                </div>
                <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <Field label="By" value={row.uploaderDisplayName ?? row.uploaderUserId} />
                  <Field label="When" value={formatDate(row.uploadedAt)} />
                  <Field label="Size" value={formatBytes(row.fileSizeBytes)} />
                  <Field label="Mode" value={row.gameMode} />
                  <Field label="Map" value={formatMapFile(row.mapFile)} />
                  <Field label="Turn" value={formatOptionalNumber(row.maxTurn)} />
                  <Field label="BBG" value={formatBbg(row)} />
                  <Field label="DL" value={formatOptionalNumber(row.downloadCount)} />
                  <Field label="Match" value={row.matchId} />
                </div>
                <Show when={formatLeaders(row.leadersJson)}>
                  <div class="mt-2 truncate text-xs text-fg-muted" title={formatLeaders(row.leadersJson) ?? undefined}>{formatLeaders(row.leadersJson)}</div>
                </Show>
              </article>
            )}
          </For>
        </div>

        <Show when={!loading() && !error() && filteredUploads().length === 0}>
          <div class="rounded-xl border border-border-subtle bg-bg-subtle/40 px-4 py-3 text-sm text-fg-muted">Empty</div>
        </Show>
      </div>
    </main>
  )
}

function Field(props: { label: string, value: string | null | undefined }) {
  return (
    <div class="min-w-0">
      <div class="text-[0.65rem] uppercase tracking-wide text-fg-muted/75">{props.label}</div>
      <div class="truncate text-fg">{props.value ?? '-'}</div>
    </div>
  )
}

function uniqueSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value != null && value.length > 0))]
    .sort((left, right) => left.localeCompare(right))
}

function buildExternalDownloadUrl(row: AutosaveUploadCatalogRow): string {
  const url = new URL(`/api/uploads/autosaves/${encodeURIComponent(row.id)}/download`, window.location.origin)
  const token = getActivitySessionToken()
  if (token) url.searchParams.set(CIVUP_ACTIVITY_SESSION_QUERY_PARAM, token)
  return url.toString()
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const kb = value / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

function formatOptionalNumber(value: number | null): string | null {
  return value == null ? null : String(value)
}

function formatBbg(row: AutosaveUploadCatalogRow): string | null {
  if (row.bbgVersion) return row.bbgVersion
  if (row.bbgDetected) return 'yes'
  return null
}

function formatMapFile(value: string | null): string | null {
  return value?.replace(/\.lua$/i, '') ?? null
}

function formatLeaders(value: string | null): string | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      const labels = parsed
        .map(item => typeof item === 'string'
          ? item
          : item && typeof item === 'object' && 'leader' in item && typeof item.leader === 'string'
            ? item.leader
            : null)
        .filter((item): item is string => item != null && item.length > 0)
      return labels.length > 0 ? labels.join(', ') : null
    }
  }
  catch {}
  return value
}
>>>>>>> Current commit: feat: catalog

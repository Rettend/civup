import { CIVUP_ACTIVITY_SESSION_QUERY_PARAM } from '@civup/utils'
import type { Leader } from '@civup/game'
import { betaLeaderDataVersionLabel, getLeaders, liveLeaderDataVersionLabel } from '@civup/game'
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
  playerName: string | null
  leaderName: string
  civilizationName: string | null
  portraitUrl: string | null
  searchText: string
}

interface DecoratedAutosaveUpload {
  row: AutosaveUploadCatalogRow
  bbgVersion: string | null
  bbgLabel: string | null
  leaders: CatalogLeaderCard[]
  searchText: string
}

type CatalogAction = 'delete' | 'reparse'

const CATALOG_LEADERS = dedupeCatalogLeaders([...getLeaders('beta'), ...getLeaders('live')])

export default function AutosaveCatalogPage() {
  const activity = useActivityController()
  const [uploads, setUploads] = createSignal<AutosaveUploadCatalogRow[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal('')
  const [modeFilter, setModeFilter] = createSignal('')
  const [leaderFilter, setLeaderFilter] = createSignal('')
  const [bbgFilter, setBbgFilter] = createSignal('')
  const [downloadingId, setDownloadingId] = createSignal<string | null>(null)
  const [pendingAction, setPendingAction] = createSignal<{ id: string, action: CatalogAction } | null>(null)
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

  const decoratedUploads = createMemo(() => uploads().map(row => decorateUpload(row)))
  const modeOptions = createMemo(() => uniqueSorted(decoratedUploads().map(item => item.row.gameMode)))
  const leaderOptions = createMemo(() => uniqueSorted(decoratedUploads().flatMap(item => item.leaders.map(leader => leader.leaderName))))
  const bbgOptions = createMemo(() => uniqueSorted(decoratedUploads().map(item => item.bbgVersion)))
  const filteredUploads = createMemo(() => {
    const query = normalizeSearchText(search())
    const mode = modeFilter()
    const leader = leaderFilter()
    const bbg = bbgFilter()
    return decoratedUploads().filter((item) => {
      const row = item.row
      if (mode && row.gameMode !== mode) return false
      if (leader && !item.leaders.some(candidate => candidate.leaderName === leader)) return false
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

  const reparseUpload = async (row: AutosaveUploadCatalogRow) => {
    await runCatalogAction(row, 'reparse')
  }

  const deleteUpload = async (row: AutosaveUploadCatalogRow) => {
    if (!window.confirm('Delete this autosave upload?')) return
    await runCatalogAction(row, 'delete')
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
      }
    }
    catch (err) {
      setError(err instanceof Error && err.message.trim().length > 0 ? err.message : 'Failed')
    }
    finally {
      setPendingAction(null)
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

        <div class="grid gap-3 rounded-xl border border-border-subtle bg-bg-subtle/40 p-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_8rem_10rem_8rem_auto]">
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
            Leader
            <select
              value={leaderFilter()}
              class="h-9 rounded-md border border-border-subtle bg-bg px-3 text-sm text-fg outline-none focus:border-border-hover"
              onChange={event => setLeaderFilter(event.currentTarget.value)}
            >
              <option value="">All</option>
              <For each={leaderOptions()}>{leader => <option value={leader}>{leader}</option>}</For>
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
            {item => {
              const row = item.row
              const action = () => pendingAction()
              return (
              <article class="rounded-xl border border-border-subtle bg-bg-subtle/45 p-3">
                <div class="mb-3 flex items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                      <Show when={row.gameMode}>
                        <span class="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-bold text-accent">{row.gameMode}</span>
                      </Show>
                      <Show when={row.maxTurn != null}>
                        <span class="rounded-full border border-border-subtle bg-bg px-2 py-0.5 text-xs font-bold text-fg">T{row.maxTurn}</span>
                      </Show>
                    </div>
                    <div class="mt-1 truncate text-xs text-fg-muted">
                      {formatDate(row.uploadedAt)} by {row.uploaderDisplayName ?? row.uploaderUserId}
                    </div>
                  </div>
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
                  <Field label="Size" value={formatBytes(row.fileSizeBytes)} />
                  <Field label="Saves" value={formatOptionalNumber(row.saveCount)} />
                </div>
                <div class="mt-3 flex flex-wrap gap-1.5">
                  <Show when={item.bbgLabel}>
                    <MetaPill value={item.bbgLabel} />
                  </Show>
                  <Show when={row.downloadCount > 0}>
                    <MetaPill value={formatDownloadCount(row.downloadCount)} />
                  </Show>
                  <Show when={row.matchId}>
                    <MetaPill value="Match" title={row.matchId ?? undefined} />
                  </Show>
                  <Show when={row.parseStatus !== 'parsed'}>
                    <MetaPill value={formatParseStatus(row)} tone={row.parseStatus === 'parse_failed' ? 'danger' : 'muted'} title={row.parseError ?? undefined} />
                  </Show>
                </div>
                <Show when={item.leaders.length > 0}>
                  <div class="mt-3 grid gap-2">
                    <For each={item.leaders}>{leader => <LeaderCard leader={leader} />}</For>
                  </div>
                </Show>
                <div class="mt-3 flex justify-end gap-2 border-t border-border-subtle/60 pt-3">
                  <button
                    type="button"
                    class="rounded-md border border-border-subtle px-2 py-1 text-xs font-semibold text-fg-muted transition hover:border-border-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50"
                    disabled={action() != null}
                    onClick={() => void reparseUpload(row)}
                  >
                    {action()?.id === row.id && action()?.action === 'reparse' ? '...' : 'Reparse'}
                  </button>
                  <button
                    type="button"
                    class="rounded-md border border-danger/30 px-2 py-1 text-xs font-semibold text-danger transition hover:border-danger/60 hover:bg-danger/10 disabled:pointer-events-none disabled:opacity-50"
                    disabled={action() != null}
                    onClick={() => void deleteUpload(row)}
                  >
                    {action()?.id === row.id && action()?.action === 'delete' ? '...' : 'Delete'}
                  </button>
                </div>
              </article>
              )
            }}
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

function MetaPill(props: { value: string | null | undefined, tone?: 'muted' | 'danger', title?: string }) {
  const toneClass = () => props.tone === 'danger'
    ? 'border-danger/30 bg-danger/10 text-danger'
    : 'border-border-subtle bg-bg text-fg-muted'

  return <span class={`rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold ${toneClass()}`} title={props.title}>{props.value}</span>
}

function LeaderCard(props: { leader: CatalogLeaderCard }) {
  const initial = () => props.leader.leaderName.slice(0, 1).toUpperCase() || '?'

  return (
    <div class="flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle/70 bg-bg/55 p-2">
      <Show
        when={props.leader.portraitUrl}
        fallback={<div class="grid size-9 shrink-0 place-items-center rounded-full border border-border-subtle bg-bg-muted text-xs font-bold text-fg-muted">{initial()}</div>}
      >
        <img
          src={props.leader.portraitUrl ?? ''}
          alt=""
          class="size-9 shrink-0 rounded-full object-cover"
          loading="lazy"
        />
      </Show>
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-fg">{props.leader.playerName ?? props.leader.leaderName}</div>
        <div class="truncate text-[0.68rem] text-fg-muted">
          <Show when={props.leader.playerName} fallback={props.leader.civilizationName ?? ''}>
            {props.leader.leaderName}{props.leader.civilizationName ? `, ${props.leader.civilizationName}` : ''}
          </Show>
        </div>
      </div>
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

function formatDownloadCount(value: number): string {
  return value === 1 ? '1 Download' : `${value} Downloads`
}

function decorateUpload(row: AutosaveUploadCatalogRow): DecoratedAutosaveUpload {
  const bbgVersion = resolveBbgVersion(row)
  const bbgLabel = bbgVersion ? `BBG ${bbgVersion}` : null
  const leaders = resolveLeaderCards(row)
  const searchText = normalizeSearchText([
    row.uploaderDisplayName,
    row.uploaderUserId,
    row.matchId,
    row.gameMode,
    bbgVersion,
    ...leaders.map(leader => leader.searchText),
  ].filter((value): value is string => value != null && value.length > 0).join(' '))

  return { row, bbgVersion, bbgLabel, leaders, searchText }
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
    playerName,
    leaderName,
    civilizationName,
    portraitUrl: leader?.portraitUrl ?? null,
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

  const nameTokens = tokenizeSearchText(shortLeaderName)
  return nameTokens.size > 0 && [...nameTokens].every(token => codeTokens.has(token))
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

function formatParseStatus(row: AutosaveUploadCatalogRow): string {
  if (row.parseStatus === 'parse_failed') return 'Parse failed'
  if (row.parseStatus === 'pending') return 'Parsing'
  return row.parseStatus
}

function formatLeaderCode(value: string | null): string {
  if (!value) return 'Unknown leader'
  let normalized = value.replace(/^LEADER_/i, '')
  if (/^LIME_[A-Z0-9]+_/i.test(normalized)) normalized = normalized.replace(/^LIME_[A-Z0-9]+_/i, '')
  return titleCaseWords(normalized.replace(/_/g, ' '))
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

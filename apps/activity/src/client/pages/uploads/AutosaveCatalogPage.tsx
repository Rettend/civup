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

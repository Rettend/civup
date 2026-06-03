export interface AvatarImageSource {
  playerId: string | null
  displayName: string
  avatarUrl: string | null
}

const DEFAULT_AVATAR_FETCH_CONCURRENCY = 4
const MAX_INLINE_IMAGE_BYTES = 512_000

export function avatarKey(player: AvatarImageSource): string {
  return player.playerId ?? player.displayName
}

export async function loadAvatarDataUris(
  players: readonly AvatarImageSource[],
  options: {
    concurrency?: number
  } = {},
): Promise<Map<string, string>> {
  const byUrl = new Map<string, Set<string>>()

  for (const player of players) {
    const key = avatarKey(player)
    if (!key || !player.avatarUrl) continue

    const url = normalizeDiscordImageUrl(player.avatarUrl)
    const keys = byUrl.get(url) ?? new Set<string>()
    keys.add(key)
    byUrl.set(url, keys)
  }

  if (byUrl.size === 0) return new Map()

  const result = new Map<string, string>()
  const concurrency = normalizeConcurrency(options.concurrency ?? DEFAULT_AVATAR_FETCH_CONCURRENCY)
  await mapLimit([...byUrl.entries()], concurrency, async ([url, keys]) => {
    const uri = await fetchDiscordImageDataUri(url).catch(() => null)
    if (!uri) return
    for (const key of keys) result.set(key, uri)
  })

  return result
}

export async function fetchDiscordImageDataUri(url: string): Promise<string | null> {
  const response = await fetch(normalizeDiscordImageUrl(url))
  if (!response.ok) return null
  const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES) return null
  return `data:${contentType};base64,${base64Encode(bytes)}`
}

function normalizeDiscordImageUrl(url: string): string {
  return url.replace(/\.gif($|\?)/, '.png$1')
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AVATAR_FETCH_CONCURRENCY
  return Math.max(1, Math.round(value))
}

async function mapLimit<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++]
      if (item !== undefined) await task(item)
    }
  })
  await Promise.all(workers)
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!)
  return btoa(binary)
}

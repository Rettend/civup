import type { Leader, LeaderDataVersion } from '@civup/game'
import { getLeader } from '@civup/game'
import { resolveAssetUrl } from './asset-url'

const MAX_CONCURRENT_PRELOADS = 4

type PreloadStatus = 'queued' | 'loading' | 'loaded' | 'failed'

const preloadStatuses = new Map<string, PreloadStatus>()
const preloadQueue: string[] = []
const activePreloadImages = new Set<HTMLImageElement>()

export function getLeaderFullPortraitUrl(leader: Pick<Leader, 'id' | 'fullPortraitUrl'>): string {
  const url = leader.fullPortraitUrl ?? `/assets/leaders-full/${leader.id}.webp`
  return resolveAssetUrl(url) ?? url
}

export function preloadLeaderFullPortraitIds(leaderIds: Iterable<string>, leaderDataVersion: LeaderDataVersion): void {
  for (const leaderId of leaderIds) {
    try { preloadLeaderFullPortraitUrl(getLeaderFullPortraitUrl(getLeader(leaderId, leaderDataVersion))) }
    catch { }
  }
}

function preloadLeaderFullPortraitUrl(url: string): void {
  const status = preloadStatuses.get(url)
  if (status === 'queued' || status === 'loading' || status === 'loaded') return

  preloadStatuses.set(url, 'queued')
  preloadQueue.push(url)
  startQueuedPreloads()
}

function startQueuedPreloads(): void {
  if (typeof Image === 'undefined') return

  while (activePreloadImages.size < MAX_CONCURRENT_PRELOADS) {
    const url = preloadQueue.shift()
    if (!url) return
    if (preloadStatuses.get(url) !== 'queued') continue

    preloadStatuses.set(url, 'loading')

    const image = new Image()
    activePreloadImages.add(image)
    image.decoding = 'async'
    const preloadImage = image as HTMLImageElement & { fetchPriority?: string }
    preloadImage.fetchPriority = 'low'

    const finish = (status: PreloadStatus) => {
      image.onload = null
      image.onerror = null
      activePreloadImages.delete(image)
      preloadStatuses.set(url, status)
      startQueuedPreloads()
    }

    image.onload = () => {
      const decode = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
      void decode.catch(() => undefined).finally(() => finish('loaded'))
    }
    image.onerror = () => finish('failed')
    image.src = url
  }
}

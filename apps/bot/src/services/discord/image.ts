import { initWasm, Resvg } from '@resvg/resvg-wasm'
import interFontAsset from '@fontsource-variable/inter/files/inter-latin-ext-standard-normal.woff2'
import resvgWasmAsset from '@resvg/resvg-wasm/index_bg.wasm'

let resvgInitPromise: Promise<void> | null = null
let fontBuffersPromise: Promise<Uint8Array[]> | null = null

export async function renderSvgToPng(svg: string): Promise<Uint8Array> {
  await ensureResvgReady()

  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: await getFontBuffers(),
      defaultFontFamily: 'Inter Variable',
      sansSerifFamily: 'Inter Variable',
      serifFamily: 'Inter Variable',
      monospaceFamily: 'Inter Variable',
    },
  })

  try {
    await resolveExternalImages(resvg)
    const rendered = resvg.render()
    try {
      return Uint8Array.from(rendered.asPng())
    }
    finally {
      rendered.free()
    }
  }
  finally {
    resvg.free()
  }
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

export function sanitizeAvatarRenderUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    if (url.pathname.endsWith('.gif')) {
      url.pathname = url.pathname.replace(/\.gif$/i, '.png')
    }
    url.searchParams.set('size', '128')
    return url.toString()
  }
  catch {
    return trimmed
  }
}

export function initialsForDisplayName(displayName: string): string {
  const parts = displayName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 1)}…`
}

async function ensureResvgReady(): Promise<void> {
  if (!resvgInitPromise) {
    resvgInitPromise = (async () => {
      await initWasm(await loadBinaryAsset(resvgWasmAsset))
    })()
  }

  await resvgInitPromise
}

async function getFontBuffers(): Promise<Uint8Array[]> {
  if (!fontBuffersPromise) {
    fontBuffersPromise = (async () => [await loadBinaryAsset(interFontAsset)])()
  }

  return await fontBuffersPromise
}

async function resolveExternalImages(resvg: InstanceType<typeof Resvg>): Promise<void> {
  const pending = resvg
    .imagesToResolve()
    .filter((href): href is string => typeof href === 'string' && href.length > 0)

  if (pending.length === 0) return

  const uniqueHrefs = [...new Set(pending)]
  const resolvedBuffers = await Promise.all(uniqueHrefs.map(async (href) => {
    try {
      return { href, buffer: await loadBinaryAsset(href) }
    }
    catch (error) {
      console.warn(`Failed to resolve SVG image ${href}:`, error)
      return null
    }
  }))

  for (const resolved of resolvedBuffers) {
    if (!resolved) continue
    resvg.resolveImage(resolved.href, resolved.buffer)
  }
}

async function loadBinaryAsset(asset: string): Promise<Uint8Array> {
  const bunRuntime = globalThis as typeof globalThis & {
    Bun?: {
      file: (path: string) => { arrayBuffer: () => Promise<ArrayBuffer> }
    }
  }

  if (typeof bunRuntime.Bun !== 'undefined' && looksLikeFilePath(asset)) {
    return new Uint8Array(await bunRuntime.Bun.file(asset).arrayBuffer())
  }

  const target = looksLikeAbsoluteUrl(asset) ? asset : new URL(asset, import.meta.url)
  const response = await fetch(target)
  if (!response.ok) {
    throw new Error(`Failed to load asset ${String(target)}: ${response.status}`)
  }

  return new Uint8Array(await response.arrayBuffer())
}

function looksLikeAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function looksLikeFilePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\')
    || value.startsWith('/')
}

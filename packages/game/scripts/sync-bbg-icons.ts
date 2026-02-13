/* eslint-disable no-console */
import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { api } from '@civup/utils'

const DEFAULT_SOURCE_URL = 'https://raw.githubusercontent.com/civ6bbg/civ6bbg.github.io/main/en_US/leaders_7.3.html'
const ICONS_OUTPUT_DIR = resolve(import.meta.dir, '../../../apps/activity/public/assets/bbg/icons')
const ITEMS_OUTPUT_DIR = resolve(import.meta.dir, '../../../apps/activity/public/assets/bbg/items')
const LEADERS_OUTPUT_DIR = resolve(import.meta.dir, '../../../apps/activity/public/assets/bbg/leaders')

async function main(): Promise<void> {
  const sourceUrl = process.argv[2] ?? DEFAULT_SOURCE_URL
  const html = await api.get<string>(sourceUrl, { parse: 'text' })
  const imagePaths = extractImagePaths(html)
  const iconPaths = imagePaths.filter(path => path.startsWith('/images/ICON_'))
  const itemPaths = imagePaths.filter(path => path.startsWith('/images/items/'))
  const leaderPaths = imagePaths.filter(path => path.startsWith('/images/leaders/'))
  const missingAssets: string[] = []

  await mkdir(ICONS_OUTPUT_DIR, { recursive: true })
  await mkdir(ITEMS_OUTPUT_DIR, { recursive: true })
  await mkdir(LEADERS_OUTPUT_DIR, { recursive: true })

  for (const path of iconPaths) {
    const downloaded = await downloadAsset(path, ICONS_OUTPUT_DIR)
    if (!downloaded) missingAssets.push(path)
  }

  for (const path of itemPaths) {
    const downloaded = await downloadAsset(path, ITEMS_OUTPUT_DIR)
    if (!downloaded) {
      await writeFallbackItemAsset(path)
      missingAssets.push(`${path} (fallback)`)
    }
  }

  for (const path of leaderPaths) {
    const downloaded = await downloadAsset(path, LEADERS_OUTPUT_DIR)
    if (!downloaded) missingAssets.push(path)
  }

  console.log(`Synced ${iconPaths.length} stat icons to ${ICONS_OUTPUT_DIR}`)
  console.log(`Synced ${itemPaths.length} unit/building icons to ${ITEMS_OUTPUT_DIR}`)
  console.log(`Synced ${leaderPaths.length} leader portraits to ${LEADERS_OUTPUT_DIR}`)
  if (missingAssets.length > 0) {
    console.warn(`Skipped ${missingAssets.length} missing BBG assets:`)
    for (const missingAsset of missingAssets) console.warn(`- ${missingAsset}`)
  }
}

function extractImagePaths(html: string): string[] {
  const imageRe = /<img[^>]*\ssrc=(["'])([^"']*)\1[^>]*>/gi
  const imagePaths = new Set<string>()

  let match: RegExpExecArray | null = imageRe.exec(html)
  while (match) {
    const src = (match[2] ?? '').trim()
    if (src.startsWith('/images/ICON_') || src.startsWith('/images/items/') || src.startsWith('/images/leaders/')) {
      imagePaths.add(src)
    }
    match = imageRe.exec(html)
  }

  return [...imagePaths].sort((a, b) => a.localeCompare(b))
}

async function downloadAsset(relativePath: string, outputDirectory: string): Promise<boolean> {
  const fileName = decodeURIComponent(relativePath.split('/').pop() ?? '')
  if (fileName.length === 0) return false

  const assetUrl = new URL(relativePath, 'https://civ6bbg.github.io')
  const response = await fetch(assetUrl)
  if (!response.ok) return false

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(resolve(outputDirectory, fileName), buffer)
  return true
}

async function writeFallbackItemAsset(relativePath: string): Promise<void> {
  const fileName = decodeURIComponent(relativePath.split('/').pop() ?? '')
  if (fileName.length === 0) return

  const response = await fetch('https://civ6bbg.github.io/images/civVI.webp')
  if (!response.ok) return

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(resolve(ITEMS_OUTPUT_DIR, fileName), buffer)
}

void main()

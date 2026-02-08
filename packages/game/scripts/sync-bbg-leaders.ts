/* eslint-disable no-console */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const DEFAULT_SOURCE_URL = 'https://raw.githubusercontent.com/civ6bbg/civ6bbg.github.io/main/en_US/leaders_7.3.html'
const OUTPUT_PATH = resolve(import.meta.dir, '../src/leaders.ts')

interface ParsedEntry {
  locKey: string
  name: string
  description: string
  iconUrl?: string
}

interface GeneratedLeader {
  id: string
  name: string
  civilization: string
  portraitUrl?: string
  ability: {
    name: string
    description: string
  }
  uniqueUnits: Array<{
    name: string
    description: string
    replaces?: string
    iconUrl?: string
  }>
  uniqueBuilding?: {
    name: string
    description: string
    replaces?: string
    iconUrl?: string
  }
  uniqueImprovement?: {
    name: string
    description: string
    replaces?: string
    iconUrl?: string
  }
  tags: string[]
}

const nameOverrideByRowId: Record<string, { civilization: string, name: string }> = {
  'Gran Colombia Simón Bolívar': { civilization: 'Gran Colombia', name: 'Simon Bolivar' },
  'Māori Kupe': { civilization: 'Maori', name: 'Kupe' },
  'Ottomans Suleiman (Muhteşem)': { civilization: 'Ottomans', name: 'Suleiman (Muhtesem)' },
  'Portugal João III': { civilization: 'Portugal', name: 'Joao III' },
  'Swahili Al-Hasan ibn Sulaiman': { civilization: 'Swahili', name: 'Al-Hasan ibn Sulaiman' },
  'Thule Kiviuq': { civilization: 'Thule', name: 'Kiviuq' },
  'Tibet Trisong Detsen': { civilization: 'Tibet', name: 'Trisong Detsen' },
  'Teotihuacán Spearthrower Owl': { civilization: 'Teotihuacan', name: 'Spearthrower Owl' },
  'Maya Te\' K\'inich II': { civilization: 'Maya', name: 'Te\' K\'inich II' },
  'Vietnam Bà Triệu': { civilization: 'Vietnam', name: 'Ba Trieu' },
}

const civilizationKeyOverrides: Record<string, string> = {
  BABYLON_STK: 'Babylon',
  LIME_THULE: 'Thule',
  OTTOMAN: 'Ottomans',
  SUK_SWAHILI: 'Swahili',
  SUK_TIBET: 'Tibet',
}

async function main(): Promise<void> {
  const sourceUrl = process.argv[2] ?? DEFAULT_SOURCE_URL
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`Failed to fetch leaders page: ${sourceUrl} (${response.status})`)

  const html = await response.text()
  const leaders = parseLeaders(html)
  if (leaders.length === 0) throw new Error('Parsed 0 leaders from source HTML')

  const output = renderLeadersTs(leaders, sourceUrl)
  await writeFile(OUTPUT_PATH, output, 'utf8')

  console.log(`Wrote ${leaders.length} leaders to ${OUTPUT_PATH}`)
}

function parseLeaders(html: string): GeneratedLeader[] {
  const rowRe = /<div class="row" id="([^"]+)">/g
  const rows: Array<{ rowId: string, body: string }> = []

  let match: RegExpExecArray | null = rowRe.exec(html)
  while (match) {
    const rowId = decodeEntities(match[1] ?? '').trim()
    const bodyStart = rowRe.lastIndex
    const nextMatch = rowRe.exec(html)
    const bodyEnd = nextMatch ? nextMatch.index : html.length
    rows.push({ rowId, body: html.slice(bodyStart, bodyEnd) })
    match = nextMatch
  }

  const leaders: GeneratedLeader[] = []
  for (const row of rows) {
    const leader = parseLeaderRow(row.rowId, row.body)
    if (leader) leaders.push(leader)
  }

  return leaders
}

function parseLeaderRow(rowId: string, body: string): GeneratedLeader | null {
  const override = nameOverrideByRowId[rowId]
  const civilizationKey = body.match(/<!--\s*LOC_CIVILIZATION_([A-Z0-9_]+)_NAME\s+LOC_LEADER_[^>]+-->/)?.[1]
  const civilization = override?.civilization
    ?? (civilizationKey ? civilizationKeyOverrides[civilizationKey] ?? keyToTitle(civilizationKey) : rowId.split(' ')[0] ?? rowId)

  const name = override?.name ?? stripCivilizationPrefix(rowId, civilization)
  const id = slugify(`${civilization} ${name}`)

  const portraitSrc = body.match(/<h2 class="civ-name">[\s\S]*?<img[^>]+src="([^"]+)"/i)?.[1]
  const portraitUrl = portraitSrc ? toLocalBbgAssetUrl(portraitSrc) : undefined

  const entries = parseEntries(body)
  if (entries.length === 0) return null

  const leaderTrait = entries.find(e => isLeaderTrait(e.locKey))
  const civilizationTrait = entries.find(e => isCivilizationTrait(e.locKey))
  const abilityEntry = leaderTrait ?? civilizationTrait ?? entries[0]
  if (!abilityEntry) return null

  const uniqueUnits = entries
    .filter(e => e.locKey.startsWith('LOC_UNIT_'))
    .map(e => ({
      name: e.name,
      description: e.description,
      replaces: extractReplaces(e.description),
      iconUrl: e.iconUrl,
    }))

  const uniqueBuildingEntry = entries.find(e => e.locKey.startsWith('LOC_BUILDING_') || e.locKey.startsWith('LOC_DISTRICT_'))
  const uniqueBuilding = uniqueBuildingEntry
    ? {
        name: uniqueBuildingEntry.name,
        description: uniqueBuildingEntry.description,
        replaces: extractReplaces(uniqueBuildingEntry.description),
        iconUrl: uniqueBuildingEntry.iconUrl,
      }
    : undefined

  const uniqueImprovementEntry = entries.find(e => e.locKey.startsWith('LOC_IMPROVEMENT_'))
  const uniqueImprovement = uniqueImprovementEntry
    ? {
        name: uniqueImprovementEntry.name,
        description: uniqueImprovementEntry.description,
        replaces: extractReplaces(uniqueImprovementEntry.description),
        iconUrl: uniqueImprovementEntry.iconUrl,
      }
    : undefined

  return {
    id,
    name,
    civilization,
    portraitUrl,
    ability: {
      name: abilityEntry.name,
      description: abilityEntry.description,
    },
    uniqueUnits,
    uniqueBuilding,
    uniqueImprovement,
    tags: [],
  }
}

function parseEntries(body: string): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  const entryRe = /<!--\s*(LOC_[A-Z0-9_]+)\s*-->\s*<h3 class="civ-ability-name"[^>]*>([\s\S]*?)<\/h3>\s*(?:<br>\s*)?<!--\s*(LOC_[A-Z0-9_]+)\s*-->\s*<p class="civ-ability-desc actual-text"[^>]*>([\s\S]*?)<\/p>/g

  let match: RegExpExecArray | null = entryRe.exec(body)
  while (match) {
    const nameHtml = match[2] ?? ''
    const descriptionHtml = match[4] ?? ''
    const iconSrc = extractFirstImageSrc(nameHtml)

    const nameLoc = (match[1] ?? '').trim()
    const name = normalizeTitle(nameHtml)
    const description = normalizeDescription(descriptionHtml)

    entries.push({
      locKey: nameLoc,
      name,
      description,
      iconUrl: iconSrc ? toLocalBbgAssetUrl(iconSrc) : undefined,
    })
    match = entryRe.exec(body)
  }

  return entries
}

function normalizeTitle(value: string): string {
  const withoutImages = value.replace(/<img[^>]*>/gi, ' ')
  const withoutTags = withoutImages.replace(/<[^>]*>/g, ' ')
  const decoded = decodeEntities(withoutTags)

  return decoded
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeDescription(value: string): string {
  const withIconTokens = value.replace(/<img[^>]*\ssrc=(["'])([^"']*)\1[^>]*>/gi, (_, __: string, src: string) => {
    const token = iconTokenFromSrc(src)
    return token ? ` :${token}: ` : ' '
  })

  const withLineBreaks = withIconTokens.replace(/<br\s*(?:\/\s*)?>/gi, ' ')
  const withoutTags = withLineBreaks.replace(/<[^>]*>/g, ' ')
  const decoded = decodeEntities(withoutTags)

  return decoded
    .replace(/\u2022/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractFirstImageSrc(value: string): string | undefined {
  return value.match(/<img[^>]*\ssrc=(["'])([^"']*)\1[^>]*>/i)?.[2]
}

function iconTokenFromSrc(src: string): string | undefined {
  const filename = decodeEntities(src)
    .split('/')
    .pop()
    ?.replace(/\.[a-z0-9]+$/i, '')

  if (!filename?.startsWith('ICON_')) return undefined
  return filename.slice(5).toLowerCase()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function keyToTitle(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ')
}

function stripCivilizationPrefix(rowId: string, civilization: string): string {
  const rowWords = rowId.trim().split(/\s+/)
  const civWords = civilization.trim().split(/\s+/)
  if (rowWords.length <= civWords.length) return rowId

  const rowPrefix = rowWords.slice(0, civWords.length).join(' ')
  if (normalizeCompareText(rowPrefix) !== normalizeCompareText(civilization)) return rowId

  return rowWords.slice(civWords.length).join(' ')
}

function normalizeCompareText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

function isLeaderTrait(locKey: string): boolean {
  if (locKey.startsWith('LOC_LEADER_')) return true
  return locKey.startsWith('LOC_TRAIT_') && !locKey.includes('_CIVILIZATION_')
}

function isCivilizationTrait(locKey: string): boolean {
  return locKey.startsWith('LOC_TRAIT_') && locKey.includes('_CIVILIZATION_')
}

function extractReplaces(description: string): string | undefined {
  const match = description.match(/replaces (?:the )?([^.,;|]+?)(?: when| that| and|\. |[,;|]|$)/i)
  if (!match?.[1]) return undefined

  const replaces = match[1].trim()
  return replaces.length > 0 ? replaces : undefined
}

function toAbsoluteAssetUrl(relativePath: string): string {
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) return relativePath
  return encodeURI(`https://civ6bbg.github.io${relativePath}`)
}

function toLocalBbgAssetUrl(relativePath: string): string {
  if (relativePath.startsWith('/images/ICON_')) {
    const filename = decodeEntities(relativePath).split('/').pop()
    if (filename) return encodeURI(`/assets/bbg/icons/${filename}`)
  }

  if (relativePath.startsWith('/images/items/')) {
    const filename = decodeEntities(relativePath).split('/').pop()
    if (filename) return encodeURI(`/assets/bbg/items/${filename}`)
  }

  if (relativePath.startsWith('/images/leaders/')) {
    const filename = decodeEntities(relativePath).split('/').pop()
    if (filename) return encodeURI(`/assets/bbg/leaders/${filename}`)
  }

  return toAbsoluteAssetUrl(relativePath)
}

function renderLeadersTs(leaders: GeneratedLeader[], sourceUrl: string): string {
  const data = JSON.stringify(leaders, null, 2)
  return `import type { Leader } from './types.ts'\n\n/**\n * Leader data synced from BBG website.\n *\n * Source: ${sourceUrl}\n * Generated by: packages/game/scripts/sync-bbg-leaders.ts\n */\nexport const leaders: Leader[] = ${data}\n\n/** Map of leader ID to leader data for quick lookup */\nexport const leaderMap = new Map<string, Leader>(\n  leaders.map(l => [l.id, l]),\n)\n\n/** All leader IDs (the default civ pool) */\nexport const allLeaderIds = leaders.map(l => l.id)\n\n/** Get a leader by ID, throws if not found */\nexport function getLeader(id: string): Leader {\n  const leader = leaderMap.get(id)\n  if (!leader) throw new Error(\`Leader not found: \${id}\`)\n  return leader\n}\n\n/** Search leaders by name or civilization (case-insensitive) */\nexport function searchLeaders(query: string): Leader[] {\n  const q = query.toLowerCase()\n  return leaders.filter(l =>\n    l.name.toLowerCase().includes(q)\n    || l.civilization.toLowerCase().includes(q),\n  )\n}\n`
}

void main()

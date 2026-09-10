import type { Database } from '@civup/db'
import { seasons } from '@civup/db'
import { desc, eq, sql } from 'drizzle-orm'
import { getDisplaySeason } from './index.ts'

export type SeasonSelection = 'current' | 'all' | number

export class SeasonSelectionError extends Error {}

export async function seasonAutocompleteChoices(db: Database, input: string, allowAll = true) {
  const search = input.trim().toLowerCase()
  const aliases = [{ name: 'Current', value: 'current' }, ...(allowAll ? [{ name: 'All time', value: 'all' }] : [])]
    .filter(choice => choice.name.toLowerCase().includes(search))
  const available = await db.select({ number: seasons.seasonNumber }).from(seasons)
    .where(search ? sql`instr(lower('Season ' || ${seasons.seasonNumber}), ${search}) > 0` : undefined)
    .groupBy(seasons.seasonNumber).orderBy(desc(seasons.seasonNumber)).limit(25 - aliases.length)
  return [...aliases, ...available.map(season => ({ name: `Season ${season.number}`, value: String(season.number) }))]
}

export function parseSeasonSelection(raw?: string | null, allowAll = true): SeasonSelection {
  const value = raw?.trim().toLowerCase() || 'current'
  if (value === 'current') return 'current'
  if (value === 'all' && allowAll) return 'all'
  if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value)
  throw new Error(allowAll ? 'Choose Current, All time, or a positive season number.' : 'Choose Current or a positive season number.')
}

export async function resolveSeasonSelection(db: Database, selection: SeasonSelection) {
  if (selection === 'all') return { season: null, ratingSeason: await getDisplaySeason(db), label: 'All time', allTime: true }
  const season = selection === 'current'
    ? await getDisplaySeason(db)
    : (await db.select().from(seasons).where(eq(seasons.seasonNumber, selection)).orderBy(desc(seasons.startsAt)).limit(1))[0] ?? null
  if (typeof selection === 'number' && !season) throw new SeasonSelectionError(`Season ${selection} was not found.`)
  return { season, ratingSeason: season, label: season?.name ?? 'Current', allTime: false }
}

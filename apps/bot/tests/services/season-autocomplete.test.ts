import { expect, test } from 'bun:test'
import { seasons } from '@civup/db'
import { seasonAutocompleteChoices } from '../../src/services/season/selection.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('season suggestions list available seasons without typing and respect filtering and command support', async () => {
  const { db, sqlite } = await createTestDatabase()
  try {
    await db.insert(seasons).values(
      [8, 9].map(number => ({
        id: `s${number}`,
        seasonNumber: number,
        name: `Season ${number}`,
        startsAt: number,
        active: number === 9,
      })),
    )
    expect(await seasonAutocompleteChoices(db, '')).toEqual([
      { name: 'Current', value: 'current' },
      { name: 'All time', value: 'all' },
      { name: 'Season 9', value: '9' },
      { name: 'Season 8', value: '8' },
    ])
    expect((await seasonAutocompleteChoices(db, '', false)).map(choice => choice.value)).toEqual(['current', '9', '8'])
    expect(await seasonAutocompleteChoices(db, '8')).toEqual([{ name: 'Season 8', value: '8' }])
    expect(await seasonAutocompleteChoices(db, 'SEASON 9')).toEqual([{ name: 'Season 9', value: '9' }])
    expect(await seasonAutocompleteChoices(db, 'all', false)).toEqual([])
    await db.insert(seasons).values(
      Array.from({ length: 30 }, (_, index) => ({
        id: `future-${index}`,
        seasonNumber: index + 10,
        name: `Season ${index + 10}`,
        startsAt: index + 10,
      })),
    )
    expect(await seasonAutocompleteChoices(db, '')).toHaveLength(25)
    expect(await seasonAutocompleteChoices(db, '8')).toContainEqual({ name: 'Season 8', value: '8' })
  } finally {
    sqlite.close()
  }
})

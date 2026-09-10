import { expect, test } from 'bun:test'
import { PUBLIC_RATING_BANDS, rankDivisionLayout } from '@civup/rating'
import { rankedPreviewEmbeds } from '../../src/embeds/ranked-preview.ts'
import { getConfiguredDivisionLabel, updateRankedRoleConfig } from '../../src/services/ranked/roles.ts'
import { createTestKv } from '../helpers/test-env.ts'

test('the admin role configuration supplies ladder names without changing numeric divisions or reusing another guild labels', async () => {
  const kv = createTestKv()
  for (const [guild, names] of [
    ['one', ['Champion', 'Diamond', 'Gold', 'Silver', 'Bronze']],
    ['two', ['Admiral', 'Captain', 'Officer', 'Cadet', 'Recruit']],
  ] as const) {
    const ids = names.map((_, index) => `10000000000000000${index}`)
    const config = await updateRankedRoleConfig(kv, guild, { tierRoleIdsByRank: ids }, new Map(names.map((name, index) => [ids[index]!, { name, color: '#123456' }])))
    expect(getConfiguredDivisionLabel(config, 0)).toBe(names[4])
    expect(getConfiguredDivisionLabel(config, 600)).toBe(`${names[3]} III`)
    expect(getConfiguredDivisionLabel(config, 700)).toBe(`${names[3]} II`)
    expect(getConfiguredDivisionLabel(config, 800)).toBe(`${names[3]} I`)
    expect(getConfiguredDivisionLabel(config, 1500)).toBe(names[0])
    config.divisionPolicy = { version: 'best-mode-quality-v1', roleIdsByMinimum: { 600: '200000000000000001' } }
    const [embed] = rankedPreviewEmbeds({ guildId: guild, ratingSystem: 'rp', evaluatedAt: 0, config, bands: [], modes: [], unrankedCount: 0, dirty: false })
    const fields = embed!.toJSON().fields!
    expect(fields.map(field => field.name)).toEqual([...names].reverse())
    expect(fields[1]!.value).toContain('<@&200000000000000001> 600–699 RP')
    expect(fields[1]!.value).toContain(`${names[3]} II`)
  }
  expect(PUBLIC_RATING_BANDS.map(band => band.minimum)).toEqual([0, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500])
})

test('only interior tiers receive three divisions regardless of the number of configured tiers', () => {
  for (const count of [3, 5, 7, 10]) {
    const layout = rankDivisionLayout(count)
    expect(layout.filter(band => band.tier === 'tier1')).toEqual([{ tier: 'tier1', division: 0 }])
    expect(layout.filter(band => band.tier === `tier${count}`)).toEqual([{ tier: `tier${count}`, division: 0 }])
    for (let tier = 2; tier < count; tier++) expect(layout.filter(band => band.tier === `tier${tier}`).map(band => band.division)).toEqual([3, 2, 1])
  }
})

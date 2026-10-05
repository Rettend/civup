import { expect, test } from 'bun:test'
import { playerDecayEmbed } from '../../src/embeds/decay.ts'

const day = 86_400_000
const now = 100 * day
const policy = { version: 'rp-decay-v1', enabledAt: 0 }
const season = { ratingSystem: 'rp', startsAt: 0, endsAt: null }
const bank = (days: number, active = true) => ({
  version: policy.version,
  bankUntil: now + days * day,
  checkedAt: now,
  active,
})

test('decay check distinguishes a full bank, a partial day, active decay, the floor and an untouched scope', () => {
  const embed = playerDecayEmbed({
    displayName: 'Selected player',
    avatarUrl: 'https://example.com/avatar.png',
    policy,
    season,
    now,
    ratings: [
      { mode: 'global', publicRating: 1600, publicDecay: bank(60) },
      { mode: 'duel', publicRating: 1580, publicDecay: bank(13.5) },
      { mode: 'duo', publicRating: 1540, publicDecay: bank(0) },
      { mode: 'squad', publicRating: 1500, publicDecay: bank(0, false) },
      { mode: 'ffa', publicRating: 900, publicDecay: null },
    ],
  })
  expect(embed.fields?.slice(0, 5).map(field => field.value)).toEqual([
    'Bank: 60/60 days',
    'Bank: 14/60 days',
    'Bank: 0/60 days ⚠️ `−2 RP/day`',
    'Bank: 0/60 days ⚠️',
    'No decay',
  ])
  expect(embed.footer).toEqual({ text: 'Selected player', icon_url: 'https://example.com/avatar.png' })
})

test('a never-rated player has no decay and hidden or unavailable ratings do not become public RP', () => {
  const input = { displayName: 'New player', ratings: [], policy, season, now }
  expect(
    playerDecayEmbed(input)
      .fields?.slice(0, 5)
      .every(field => field.value === 'No decay'),
  ).toBe(true)
  expect(playerDecayEmbed({ ...input, season: null }).fields?.some(field => field.name.includes(' RP'))).toBe(false)
})

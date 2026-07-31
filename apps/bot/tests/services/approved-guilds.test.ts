import { describe, expect, test } from 'bun:test'
import { getApprovedDiscordGuildIds, getLegacyPrimaryDiscordGuildId, isApprovedDiscordGuildId, resolveApprovedDiscordGuildConfiguration } from '@civup/utils'

describe('approved Discord guild config', () => {
  test('uses the singular setting as the migration primary while approving every configured guild', () => {
    const env = {
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
      ALLOWED_DISCORD_GUILD_IDS: '222222222222222222,333333333333333333',
    }
    expect(getApprovedDiscordGuildIds(env)).toEqual([
      '111111111111111111',
      '222222222222222222',
      '333333333333333333',
    ])
    expect(getLegacyPrimaryDiscordGuildId(env)).toBe('111111111111111111')
    expect(isApprovedDiscordGuildId('222222222222222222', env)).toBe(true)
    expect(isApprovedDiscordGuildId('999999999999999999', env)).toBe(false)
  })

  test('does not infer primary-only authority from the partner list', () => {
    expect(getLegacyPrimaryDiscordGuildId({
      ALLOWED_DISCORD_GUILD_IDS: '222222222222222222,333333333333333333',
    })).toBeNull()
  })

  test('rejects missing primary, empty plural, and malformed plural configuration', () => {
    expect(resolveApprovedDiscordGuildConfiguration({})).toEqual({ ok: false, error: 'primary guild ID is missing' })
    expect(resolveApprovedDiscordGuildConfiguration({
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
      ALLOWED_DISCORD_GUILD_IDS: ' ',
    })).toEqual({ ok: false, error: 'approved guild ID list is empty' })
    expect(resolveApprovedDiscordGuildConfiguration({
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
      ALLOWED_DISCORD_GUILD_IDS: '222222222222222222,invalid',
    })).toEqual({ ok: false, error: 'approved guild ID list is invalid' })
  })
})

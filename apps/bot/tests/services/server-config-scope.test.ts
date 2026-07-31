import { describe, expect, test } from 'bun:test'
import { getServerDraftTimerDefaults, setServerConfigValue } from '../../src/services/config/index.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('guild-scoped server config', () => {
  test('uses legacy global values only for the primary guild', async () => {
    const kv = createTestKv()
    await kv.put('config:ban_timer', '45')
    await setServerConfigValue(kv, 'ban_timer', '90', {
      guildId: '222222222222222222',
      legacyGuildId: '111111111111111111',
    })

    expect((await getServerDraftTimerDefaults(kv, {
      guildId: '111111111111111111',
      legacyGuildId: '111111111111111111',
    })).banTimerSeconds).toBe(45)
    expect((await getServerDraftTimerDefaults(kv, {
      guildId: '222222222222222222',
      legacyGuildId: '111111111111111111',
    })).banTimerSeconds).toBe(90)
    expect((await getServerDraftTimerDefaults(kv, {
      guildId: '333333333333333333',
      legacyGuildId: '111111111111111111',
    })).banTimerSeconds).toBe(180)
    expect((await getServerDraftTimerDefaults(kv, {
      guildId: '333333333333333333',
    })).banTimerSeconds).toBe(180)
  })

  test('keeps a primary scoped reset at the default instead of reviving the legacy value', async () => {
    const kv = createTestKv()
    await kv.put('config:ban_timer', '45')
    const scope = {
      guildId: '111111111111111111',
      legacyGuildId: '111111111111111111',
    }

    await setServerConfigValue(kv, 'ban_timer', '90', scope)
    await setServerConfigValue(kv, 'ban_timer', 'default', scope)

    expect((await getServerDraftTimerDefaults(kv, scope)).banTimerSeconds).toBe(180)
  })
})

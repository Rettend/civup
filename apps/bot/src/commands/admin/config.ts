import type { AdminCommandContext } from './types.ts'
import { getServerConfigRows, parseServerConfigKey, SERVER_CONFIG_KEYS, setServerConfigValue } from '../../services/config.ts'
import { sendTransientEphemeralResponse } from './shared.ts'

export function handleConfig(c: AdminCommandContext) {
  const rawKey = c.var.key
  const key = parseServerConfigKey(rawKey)
  const value = c.var.value

  if (rawKey && !key) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(c, `Unknown config key. Supported keys: ${SERVER_CONFIG_KEYS.map(item => `\`${item}\``).join(', ')}.`, 'error')
    })
  }

  if (!key) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      const rows = await getServerConfigRows(c.env.KV)
      await sendTransientEphemeralResponse(
        c,
        `**Available config keys:**\n${rows.map(row => `\`${row.key}\` = \`${row.value}\` — ${row.description}`).join('\n')}`,
        'info',
      )
    })
  }

  if (!value) {
    return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
      await sendTransientEphemeralResponse(
        c,
        'Provide both `key` and `value` to update config. Use `/admin config` with no arguments to list current values.',
        'error',
      )
    })
  }

  return c.flags('EPHEMERAL').resDefer(async (c: AdminCommandContext) => {
    const result = await setServerConfigValue(c.env.KV, key, value)
    if (!result.ok) {
      await sendTransientEphemeralResponse(c, result.error ?? 'Invalid config value.', 'error')
      return
    }
    await sendTransientEphemeralResponse(c, `\`${key}\` set to \`${result.value}\`.`, 'success')
  })
}

import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { command_ping } from '../../src/commands/ping.ts'
import { createDiscordApp } from '../../src/discord-app.ts'

const PRIMARY_GUILD_ID = '111111111111111111'
const DISALLOWED_GUILD_ID = '999999999999999999'

describe('approved Discord interaction guilds', () => {
  test('checks the guild only after accepting a valid Discord signature', async () => {
    const keys = createDiscordSigningKeys()
    const response = await createDiscordApp([command_ping]).fetch(signedInteractionRequest(keys.privateKey, {
      type: 2,
      guild_id: DISALLOWED_GUILD_ID,
      data: { id: '444444444444444444', name: 'ping', type: 1 },
    }), interactionEnv(keys.publicKeyHex))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 4,
      data: {
        flags: 64,
        content: 'This bot is only available in an approved Discord server.',
      },
    })
  })

  test('rejects an invalid signature before returning a guild guard response', async () => {
    const keys = createDiscordSigningKeys()
    const body = JSON.stringify(interactionPayload({
      type: 2,
      guild_id: DISALLOWED_GUILD_ID,
      data: { id: '444444444444444444', name: 'ping', type: 1 },
    }))
    const response = await createDiscordApp([command_ping]).fetch(new Request('https://bot.example.com/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': '00'.repeat(64),
        'X-Signature-Timestamp': '1',
      },
      body,
    }), interactionEnv(keys.publicKeyHex))

    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('approved Discord server')
  })
})

function createDiscordSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  return { privateKey, publicKeyHex: publicKeyBytes.toString('hex') }
}

function signedInteractionRequest(privateKey: ReturnType<typeof createDiscordSigningKeys>['privateKey'], interaction: Record<string, unknown>): Request {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify(interactionPayload(interaction))
  const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString('hex')
  return new Request('https://bot.example.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body,
  })
}

function interactionPayload(interaction: Record<string, unknown>) {
  return {
    id: '333333333333333333',
    application_id: '222222222222222222',
    token: 'interaction-token',
    version: 1,
    channel_id: '555555555555555555',
    member: {
      permissions: '0',
      roles: [],
      user: { id: '666666666666666666', username: 'Player' },
    },
    ...interaction,
  }
}

function interactionEnv(publicKey: string) {
  return {
    DISCORD_PUBLIC_KEY: publicKey,
    ALLOWED_DISCORD_GUILD_ID: PRIMARY_GUILD_ID,
  } as any
}

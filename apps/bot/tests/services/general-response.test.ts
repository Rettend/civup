import { describe, expect, test } from 'bun:test'
import { sendGeneralCommandResponse } from '../../src/services/response/general.ts'
import { setSystemChannel } from '../../src/services/system/channels.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('general command response routing', () => {
  test('posts in place when no bot-commands channel is configured', async () => {
    const kv = createTestKv()
    const followups: unknown[] = []
    const createMessageCalls: unknown[] = []

    await sendGeneralCommandResponse({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
      interaction: {
        guild_id: 'guild-1',
        channel_id: 'channel-1',
      },
      async followup(data?: unknown) {
        followups.push(data)
      },
    }, { content: 'hello world' }, {
      async createMessage(...args) {
        createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(createMessageCalls).toEqual([])
    expect(followups).toEqual([{ content: 'hello world' }])
  })

  test('redirects output into the configured bot-commands channel', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands')

    const followups: unknown[] = []
    const createMessageCalls: unknown[] = []

    await sendGeneralCommandResponse({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
      interaction: {
        guild_id: 'guild-1',
        channel_id: 'channel-1',
      },
      async followup(data?: unknown) {
        followups.push(data)
      },
    }, 'hello world', {
      async createMessage(...args) {
        createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(createMessageCalls).toEqual([[
      'token',
      'bot-commands',
      {
        content: 'hello world',
        allowed_mentions: { parse: [] },
      },
    ]])
    expect(followups).toEqual([{
      content: 'Posted in <#bot-commands>.',
      allowed_mentions: { parse: [] },
    }])
  })

  test('keeps output local when already used in the bot-commands channel', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands')

    const followups: unknown[] = []
    const createMessageCalls: unknown[] = []

    await sendGeneralCommandResponse({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
      interaction: {
        guild_id: 'guild-1',
        channel_id: 'bot-commands',
      },
      async followup(data?: unknown) {
        followups.push(data)
      },
    }, { content: 'hello world' }, {
      async createMessage(...args) {
        createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(createMessageCalls).toEqual([])
    expect(followups).toEqual([{ content: 'hello world' }])
  })

  test('falls back to the invoking channel when redirection fails', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands')

    const followups: unknown[] = []

    await sendGeneralCommandResponse({
      env: {
        KV: kv,
        DISCORD_TOKEN: 'token',
      },
      interaction: {
        guild_id: 'guild-1',
        channel_id: 'channel-1',
      },
      async followup(data?: unknown) {
        followups.push(data)
      },
    }, { content: 'hello world' }, {
      async createMessage() {
        throw new Error('boom')
      },
    })

    expect(followups).toEqual([{ content: 'hello world' }])
  })
})

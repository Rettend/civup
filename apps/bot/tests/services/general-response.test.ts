import { describe, expect, test } from 'bun:test'
import { resDeferGeneralCommandResponse } from '../../src/services/response/general.ts'
import { setSystemChannel } from '../../src/services/system/channels.ts'
import { createTestKv } from '../helpers/test-env.ts'

describe('general command response routing', () => {
  test('posts in place when no bot-commands channel is configured', async () => {
    const kv = createTestKv()
    const harness = createResponseHarness(kv, 'channel-1')

    await resDeferGeneralCommandResponse(harness.context, async () => ({ content: 'hello world' }), {
      async createMessage(...args) {
        harness.createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(harness.mode).toBe('normal')
    expect(harness.createMessageCalls).toEqual([])
    expect(harness.followups).toEqual([{ content: 'hello world', allowed_mentions: { parse: [] } }])
  })

  test('redirects output through an ephemeral deferred response', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands', 'guild-1')
    const harness = createResponseHarness(kv, 'channel-1')

    await resDeferGeneralCommandResponse(harness.context, async () => 'hello world', {
      async createMessage(...args) {
        harness.createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(harness.mode).toBe('ephemeral')
    expect(harness.createMessageCalls).toEqual([[
      'token',
      'bot-commands',
      {
        content: 'hello world',
        allowed_mentions: { parse: [] },
      },
    ]])
    expect(harness.followups).toHaveLength(1)
    expect((harness.followups[0] as { embeds: Array<{ toJSON: () => { description?: string } }> }).embeds[0]?.toJSON().description).toBe('Posted in <#bot-commands>.')
  })

  test('keeps output local when already used in the bot-commands channel', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands', 'guild-1')
    const harness = createResponseHarness(kv, 'bot-commands')

    await resDeferGeneralCommandResponse(harness.context, async () => ({ content: 'hello world' }), {
      async createMessage(...args) {
        harness.createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(harness.mode).toBe('normal')
    expect(harness.createMessageCalls).toEqual([])
    expect(harness.followups).toEqual([{ content: 'hello world', allowed_mentions: { parse: [] } }])
  })

  test('can force a local ephemeral response when redirect is configured', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands', 'guild-1')
    const harness = createResponseHarness(kv, 'channel-1')

    await resDeferGeneralCommandResponse(harness.context, async () => ({ content: 'hello world' }), {
      ephemeral: true,
      async createMessage(...args) {
        harness.createMessageCalls.push(args)
        return { id: 'message-1' }
      },
    })

    expect(harness.mode).toBe('ephemeral')
    expect(harness.createMessageCalls).toEqual([])
    expect(harness.followups).toEqual([{ content: 'hello world', allowed_mentions: { parse: [] } }])
  })

  test('shows an ephemeral error when redirected posting fails', async () => {
    const kv = createTestKv()
    await setSystemChannel(kv, 'commands', 'bot-commands', 'guild-1')
    const harness = createResponseHarness(kv, 'channel-1')

    await resDeferGeneralCommandResponse(harness.context, async () => ({ content: 'hello world' }), {
      async createMessage() {
        throw new Error('boom')
      },
    })

    expect(harness.mode).toBe('ephemeral')
    expect(harness.followups).toHaveLength(1)
    expect((harness.followups[0] as { embeds: Array<{ toJSON: () => { description?: string } }> }).embeds[0]?.toJSON().description).toBe('Failed to post in <#bot-commands>.')
  })
})

function createResponseHarness(kv: KVNamespace, channelId: string): {
  mode: 'normal' | 'ephemeral' | null
  createMessageCalls: unknown[][]
  followups: unknown[]
  context: {
    env: { KV: KVNamespace, DISCORD_TOKEN: string }
    interaction: { guild_id: string, channel_id: string }
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void }
    followup: (data?: unknown) => Promise<void>
    resDefer: (callback: (c: any) => Promise<void>) => Promise<Response>
    flags: (value: 'EPHEMERAL') => { resDefer: (callback: (c: any) => Promise<void>) => Promise<Response> }
  }
} {
  const followups: unknown[] = []
  const createMessageCalls: unknown[][] = []
  const state = {
    mode: null as 'normal' | 'ephemeral' | null,
    createMessageCalls,
    followups,
  }

  const deferredBase = {
    env: {
      KV: kv,
      DISCORD_TOKEN: 'token',
    },
    interaction: {
      guild_id: 'guild-1',
      channel_id: channelId,
    },
    executionCtx: {
      waitUntil() {},
    },
    async followup(data?: unknown) {
      followups.push(data)
    },
  }

  return Object.assign(state, {
    context: {
      ...deferredBase,
      async resDefer(callback) {
        state.mode = 'normal'
        await callback(deferredBase)
        return new Response(null)
      },
      flags(value) {
        expect(value).toBe('EPHEMERAL')
        return {
          async resDefer(callback) {
            state.mode = 'ephemeral'
            await callback(deferredBase)
            return new Response(null)
          },
        }
      },
    },
  })
}

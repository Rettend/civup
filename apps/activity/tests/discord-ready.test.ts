import { DiscordSDK, Events, RPCCloseCodes } from '@discord/embedded-app-sdk'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let sdk: DiscordSDK | undefined

beforeEach(() => {
  window.history.replaceState({}, '', '/?frame_id=synthetic-frame&instance_id=synthetic-instance&platform=desktop')
  vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  sdk = new DiscordSDK('synthetic-application', { disableConsoleLogOverride: true })
})

afterEach(() => {
  sdk?.close(RPCCloseCodes.CLOSE_NORMAL, 'Test complete')
  window.history.replaceState({}, '', '/')
})

function sendReady(avatar: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: 'https://discord.com',
      data: [
        1,
        {
          cmd: 'DISPATCH',
          evt: 'READY',
          nonce: null,
          data: {
            v: 1,
            config: { api_endpoint: '//discord.com/api', environment: 'production' },
            user: { id: 'synthetic-player', username: 'Player', discriminator: '0', avatar },
          },
        },
      ],
    }),
  )
}

test.each([null, undefined, 'synthetic-avatar'])('finishes the real SDK handshake with avatar %s', async avatar => {
  const onReady = vi.fn()
  await sdk!.subscribe(Events.READY, onReady)
  let ready = false
  const pending = sdk!.ready().then(() => {
    ready = true
  })
  sendReady(avatar)
  // Drain ready() and its continuation without hanging the test on a rejected frame.
  await Promise.resolve()
  await Promise.resolve()
  expect(onReady).toHaveBeenCalledOnce()
  expect(onReady.mock.calls[0]?.[0].user.avatar).toBe(avatar)
  expect(ready).toBe(true)
  expect(console.error).not.toHaveBeenCalled()
  await pending
})

test.each([42, { unexpected: true }])('still rejects an invalid avatar %j', async avatar => {
  const onReady = vi.fn()
  await sdk!.subscribe(Events.READY, onReady)
  sendReady(avatar)
  expect(onReady).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledWith(
    expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['data', 'user', 'avatar'] })]),
    }),
  )
  sendReady(null)
  expect(onReady).toHaveBeenCalledOnce()
})

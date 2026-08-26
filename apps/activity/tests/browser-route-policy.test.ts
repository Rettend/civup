import { describe, expect, test } from 'bun:test'
import { browserChannelPath, browserPracticePath, browserSessionPath, parseBrowserLaunchRoute, parseBrowserReturnPath, shouldWatchChannelFeed } from '../src/client/activity/route-policy'

describe('browser route policy', () => {
  test('parses only stable browser session and channel routes', () => {
    expect(parseBrowserLaunchRoute('/web/session/stable%2Fsession')).toEqual({ kind: 'session', sessionId: 'stable/session' })
    expect(parseBrowserLaunchRoute('/web/channel/123/')).toEqual({ kind: 'channel', channelId: '123' })
    expect(parseBrowserLaunchRoute('/draft/match-id')).toBeNull()
    expect(parseBrowserLaunchRoute('/web/uploads')).toBeNull()
  })

  test('builds a credential-free channel overview path', () => {
    expect(browserSessionPath('canonical/session')).toBe('/web/session/canonical%2Fsession')
    expect(browserChannelPath('channel/id')).toBe('/web/channel/channel%2Fid')
    const overviewPath = browserChannelPath('channel/id', 'session/id')
    expect(parseBrowserReturnPath(new URL(overviewPath, 'https://activity.example.com').search, 'session')).toBe('/web/session/session%2Fid')

    const practicePath = browserPracticePath('channel/id', 'session/id')
    expect(parseBrowserReturnPath(new URL(practicePath, 'https://activity.example.com').search, 'channel')).toBe(overviewPath)
  })

  test('rejects unsafe or mismatched browser return paths', () => {
    expect(parseBrowserReturnPath('?returnTo=https%3A%2F%2Fevil.example', 'session')).toBeNull()
    expect(parseBrowserReturnPath('?returnTo=%2F%2Fevil.example', 'session')).toBeNull()
    expect(parseBrowserReturnPath('?returnTo=%2Fweb%2Fchannel%2F123', 'session')).toBeNull()
    expect(parseBrowserReturnPath('?returnTo=%2Fweb%2Fsession%2F123%3Fevil%3D1', 'session')).toBeNull()
  })

  test('uses the channel feed for browser overview but not direct sessions', () => {
    expect(shouldWatchChannelFeed({ directSessionId: null, status: 'overview' })).toBe(true)
    expect(shouldWatchChannelFeed({ directSessionId: null, status: 'lobby-waiting' })).toBe(true)
    expect(shouldWatchChannelFeed({ directSessionId: 'session-1', status: 'overview' })).toBe(false)
    expect(shouldWatchChannelFeed({ directSessionId: 'session-1', status: 'lobby-waiting' })).toBe(false)
    expect(shouldWatchChannelFeed({ directSessionId: null, status: 'authenticated' })).toBe(false)
  })
})

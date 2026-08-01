import { describe, expect, test } from 'bun:test'
import { isEmbeddedDiscordLaunch, resolveRouteSurface } from '../src/client/route-surface'

describe('public and Activity route surface detection', () => {
  test('uses the Activity at root only for a complete framed Discord launch', () => {
    const valid = '?frame_id=frame-1&instance_id=instance-1&platform=desktop'
    expect(isEmbeddedDiscordLaunch(valid, true)).toBe(true)
    expect(resolveRouteSurface({ pathname: '/', search: valid, framed: true })).toBe('activity')
    expect(resolveRouteSurface({ pathname: '/', search: valid, framed: false })).toBe('public')
    expect(resolveRouteSurface({ pathname: '/', search: '?frame_id=frame-1&instance_id=instance-1&platform=unknown', framed: true })).toBe('public')
    expect(resolveRouteSurface({ pathname: '/', search: '?frame_id=&instance_id=instance-1&platform=mobile', framed: true })).toBe('public')
    expect(resolveRouteSurface({ pathname: '/', search: '?frame_id=one&frame_id=two&instance_id=instance-1&platform=desktop', framed: true })).toBe('public')
  })

  test('keeps known Activity routes and never initializes unknown production routes', () => {
    for (const pathname of ['/overview', '/uploads', '/lobby/one', '/draft/one', '/web/session/one', '/web/channel/one', '/practice', '/practice/great-people']) {
      expect(resolveRouteSurface({ pathname, search: '', framed: false })).toBe('activity')
    }
    for (const pathname of ['/leaderboards', '/rules', '/creators', '/unknown', '/draft', '/web/unknown/one']) {
      expect(resolveRouteSurface({ pathname, search: '', framed: false })).toBe('public')
    }
  })

  test('provides an explicit root escape only in development', () => {
    expect(resolveRouteSurface({ pathname: '/', search: '?activity_dev=1', framed: false, development: true })).toBe('activity')
    expect(resolveRouteSurface({ pathname: '/', search: '?activity_dev=1', framed: false, development: false })).toBe('public')
  })
})

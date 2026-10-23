import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  buildStartupDiagnostics,
  copyStartupDiagnostics,
  installStartupDiagnostics,
  recordStartupDiagnostic,
  startupStage,
} from '../src/client/lib/startup-diagnostics'

afterEach(() => vi.useRealTimers())

describe('connection diagnostics', () => {
  test('bounds a hung startup stage, aborts HTTP work and ignores late completion', async () => {
    vi.useFakeTimers()
    let signal!: AbortSignal
    let finish!: (value: string) => void
    const pending = startupStage(
      'Synthetic SDK wait',
      nextSignal => {
        signal = nextSignal
        return new Promise<string>(resolve => {
          finish = resolve
        })
      },
      20_000,
    )
    const rejected = expect(pending).rejects.toThrow('Startup timeout: Synthetic SDK wait')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(signal.aborted).toBe(true)
    finish('late result')
    await Promise.resolve()
    const report = JSON.parse(buildStartupDiagnostics())
    expect(report.stage).toBe('Synthetic SDK wait')
    expect(report.entries.at(-1).outcome).toBe('failed')
  })

  test('omits secrets, URLs and nested payloads while retaining a usable stack and validation code', () => {
    const error = Object.assign(
      new Error(
        'Request https://example.invalid/path?code=synthetic-query#synthetic-hash access_token=synthetic-access cookie=synthetic-cookie',
      ),
      {
        data: { nested: { activity_session_token: 'synthetic-session' } },
        headers: { Authorization: 'Bearer synthetic-header' },
        cause: new Error('synthetic-cause-token'),
      },
    )
    error.stack = `${error.message}\n    at setup (https://example.invalid/assets/app.js?token=synthetic-stack:1:2)`
    recordStartupDiagnostic('Synthetic request', 'failed', error)
    const validation = Object.assign(new Error(JSON.stringify({ received: { token: 'synthetic-received' } })), {
      issues: [
        {
          code: 'invalid_type',
          path: ['data', 'user', 'synthetic-private-path'],
          expected: 'string',
          received: { token: 'synthetic-issue' },
        },
      ],
    })
    recordStartupDiagnostic('Synthetic validation', 'failed', validation)
    const report = buildStartupDiagnostics()
    for (const secret of [
      'synthetic-query',
      'synthetic-hash',
      'synthetic-access',
      'synthetic-cookie',
      'synthetic-session',
      'synthetic-header',
      'synthetic-cause-token',
      'synthetic-stack',
      'synthetic-received',
      'synthetic-issue',
      'synthetic-private-path',
    ])
      expect(report).not.toContain(secret)
    expect(report).toContain('at setup')
    expect(report).toContain('app.js:1:2')
    expect(report).toContain('invalid_type')
    expect(JSON.parse(report).entries.at(-1).error.issues[0].path).toEqual(['data', 'user', '[field]'])
    expect(report).not.toContain('example.invalid')
  })

  test('captures swallowed SDK parse errors without other console arguments', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dispose = installStartupDiagnostics()
    try {
      console.error('Failed to parse', { access_token: 'synthetic-console-payload' })
      console.error(new TypeError('Expected a string'))
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('Synthetic window exception') }))
      const report = buildStartupDiagnostics()
      expect(report).toContain('Expected a string')
      expect(report).toContain('SDK parse')
      expect(report).toContain('Synthetic window exception')
      expect(report).not.toContain('synthetic-console-payload')
    } finally {
      dispose()
    }
  })

  test('bounds the in-memory log', () => {
    for (let i = 0; i < 60; i++) recordStartupDiagnostic('Synthetic stage', 'completed')
    expect(JSON.parse(buildStartupDiagnostics()).entries).toHaveLength(40)
  })

  test('uses legacy copying when the embedded client blocks the Clipboard API', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard blocked'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const command = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: command })
    expect(await copyStartupDiagnostics('Synthetic safe report')).toBe(true)
    expect(command).toHaveBeenCalledWith('copy')
    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
  })
})

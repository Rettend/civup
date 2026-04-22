import { describe, expect, test } from 'bun:test'
import { enforceRuntimeInvariants, RuntimeInvariantError } from '../src/runtime-invariants.ts'

describe('runtime invariant enforcement', () => {
  test('throws a RuntimeInvariantError when strict mode is enabled', () => {
    expect(() => enforceRuntimeInvariants([{
      scope: 'test-scope',
      message: 'broken invariant',
    }], {
      strict: true,
    })).toThrow(RuntimeInvariantError)
  })

  test('logs without throwing when strict mode is disabled', () => {
    const messages: unknown[] = []

    expect(() => enforceRuntimeInvariants([{
      scope: 'test-scope',
      message: 'broken invariant',
      context: { matchId: 'match-1' },
    }], {
      logger: {
        error(...args: unknown[]) {
          messages.push(args)
        },
      },
      strict: false,
    })).not.toThrow()

    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual([
      '[test-scope] broken invariant',
      { matchId: 'match-1' },
    ])
  })
})

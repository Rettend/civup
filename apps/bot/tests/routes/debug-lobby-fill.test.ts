<<<<<<< New base: fix: mod resolve
import { describe, expect, test } from 'bun:test'
import { isDebugLobbyFillEnabled } from '../../src/routes/lobby/index.ts'

describe('debug lobby fill gate', () => {
  test('uses the explicit environment flag for local and remote test environments', () => {
    expect(isDebugLobbyFillEnabled('1')).toBe(true)
    expect(isDebugLobbyFillEnabled('true')).toBe(true)
    expect(isDebugLobbyFillEnabled('yes')).toBe(true)
    expect(isDebugLobbyFillEnabled('off')).toBe(false)
    expect(isDebugLobbyFillEnabled(undefined)).toBe(false)
  })
})
|||||||
=======
import { describe, expect, test } from 'bun:test'
import { isDebugLobbyFillEnabled } from '../../src/routes/lobby/index.ts'

describe('debug lobby fill gate', () => {
  test('uses the explicit environment flag for local and remote test environments', () => {
    expect(isDebugLobbyFillEnabled('1')).toBe(true)
    expect(isDebugLobbyFillEnabled('true')).toBe(true)
    expect(isDebugLobbyFillEnabled('yes')).toBe(true)
    expect(isDebugLobbyFillEnabled('off')).toBe(false)
    expect(isDebugLobbyFillEnabled(undefined)).toBe(false)
  })
})
>>>>>>> Current commit: chore: cleanup and simplify setup

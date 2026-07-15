import { describe, expect, test } from 'bun:test'
import { isDebugLobbyFillEnabled } from '../../src/routes/lobby/index.ts'

describe('debug lobby fill gate', () => {
  test('requires both the local-only flag and a recognized development request URL', () => {
    expect(isDebugLobbyFillEnabled('http://127.0.0.1:8787/api/lobby/1v1/fill-test', '1')).toBe(true)
    expect(isDebugLobbyFillEnabled('https://bot-dev.example.com/api/lobby/1v1/fill-test', 'true')).toBe(true)
    expect(isDebugLobbyFillEnabled('https://bot.example.com/api/lobby/1v1/fill-test', '1')).toBe(false)
    expect(isDebugLobbyFillEnabled('http://127.0.0.1:8787/api/lobby/1v1/fill-test', undefined)).toBe(false)
  })
})

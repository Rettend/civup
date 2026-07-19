import { createCivBlitzDownloadTicket, verifyCivBlitzDownloadTicket } from '@civup/utils'
import { describe, expect, test } from 'bun:test'

const SECRET = 'civblitz-download-ticket-secret'
const NOW = Date.UTC(2026, 6, 19, 12)

describe('CivBlitz download tickets', () => {
  test('binds a short-lived signed ticket to one user and match', async () => {
    const ticket = await createCivBlitzDownloadTicket(SECRET, {
      userId: 'player-1',
      matchId: 'match-1',
    }, { ttlSeconds: 120, nowMs: NOW })

    await expect(verifyCivBlitzDownloadTicket(SECRET, ticket, {
      matchId: 'match-1',
      nowMs: NOW + 119_000,
    })).resolves.toEqual(expect.objectContaining({ sub: 'player-1', matchId: 'match-1' }))
    await expect(verifyCivBlitzDownloadTicket(SECRET, ticket, {
      matchId: 'match-2',
      nowMs: NOW,
    })).resolves.toBeNull()
    await expect(verifyCivBlitzDownloadTicket(SECRET, ticket, {
      matchId: 'match-1',
      nowMs: NOW + 120_000,
    })).resolves.toBeNull()
  })

  test('rejects tampered tickets', async () => {
    const ticket = await createCivBlitzDownloadTicket(SECRET, { userId: 'player-1', matchId: 'match-1' }, { nowMs: NOW })
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('a') ? 'b' : 'a'}`

    await expect(verifyCivBlitzDownloadTicket(SECRET, tampered, {
      matchId: 'match-1',
      nowMs: NOW,
    })).resolves.toBeNull()
  })
})

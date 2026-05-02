import { CIVUP_INTERNAL_SECRET_HEADER, PARTYSERVER_NAMESPACE_HEADER, PARTYSERVER_ROOM_HEADER } from '@civup/utils'
import { describe, expect, test } from 'bun:test'
import { clearActivityFollowTargetSelection, clearActivityLaunchTargetSelection, readActivityFollowTargetSelection, readActivityLaunchTargetSelection, storeActivityFollowTargetSelection, storeActivityLaunchTargetSelection } from '../../src/services/activity/launch-target.ts'

describe('activity launch target selection', () => {
  test('uses PartyServer room routing headers for direct Activity DO RPCs', async () => {
    const requests: Request[] = []
    const rooms = new Map<string, unknown>()
    const namespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId
      },
      get(id: DurableObjectId) {
        const roomId = String(id)
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init)
            requests.push(request)
            expect(request.headers.get(PARTYSERVER_ROOM_HEADER)).toBe(roomId)
            expect(request.headers.get(PARTYSERVER_NAMESPACE_HEADER)).toBe('activity')
            expect(request.headers.get(CIVUP_INTERNAL_SECRET_HEADER)).toBe('secret')
            if (request.method === 'POST') {
              rooms.set(roomId, await request.json())
              return Response.json({ ok: true })
            }
            if (request.method === 'GET') return Response.json({ target: rooms.get(roomId) ?? null })
            if (request.method === 'DELETE') {
              rooms.delete(roomId)
              return Response.json({ ok: true })
            }
            return new Response('Method not allowed', { status: 405 })
          },
        } as DurableObjectStub
      },
    } as unknown as DurableObjectNamespace

    await storeActivityLaunchTargetSelection(namespace, 'secret', 'channel-1', 'player-1', { kind: 'match', id: 'match-1' })
    await expect(readActivityLaunchTargetSelection(namespace, 'secret', 'channel-1', 'player-1')).resolves.toEqual({ kind: 'match', id: 'match-1' })
    await clearActivityLaunchTargetSelection(namespace, 'secret', 'channel-1', 'player-1')

    expect(requests.map(request => request.method)).toEqual(['POST', 'GET', 'DELETE'])
  })

  test('does not fail the caller when the launch target store RPC fails', async () => {
    const namespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId
      },
      get() {
        return {
          async fetch() {
            return new Response('Injected failure', { status: 500 })
          },
        } as DurableObjectStub
      },
    } as unknown as DurableObjectNamespace

    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      await expect(storeActivityLaunchTargetSelection(namespace, 'secret', 'channel-1', 'player-1', { kind: 'match', id: 'match-1' })).resolves.toBeUndefined()
    }
    finally {
      console.warn = originalWarn
    }
    expect(warnings[0]?.[0]).toBe('Activity launch target store failed: 500 Injected failure')
  })

  test('stores one-shot overview launch targets', async () => {
    const rooms = new Map<string, unknown>()
    const namespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId
      },
      get(id: DurableObjectId) {
        const roomId = String(id)
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init)
            if (request.method === 'POST') {
              rooms.set(roomId, await request.json())
              return Response.json({ ok: true })
            }
            if (request.method === 'GET') return Response.json({ target: rooms.get(roomId) ?? null })
            return new Response('Method not allowed', { status: 405 })
          },
        } as DurableObjectStub
      },
    } as unknown as DurableObjectNamespace

    await storeActivityLaunchTargetSelection(namespace, 'secret', 'channel-1', 'player-1', { kind: 'overview' })

    await expect(readActivityLaunchTargetSelection(namespace, 'secret', 'channel-1', 'player-1')).resolves.toEqual({ kind: 'overview' })
  })

  test('stores spectator follow targets per channel and user', async () => {
    const requests: Request[] = []
    const rooms = new Map<string, unknown>()
    const namespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId
      },
      get(id: DurableObjectId) {
        const roomId = String(id)
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init)
            requests.push(request)
            expect(request.headers.get(PARTYSERVER_ROOM_HEADER)).toBe(roomId)
            if (request.method === 'POST') {
              rooms.set(roomId, await request.json())
              return Response.json({ ok: true })
            }
            if (request.method === 'GET') return Response.json({ target: rooms.get(roomId) ?? null })
            if (request.method === 'DELETE') {
              rooms.delete(roomId)
              return Response.json({ ok: true })
            }
            return new Response('Method not allowed', { status: 405 })
          },
        } as DurableObjectStub
      },
    } as unknown as DurableObjectNamespace

    await storeActivityFollowTargetSelection(namespace, 'secret', 'channel-1', 'player-1', { kind: 'lobby', id: 'lobby-1' })
    await storeActivityFollowTargetSelection(namespace, 'secret', 'channel-2', 'player-1', { kind: 'lobby', id: 'lobby-2' })

    await expect(readActivityFollowTargetSelection(namespace, 'secret', 'channel-1', 'player-1')).resolves.toEqual({ kind: 'lobby', id: 'lobby-1' })
    await expect(readActivityFollowTargetSelection(namespace, 'secret', 'channel-2', 'player-1')).resolves.toEqual({ kind: 'lobby', id: 'lobby-2' })

    await clearActivityFollowTargetSelection(namespace, 'secret', 'channel-1', 'player-1')
    await expect(readActivityFollowTargetSelection(namespace, 'secret', 'channel-1', 'player-1')).resolves.toBeNull()
    await expect(readActivityFollowTargetSelection(namespace, 'secret', 'channel-2', 'player-1')).resolves.toEqual({ kind: 'lobby', id: 'lobby-2' })

    expect(requests.some(request => request.headers.get(PARTYSERVER_ROOM_HEADER) === 'activity-follow-target:channel-1:player-1')).toBe(true)
    expect(requests.some(request => request.headers.get(PARTYSERVER_ROOM_HEADER) === 'activity-follow-target:channel-2:player-1')).toBe(true)
  })
})

import { describe, expect, test } from 'bun:test'
import { getLobbyForUser } from '../../src/services/activity/index.ts'
import { createLobby, getLobbyById, getTestLobbyRuntime, setLobbyMemberPlayerIds, setLobbyRoster, setLobbySlots } from '../helpers/lobby-runtime.ts'
import { finalizeDeferredOpenLobbyTransferSource, leaveOpenLobbyForLobbyJoin, restoreDeferredOpenLobbyTransferSourceAdmission, rollbackDeferredOpenLobbyTransferTarget } from '../../src/services/lobby/transfer.ts'
import { seedRosterEntry as addToQueue } from '../helpers/session-roster.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('lobby transfer', () => {
  test('leaving a source lobby removes canonical membership without touching another lobby', async () => {
    const { kv } = createTrackedKv()

    const sourceLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
    })
    await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-target',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })

    const populatedSource = await setLobbyMemberPlayerIds(kv, sourceLobby.id, ['host-1', 'player-1'], sourceLobby)
    await setLobbySlots(kv, sourceLobby.id, ['host-1', 'player-1', null, null], populatedSource ?? sourceLobby)

    const runtime = await getTestLobbyRuntime(kv)
    const result = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['player-1'],
      '2v2',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )

    expect(result).toEqual({
      ok: true,
      transferredFrom: {
        lobbyId: sourceLobby.id,
        mode: '2v2',
      },
    })
    expect(await getLobbyForUser(runtime.db, 'player-1')).toBeNull()
  })

  test('one-player source transfers can restore or finalize the released admission lock', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
      queueEntries: [{ playerId: 'host-1', displayName: 'Host 1', avatarUrl: null, joinedAt: 1 }],
    })
    await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-target',
      queueEntries: [{ playerId: 'host-2', displayName: 'Host 2', avatarUrl: null, joinedAt: 1 }],
    })
    const runtime = await getTestLobbyRuntime(kv)

    const firstRelease = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['host-1'],
      '1v1',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )

    expect(firstRelease.ok).toBe(true)
    if (!firstRelease.ok) return
    expect(firstRelease.deferredSource?.lobby.id).toBe(sourceLobby.id)
    expect(await getLobbyForUser(runtime.db, 'host-1')).toBeNull()
    expect(await getLobbyById(kv, sourceLobby.id)).not.toBeNull()

    const restored = await restoreDeferredOpenLobbyTransferSourceAdmission(firstRelease.deferredSource!, { db: runtime.db })
    expect(restored).toEqual({ ok: true })
    expect(await getLobbyForUser(runtime.db, 'host-1')).toBe(sourceLobby.id)

    const secondRelease = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['host-1'],
      '1v1',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )
    expect(secondRelease.ok).toBe(true)
    if (!secondRelease.ok) return

    const finalized = await finalizeDeferredOpenLobbyTransferSource(kv, undefined, secondRelease.deferredSource!, { db: runtime.db, sessionNamespace: runtime.sessionNamespace })
    expect(finalized).toEqual({ ok: true })
    expect((await getLobbyById(kv, sourceLobby.id))?.status).toBe('cancelled')
    expect(await getLobbyForUser(runtime.db, 'host-1')).toBeNull()
  })

  test('source finalization failure rolls back target admission and restores source admission', async () => {
    const { kv } = createTrackedKv()
    const sourceLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-source',
      queueEntries: [{ playerId: 'host-1', displayName: 'Host 1', avatarUrl: null, joinedAt: 1 }],
    })
    const targetLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'host-2',
      channelId: 'channel-1',
      messageId: 'message-target',
      queueEntries: [{ playerId: 'host-2', displayName: 'Host 2', avatarUrl: null, joinedAt: 1 }],
    })
    const runtime = await getTestLobbyRuntime(kv)

    const release = await leaveOpenLobbyForLobbyJoin(
      kv,
      undefined,
      (await getLobbyById(kv, sourceLobby.id))!,
      ['host-1'],
      '1v1',
      { db: runtime.db, sessionNamespace: runtime.sessionNamespace },
    )
    expect(release.ok).toBe(true)
    if (!release.ok) return

    const targetBeforeJoin = (await getLobbyById(kv, targetLobby.id))!
    const targetEntriesBeforeJoin = [{ playerId: 'host-2', displayName: 'Host 2', avatarUrl: null, joinedAt: 1 }]
    const targetEntriesAfterJoin = [
      ...targetEntriesBeforeJoin,
      { playerId: 'host-1', displayName: 'Host 1', avatarUrl: null, joinedAt: 2 },
    ]
    const joinedTarget = await setLobbyRoster(kv, targetLobby.id, {
      memberPlayerIds: ['host-2', 'host-1'],
      slots: ['host-2', 'host-1'],
      lastActivityAt: 2,
      now: 2,
    }, targetBeforeJoin, {
      db: runtime.db,
      sessionNamespace: runtime.sessionNamespace,
      queueEntries: targetEntriesAfterJoin,
    })

    expect(joinedTarget?.memberPlayerIds).toContain('host-1')
    expect(await getLobbyForUser(runtime.db, 'host-1')).toBe(targetLobby.id)

    const failingNamespace = failOpenCancelForSession(runtime.sessionNamespace, sourceLobby.id)
    const finalized = await finalizeDeferredOpenLobbyTransferSource(kv, undefined, release.deferredSource!, {
      db: runtime.db,
      sessionNamespace: failingNamespace,
    })
    expect(finalized.ok).toBe(false)

    const rolledBack = await rollbackDeferredOpenLobbyTransferTarget(kv, release.deferredSource!, {
      lobby: targetBeforeJoin,
      queueEntries: targetEntriesBeforeJoin,
      at: 2,
    }, {
      db: runtime.db,
      sessionNamespace: failingNamespace,
      queueEntries: targetEntriesBeforeJoin,
    })
    expect(rolledBack).toEqual({ ok: true })

    expect((await getLobbyById(kv, sourceLobby.id))?.status).toBe('open')
    expect((await getLobbyById(kv, targetLobby.id))?.memberPlayerIds).toEqual(['host-2'])
    expect(await getLobbyForUser(runtime.db, 'host-1')).toBe(sourceLobby.id)
  })
})

function failOpenCancelForSession(namespace: DurableObjectNamespace, sessionId: string): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return namespace.idFromName(name)
    },
    get(id: DurableObjectId) {
      const stub = namespace.get(id)
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init)
          if (String(id) === sessionId && new URL(request.url).pathname === '/commands/open-lobby') {
            const body = await request.clone().json().catch(() => null) as { type?: string } | null
            if (body?.type === 'cancel-open-session') {
              return new Response(JSON.stringify({ error: 'source finalize failed' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              })
            }
          }
          return stub.fetch(request)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

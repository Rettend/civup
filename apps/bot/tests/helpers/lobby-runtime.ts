import type { Database as CivupDatabase } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { LobbyState } from '../../src/services/lobby/types.ts'
import { canStartWithPlayerCount } from '@civup/game'
import * as source from '../../src/services/lobby/index.ts'
import { getCurrentSessionLobbyProjectionsForPlayer, getCurrentSessionLobbyProjectionsForPlayers, getLiveSessionLobbyProjections, getLiveSessionLobbyProjectionsHostedBy, getOpenSessionLobbyProjectionForPlayer, getOpenSessionLobbyProjectionsByChannel, getOpenSessionLobbyProjectionsByMode, getSessionLobbyProjectionByMatch } from '../../src/services/session/index.ts'
import { getSessionRecord, runSessionDraftLifecycleCommand, startSessionDraft } from '../../src/session-runtime/session-do-client.ts'
import { buildLobbyProjectionFromSessionRecord } from '../../src/session-runtime/session-record.ts'
import { createSqliteD1Database } from './d1.ts'
import { getSeededRosterEntries } from './session-roster.ts'
import { createTestSessionNamespace } from './session-runtime.ts'
import { createTestDatabase } from './test-env.ts'

export * from '../../src/services/lobby/index.ts'

export async function getLobbyById(kv: KVNamespace, lobbyId: string): Promise<LobbyState | null> {
  const runtime = getResolvedRuntime(kv)
  if (!runtime) return await source.getLobbyById(kv, lobbyId)
  const record = await getSessionRecord(runtime.sessionNamespace, lobbyId).catch(() => null)
  if (record) return buildLobbyProjectionFromSessionRecord(record)
  return await getSessionLobbyProjectionByMatch(runtime.db, lobbyId) ?? await source.getLobbyById(kv, lobbyId)
}

export async function getLobby(kv: KVNamespace, mode: GameMode): Promise<LobbyState | null> {
  const runtime = getResolvedRuntime(kv)
  if (!runtime) return await source.getLobby(kv, mode)
  return [...await getOpenSessionLobbyProjectionsByMode(runtime.db, mode)].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
}

export async function getLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<LobbyState[]> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? await getOpenSessionLobbyProjectionsByMode(runtime.db, mode) : await source.getLobbiesByMode(kv, mode)
}

export async function getLobbiesByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState[]> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? await getOpenSessionLobbyProjectionsByChannel(runtime.db, channelId) : await source.getLobbiesByChannel(kv, channelId)
}

export async function getLobbyByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState | null> {
  const lobbies = await getLobbiesByChannel(kv, channelId)
  return [...lobbies].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
}

export async function getCurrentLobbies(kv: KVNamespace, mode?: GameMode): Promise<LobbyState[]> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? await getLiveSessionLobbyProjections(runtime.db, { mode }) : await source.getCurrentLobbies(kv, mode)
}

export async function getCurrentLobbiesForPlayers(
  kv: KVNamespace,
  playerIds: string[],
  options?: { mode?: GameMode, excludeLobbyIds?: readonly string[] },
): Promise<Map<string, LobbyState | null>> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? await getCurrentSessionLobbyProjectionsForPlayers(runtime.db, playerIds, options) : await source.getCurrentLobbiesForPlayers(kv, playerIds, options)
}

export async function getCurrentLobbiesForPlayer(
  kv: KVNamespace,
  playerId: string,
  options?: { mode?: GameMode, excludeLobbyIds?: readonly string[] },
): Promise<LobbyState[]> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? await getCurrentSessionLobbyProjectionsForPlayer(runtime.db, playerId, options) : await source.getCurrentLobbiesForPlayer(kv, playerId, options)
}

export async function getCurrentLobbyHostedBy(kv: KVNamespace, hostId: string): Promise<LobbyState | null> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? (await getLiveSessionLobbyProjectionsHostedBy(runtime.db, hostId))[0] ?? null : await source.getCurrentLobbyHostedBy(kv, hostId)
}

export async function getOpenLobbyForPlayer(kv: KVNamespace, playerId: string, mode?: GameMode): Promise<LobbyState | null> {
  const runtime = getResolvedRuntime(kv)
  return runtime ? await getOpenSessionLobbyProjectionForPlayer(runtime.db, playerId, { mode }) : await source.getOpenLobbyForPlayer(kv, playerId, mode)
}

interface TestLobbyRuntime {
  db: CivupDatabase
  d1: D1Database
  sessionNamespace: DurableObjectNamespace
}

type LobbyProjectionOptions = NonNullable<Parameters<typeof source.setLobbyStatus>[4]>

const runtimes = new WeakMap<KVNamespace, Promise<TestLobbyRuntime>>()
const resolvedRuntimes = new WeakMap<KVNamespace, TestLobbyRuntime>()

export async function getTestLobbyRuntime(kv: KVNamespace, db?: CivupDatabase | null): Promise<TestLobbyRuntime> {
  const existing = runtimes.get(kv)
  if (existing) return existing

  const created = createTestLobbyRuntime(kv, db).then((runtime) => {
    resolvedRuntimes.set(kv, runtime)
    return runtime
  })
  runtimes.set(kv, created)
  return created
}

export function getExistingTestLobbyRuntime(kv: KVNamespace): TestLobbyRuntime {
  const runtime = resolvedRuntimes.get(kv)
  if (!runtime) throw new Error('Test lobby runtime has not been created for this KV namespace')
  return runtime
}

function getResolvedRuntime(kv: KVNamespace): TestLobbyRuntime | null {
  return resolvedRuntimes.get(kv) ?? null
}

export function buildTestLobbyEnv(kv: KVNamespace, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const runtime = getExistingTestLobbyRuntime(kv)
  const env: Record<string, unknown> = {
    DB: runtime.d1,
    KV: kv,
    SessionDO: runtime.sessionNamespace,
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'secret',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

export async function createLobby(
  kv: KVNamespace,
  input: Parameters<typeof source.createLobby>[1],
): Promise<LobbyState> {
  const runtime = await getTestLobbyRuntime(kv, input.db)
  const sessionNamespace = input.sessionNamespace ?? runtime.sessionNamespace
  resolvedRuntimes.set(kv, { ...runtime, sessionNamespace })
  const seededEntries = input.queueEntries ?? getSeededRosterEntries(kv, input.mode)
  return await source.createLobby(kv, {
    ...input,
    queueEntries: seededEntries,
    db: input.db ?? runtime.db,
    sessionNamespace,
  })
}

export async function commitLobbyState(
  kv: KVNamespace,
  lobby: Parameters<typeof source.commitLobbyState>[1],
  options?: Parameters<typeof source.commitLobbyState>[2],
): ReturnType<typeof source.commitLobbyState> {
  return await source.commitLobbyState(kv, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbyStatus(
  kv: KVNamespace,
  lobbyId: string,
  status: Parameters<typeof source.setLobbyStatus>[2],
  currentLobby?: Parameters<typeof source.setLobbyStatus>[3],
  options?: Parameters<typeof source.setLobbyStatus>[4],
): ReturnType<typeof source.setLobbyStatus> {
  if (currentLobby?.status === 'drafting' && status === 'active') {
    await completeTestSessionDraft(kv, lobbyId, options)
    return await getLobbyById(kv, lobbyId)
  }

  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyStatus(kv, lobbyId, status, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbyMessage(
  kv: KVNamespace,
  lobbyId: string,
  channelId: string,
  messageId: string,
  options?: Parameters<typeof source.setLobbyMessage>[4],
): ReturnType<typeof source.setLobbyMessage> {
  return await source.setLobbyMessage(kv, lobbyId, channelId, messageId, await withRuntimeOptions(kv, options))
}

export async function setLobbyDraftConfig(
  kv: KVNamespace,
  lobbyId: string,
  draftConfig: Parameters<typeof source.setLobbyDraftConfig>[2],
  currentLobby?: Parameters<typeof source.setLobbyDraftConfig>[3],
  options?: Parameters<typeof source.setLobbyDraftConfig>[4],
): ReturnType<typeof source.setLobbyDraftConfig> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyDraftConfig(kv, lobbyId, draftConfig, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbyMinRole(
  kv: KVNamespace,
  lobbyId: string,
  minRole: Parameters<typeof source.setLobbyMinRole>[2],
  currentLobby?: Parameters<typeof source.setLobbyMinRole>[3],
  options?: Parameters<typeof source.setLobbyMinRole>[4],
): ReturnType<typeof source.setLobbyMinRole> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyMinRole(kv, lobbyId, minRole, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbyMaxRole(
  kv: KVNamespace,
  lobbyId: string,
  maxRole: Parameters<typeof source.setLobbyMaxRole>[2],
  currentLobby?: Parameters<typeof source.setLobbyMaxRole>[3],
  options?: Parameters<typeof source.setLobbyMaxRole>[4],
): ReturnType<typeof source.setLobbyMaxRole> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyMaxRole(kv, lobbyId, maxRole, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbySteamLobbyLink(
  kv: KVNamespace,
  lobbyId: string,
  steamLobbyLink: Parameters<typeof source.setLobbySteamLobbyLink>[2],
  currentLobby?: Parameters<typeof source.setLobbySteamLobbyLink>[3],
  options?: Parameters<typeof source.setLobbySteamLobbyLink>[4],
): ReturnType<typeof source.setLobbySteamLobbyLink> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbySteamLobbyLink(kv, lobbyId, steamLobbyLink, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbySlots(
  kv: KVNamespace,
  lobbyId: string,
  slots: Parameters<typeof source.setLobbySlots>[2],
  currentLobby?: Parameters<typeof source.setLobbySlots>[3],
  options?: Parameters<typeof source.setLobbySlots>[4],
): ReturnType<typeof source.setLobbySlots> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbySlots(kv, lobbyId, slots, lobby, await withRuntimeOptionsForLobby(kv, lobby, options))
}

export async function setLobbyArranged(
  kv: KVNamespace,
  lobbyId: string,
  input: Parameters<typeof source.setLobbyArranged>[2],
  currentLobby?: Parameters<typeof source.setLobbyArranged>[3],
  options?: Parameters<typeof source.setLobbyArranged>[4],
): ReturnType<typeof source.setLobbyArranged> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyArranged(kv, lobbyId, input, lobby, await withRuntimeOptions(kv, options))
}

export async function setLobbyMemberPlayerIds(
  kv: KVNamespace,
  lobbyId: string,
  memberPlayerIds: Parameters<typeof source.setLobbyMemberPlayerIds>[2],
  currentLobby?: Parameters<typeof source.setLobbyMemberPlayerIds>[3],
  options?: Parameters<typeof source.setLobbyMemberPlayerIds>[4],
): ReturnType<typeof source.setLobbyMemberPlayerIds> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyMemberPlayerIds(kv, lobbyId, memberPlayerIds, lobby, await withRuntimeOptionsForLobby(kv, lobby, options))
}

export async function setLobbyLastActivityAt(
  kv: KVNamespace,
  lobbyId: string,
  lastActivityAt: number,
  currentLobby?: Parameters<typeof source.setLobbyLastActivityAt>[3],
  options?: Parameters<typeof source.setLobbyLastActivityAt>[4],
): ReturnType<typeof source.setLobbyLastActivityAt> {
  const lobby = currentLobby ?? await getLobbyById(kv, lobbyId) ?? undefined
  return await source.setLobbyLastActivityAt(kv, lobbyId, lastActivityAt, lobby, await withRuntimeOptions(kv, options))
}

export async function pruneInactiveOpenLobbies(
  kv: KVNamespace,
  token: Parameters<typeof source.pruneInactiveOpenLobbies>[1],
  options?: Parameters<typeof source.pruneInactiveOpenLobbies>[2],
): ReturnType<typeof source.pruneInactiveOpenLobbies> {
  return await source.pruneInactiveOpenLobbies(kv, token, await withRuntimeOptions(kv, options))
}

export async function repostLobbyMessage(
  kv: KVNamespace,
  token: Parameters<typeof source.repostLobbyMessage>[1],
  lobby: Parameters<typeof source.repostLobbyMessage>[2],
  payload: Parameters<typeof source.repostLobbyMessage>[3],
  options?: Parameters<typeof source.repostLobbyMessage>[4],
): ReturnType<typeof source.repostLobbyMessage> {
  return await source.repostLobbyMessage(kv, token, lobby, payload, await withRuntimeOptions(kv, options))
}

export async function startTestSessionDraft(
  kv: KVNamespace,
  lobbyId: string,
  currentLobby?: LobbyState | null,
  options?: LobbyProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const runtimeOptions = await withRuntimeOptionsForLobby(kv, lobby, options)
  const slotReadyLobby = await ensureStartableLobby(kv, lobby, runtimeOptions)
  await startSessionDraft(runtimeOptions.sessionNamespace, lobbyId, {
    expectedVersion: slotReadyLobby.revision,
    hostId: slotReadyLobby.hostId,
  })
  return await getLobbyById(kv, lobbyId)
}

export async function completeTestSessionDraft(
  kv: KVNamespace,
  lobbyId: string,
  options?: LobbyProjectionOptions,
): Promise<LobbyState | null> {
  const runtimeOptions = await withRuntimeOptions(kv, options)
  await runSessionDraftLifecycleCommand(runtimeOptions.sessionNamespace, lobbyId, { type: 'draft-completed' })
  return await getLobbyById(kv, lobbyId)
}

async function fillEmptySlotsFromMembers(
  kv: KVNamespace,
  lobby: LobbyState,
  options: LobbyProjectionOptions & { sessionNamespace: DurableObjectNamespace },
): Promise<LobbyState> {
  const slots = [...lobby.slots]
  let changed = false
  for (const playerId of lobby.memberPlayerIds) {
    if (slots.includes(playerId)) continue
    const emptyIndex = slots.findIndex(slot => slot == null)
    if (emptyIndex === -1) break
    slots[emptyIndex] = playerId
    changed = true
  }
  if (!changed) return lobby
  return await source.setLobbySlots(kv, lobby.id, slots, lobby, options) ?? lobby
}

async function ensureStartableLobby(
  kv: KVNamespace,
  lobby: LobbyState,
  options: LobbyProjectionOptions & { sessionNamespace: DurableObjectNamespace },
): Promise<LobbyState> {
  let next = await fillEmptySlotsFromMembers(kv, lobby, options)
  let selectedCount = next.slots.filter(Boolean).length
  let fillerIndex = 1

  while (!canStartWithPlayerCount(next.mode, selectedCount, next.slots.length, { redDeath: next.draftConfig.redDeath, permanentAlly: next.draftConfig.permanentAlly })) {
    const emptyIndex = next.slots.findIndex(slot => slot == null)
    if (emptyIndex === -1) break

    let fillerId = `test-player-${next.id}-${fillerIndex++}`
    while (next.memberPlayerIds.includes(fillerId)) fillerId = `test-player-${next.id}-${fillerIndex++}`

    const queueEntries = [
      ...(options.queueEntries ?? []),
      { playerId: fillerId, displayName: fillerId, avatarUrl: null, joinedAt: 0 },
    ]
    const memberPlayerIds = [...next.memberPlayerIds, fillerId]
    const slots = [...next.slots]
    slots[emptyIndex] = fillerId
    const fillerOptions = { ...options, queueEntries }

    next = await source.setLobbyMemberPlayerIds(kv, next.id, memberPlayerIds, next, fillerOptions) ?? { ...next, memberPlayerIds }
    next = await source.setLobbySlots(kv, next.id, slots, next, fillerOptions) ?? { ...next, slots }
    selectedCount = next.slots.filter(Boolean).length
  }

  return next
}

async function withRuntimeOptions<T extends LobbyProjectionOptions | undefined>(
  kv: KVNamespace,
  options: T,
): Promise<NonNullable<T> & { db: CivupDatabase, sessionNamespace: DurableObjectNamespace }> {
  const runtime = await getTestLobbyRuntime(kv, options?.db)
  return {
    ...options,
    db: options?.db ?? runtime.db,
    sessionNamespace: options?.sessionNamespace ?? runtime.sessionNamespace,
  } as NonNullable<T> & { db: CivupDatabase, sessionNamespace: DurableObjectNamespace }
}

async function withRuntimeOptionsForLobby<T extends LobbyProjectionOptions | undefined>(
  kv: KVNamespace,
  lobby: LobbyState | null | undefined,
  options: T,
): Promise<NonNullable<T> & { db: CivupDatabase, sessionNamespace: DurableObjectNamespace }> {
  const runtimeOptions = await withRuntimeOptions(kv, options)
  if (!lobby || runtimeOptions.queueEntries) return runtimeOptions
  const seededEntries = getSeededRosterEntries(kv, lobby.mode)
  return seededEntries.length > 0
    ? { ...runtimeOptions, queueEntries: seededEntries }
    : runtimeOptions
}

async function createTestLobbyRuntime(kv: KVNamespace, dbOverride?: CivupDatabase | null): Promise<TestLobbyRuntime> {
  const created = dbOverride ? null : await createTestDatabase()
  const db = dbOverride ?? created!.db
  const d1 = createSqliteD1Database(db as Parameters<typeof createSqliteD1Database>[0])
  const sessionNamespace = createTestSessionNamespace({
    DB: d1,
    KV: kv,
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: 'secret',
  })

  return { db, d1, sessionNamespace }
}

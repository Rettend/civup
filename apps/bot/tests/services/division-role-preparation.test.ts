import type { DiscordGuildRoleResponse } from '../../src/services/discord/index.ts'
import type { DivisionRolePreparation } from '../../src/services/ranked/division-role-preparation.ts'
import { expect, test } from 'bun:test'
import { PUBLIC_RATING_BANDS } from '@civup/rating'
import {
  divisionRolePreparationKey,
  prepareDivisionRoles,
  resolveDivisionRoleCreation,
} from '../../src/services/ranked/division-role-preparation.ts'
import { createTestKv } from '../helpers/test-env.ts'

function fixture() {
  const roles: DiscordGuildRoleResponse[] = [
    { id: 'guild', name: '@everyone', position: 0, permissions: '0' },
    { id: 'unranked', name: 'Unranked', position: 1, permissions: '0' },
    ...['Champion', 'Diamond', 'Gold', 'Silver', 'Bronze'].map((name, index) => ({
      id: `source-${index}`,
      name,
      position: 6 - index,
      permissions: '0',
      color: index + 1,
    })),
    { id: 'bot-role', name: 'Bot', position: 100, permissions: '268435456' },
  ]
  const journal = new Map<string, unknown>()
  const store = {
    async get<T>(key: string) {
      return structuredClone(journal.get(key)) as T | undefined
    },
    async put<T>(key: string, value: T) {
      journal.set(key, structuredClone(value))
    },
  }
  const input = {
    store,
    kv: createTestKv(),
    token: 'token',
    guildId: 'guild',
    botUserId: 'bot',
    config: {
      tiers: roles.slice(2, 7).map(role => ({ roleId: role.id, label: role.name, color: null })),
      unrankedRoleId: 'unranked',
    },
  }
  let creations = 0
  let uncertain = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/members/bot')) return Response.json({ roles: ['bot-role'] })
    if (!path.endsWith('/roles')) throw new Error(`Unexpected Discord operation: ${path}`)
    if (init?.method === 'POST') {
      creations++
      expect(
        (await store.get<DivisionRolePreparation>(divisionRolePreparationKey('guild')))?.pendingCreate,
      ).not.toBeNull()
      const data = JSON.parse(init.body as string)
      expect(data.permissions).toBe('0')
      expect(data.mentionable).toBe(false)
      roles.push({ ...data, id: `new-${creations}`, position: 1 })
      return uncertain ? new Response('uncertain', { status: 500 }) : Response.json(roles.at(-1))
    }
    if (init?.method === 'PATCH') {
      throw new Error('Preparation must never change existing roles or their positions.')
    }
    return Response.json(roles)
  }) as typeof fetch
  return {
    input,
    roles,
    creations: () => creations,
    uncertain: () => {
      uncertain = true
    },
    certain: () => {
      uncertain = false
    },
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test('division preparation reuses the end ranks, creates nine roles once, and does not edit members or rename broad roles', async () => {
  const f = fixture()
  try {
    const result = await prepareDivisionRoles(f.input)
    expect(result.status).toBe('prepared')
    expect(result.roleIdsByMinimum[0]).toBe('source-4')
    expect(result.roleIdsByMinimum[1500]).toBe('source-0')
    expect(f.creations()).toBe(9)
    expect(f.roles.filter(role => role.id.startsWith('new-')).map(role => role.name)).toEqual([
      'Silver III',
      'Silver II',
      'Silver I',
      'Gold III',
      'Gold II',
      'Gold I',
      'Diamond III',
      'Diamond II',
      'Diamond I',
    ])
    expect(f.roles.filter(role => role.id.startsWith('new-')).map(role => role.color)).toEqual([
      4, 4, 4, 3, 3, 3, 2, 2, 2,
    ])
    expect(Object.keys(result.roleIdsByMinimum)).toHaveLength(PUBLIC_RATING_BANDS.length)
    expect(await prepareDivisionRoles(f.input)).toEqual(result)
    expect(f.creations()).toBe(9)
    f.roles.find(role => role.id === result.roleIdsByMinimum[600])!.permissions = '8'
    await expect(prepareDivisionRoles(f.input)).rejects.toThrow('missing or changed')
    expect(f.creations()).toBe(9)
  } finally {
    f.restore()
  }
})

test('uncertain role creation is not retried or adopted by name; a reviewed ID can resume preparation', async () => {
  const f = fixture()
  try {
    f.uncertain()
    await expect(prepareDivisionRoles(f.input)).rejects.toThrow()
    expect(f.creations()).toBe(1)
    f.certain()
    await expect(prepareDivisionRoles(f.input)).rejects.toThrow('uncertain outcome')
    expect(f.creations()).toBe(1)
    await expect(resolveDivisionRoleCreation({ ...f.input, roleId: 'source-3' })).rejects.toThrow('does not match')
    await resolveDivisionRoleCreation({ ...f.input, roleId: 'new-1' })
    expect((await prepareDivisionRoles(f.input)).status).toBe('prepared')
    expect(f.creations()).toBe(9)
  } finally {
    f.restore()
  }
})

test('preparation refuses unowned division names and unsafe hierarchy before any creation', async () => {
  const f = fixture()
  try {
    f.roles.push({ id: 'unowned', name: 'Silver III', permissions: '0', position: 2 })
    await expect(prepareDivisionRoles(f.input)).rejects.toThrow('without a saved mapping')
    f.roles.pop()
    f.roles.find(role => role.id === 'source-0')!.position = 101
    await expect(prepareDivisionRoles(f.input)).rejects.toThrow('below the bot')
    expect(f.creations()).toBe(0)
  } finally {
    f.restore()
  }
})

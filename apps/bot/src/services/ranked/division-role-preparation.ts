import type { RankedRoleConfig } from './roles.ts'
import { getConfiguredDivisionLabel } from './roles.ts'
import { PUBLIC_RATING_BANDS } from '@civup/rating'
import { createGuildRole, fetchGuildMember, fetchGuildRoles } from '../discord/index.ts'

export interface DivisionRolePreparation {
  version: 1
  guildId: string
  sourceRoleIds: string[]
  unrankedRoleId: string
  roleIdsByMinimum: Record<string, string>
  pendingCreate: { minimum: number, name: string } | null
  status: 'preparing' | 'prepared'
}

interface PreparationStore {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<unknown>
}

export const divisionRolePreparationKey = (guildId: string) => `division-role-preparation:v1:${guildId}`
export const divisionRoleMappingKey = (guildId: string) => `ranked-roles:divisions:v1:${guildId}`

/** Must run through the serialized maintenance owner with strongly consistent storage. */
export async function prepareDivisionRoles(input: {
  store: PreparationStore
  kv: KVNamespace
  token: string
  guildId: string
  botUserId: string
  config: RankedRoleConfig
}): Promise<DivisionRolePreparation> {
  const { store, kv, token, guildId, botUserId, config } = input
  if (config.tiers.length !== 5 || config.tiers.some(row => !row.roleId) || !config.unrankedRoleId) throw new Error('Configure five broad rank roles and a separate Unranked role before preparing divisions.')
  const sourceRoleIds = config.tiers.map(row => row.roleId!)
  if (new Set([...sourceRoleIds, config.unrankedRoleId]).size !== 6) throw new Error('Rank and Unranked role mappings must be distinct.')
  let roles = await fetchGuildRoles(token, guildId)
  const displayConfig = { ...config, tiers: config.tiers.map(tier => ({ ...tier, label: roles.find(role => role.id === tier.roleId)?.name ?? tier.label })) }
  const member = await fetchGuildMember(token, guildId, botUserId)
  const botRoles = new Set(member.roles ?? [])
  const botPosition = Math.max(0, ...roles.filter(role => botRoles.has(role.id)).map(role => role.position ?? 0))
  const permissions = roles.filter(role => role.id === guildId || botRoles.has(role.id)).reduce((value, role) => value | BigInt(role.permissions ?? '0'), 0n)
  if ((permissions & (8n | (1n << 28n))) === 0n) throw new Error('The bot needs Manage Roles before preparing divisions.')
  for (const id of [...sourceRoleIds, config.unrankedRoleId]) {
    const role = roles.find(role => role.id === id)
    if (!role || role.managed || !Number.isSafeInteger(role.position) || role.position! <= 0 || role.position! >= botPosition) throw new Error('All rank roles must exist, be unmanaged, and sit below the bot role.')
  }
  const key = divisionRolePreparationKey(guildId)
  let state = await store.get<DivisionRolePreparation>(key)
  if (state && (state.version !== 1 || state.guildId !== guildId || JSON.stringify(state.sourceRoleIds) !== JSON.stringify(sourceRoleIds) || state.unrankedRoleId !== config.unrankedRoleId)) throw new Error('The source role configuration changed. Review the saved preparation before continuing.')
  if (!state) {
    state = { version: 1, guildId, sourceRoleIds, unrankedRoleId: config.unrankedRoleId, roleIdsByMinimum: Object.fromEntries(PUBLIC_RATING_BANDS.filter(band => band.division === 0).map(band => [band.minimum, sourceRoleIds[Number(band.tier.slice(4)) - 1]!])), pendingCreate: null, status: 'preparing' }
    const requiredNames = PUBLIC_RATING_BANDS.filter(band => band.division !== 0).map(band => getConfiguredDivisionLabel(displayConfig, band.minimum))
    if (roles.some(role => requiredNames.includes(role.name as typeof requiredNames[number]))) throw new Error('Division-named roles already exist without a saved mapping. Review them before preparing roles; names alone do not establish ownership.')
    if (roles.length + requiredNames.length > 250) throw new Error('There is not enough room for the division roles within the guild role limit.')
    await store.put(key, state)
  }
  if (state.pendingCreate) {
    const pending = state.pendingCreate
    throw new Error(`The previous creation of ${pending.name} has an uncertain outcome. Review Discord, then explicitly resolve the created role ID before resuming; no duplicate was created.`)
  }
  for (const band of PUBLIC_RATING_BANDS) {
    const name = getConfiguredDivisionLabel(displayConfig, band.minimum)
    const id = state.roleIdsByMinimum[band.minimum]
    if (id) {
      const role = roles.find(role => role.id === id)
      if (!role || role.managed || (band.division !== 0 && (role.name !== name || role.permissions !== '0'))) throw new Error(`Prepared role ${name} is missing or changed. Review it rather than creating a replacement automatically.`)
      continue
    }
    const source = roles.find(role => role.id === sourceRoleIds[Number(band.tier.slice(4)) - 1])!
    state = { ...state, pendingCreate: { minimum: band.minimum, name } }
    await store.put(key, state)
    const created = await createGuildRole(token, guildId, { name, color: source.color ?? 0, hoist: source.hoist ?? false, mentionable: false, permissions: '0' })
    state = { ...state, roleIdsByMinimum: { ...state.roleIdsByMinimum, [band.minimum]: created.id }, pendingCreate: null }
    await store.put(key, state)
    roles.push(created)
  }
  roles = await fetchGuildRoles(token, guildId)
  const mapped = state.roleIdsByMinimum
  const orderedIds = PUBLIC_RATING_BANDS.map(band => mapped[band.minimum]!)
  // Role positions belong to the owner; preparation never changes the guild hierarchy.
  const finalBotPosition = Math.max(0, ...roles.filter(role => botRoles.has(role.id)).map(role => role.position ?? 0))
  if (orderedIds.some(id => (roles.find(role => role.id === id)?.position ?? Infinity) >= finalBotPosition)) throw new Error('Prepared division roles must remain below the bot role.')
  state = { ...state, status: 'prepared' }
  await store.put(key, state)
  await kv.put(divisionRoleMappingKey(guildId), JSON.stringify(state))
  return state
}

export async function resolveDivisionRoleCreation(input: { store: PreparationStore, token: string, guildId: string, roleId: string }): Promise<DivisionRolePreparation> {
  const key = divisionRolePreparationKey(input.guildId)
  const state = await input.store.get<DivisionRolePreparation>(key)
  if (!state?.pendingCreate || state.status !== 'preparing') throw new Error('There is no unresolved role creation.')
  const roles = await fetchGuildRoles(input.token, input.guildId)
  const role = roles.find(role => role.id === input.roleId)
  if (!role || role.managed || role.name !== state.pendingCreate.name || role.permissions !== '0'
    || [...state.sourceRoleIds, state.unrankedRoleId, ...Object.values(state.roleIdsByMinimum)].includes(role.id)) throw new Error('The supplied role does not match the pending division creation.')
  const next: DivisionRolePreparation = { ...state, roleIdsByMinimum: { ...state.roleIdsByMinimum, [state.pendingCreate.minimum]: role.id }, pendingCreate: null }
  await input.store.put(key, next)
  return next
}

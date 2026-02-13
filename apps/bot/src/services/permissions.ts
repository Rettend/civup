const MOD_ROLE_KEY_PREFIX = 'permissions:mod_roles:'

const DISCORD_ADMINISTRATOR = 1n << 3n
const DISCORD_MANAGE_GUILD = 1n << 5n

interface PermissionCheckInput {
  permissions?: string
}

interface ModPermissionCheckInput extends PermissionCheckInput {
  roles?: string[]
  guildId?: string
  kv: KVNamespace
}

function modRoleKey(guildId: string): string {
  return `${MOD_ROLE_KEY_PREFIX}${guildId}`
}

export function hasAdminPermission(input: PermissionCheckInput): boolean {
  const permissions = BigInt(input.permissions ?? '0')
  if ((permissions & DISCORD_ADMINISTRATOR) !== 0n) return true
  if ((permissions & DISCORD_MANAGE_GUILD) !== 0n) return true
  return false
}

export async function canUseModCommands(input: ModPermissionCheckInput): Promise<boolean> {
  if (hasAdminPermission(input)) return true
  if (!input.guildId) return false

  const configuredRoles = await getModRoleIds(input.kv, input.guildId)
  if (configuredRoles.length === 0) return false

  const memberRoles = new Set(input.roles ?? [])
  for (const roleId of configuredRoles) {
    if (memberRoles.has(roleId)) return true
  }

  return false
}

export function parseRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const unique = new Set<string>()
  for (const roleId of value) {
    if (typeof roleId !== 'string') continue
    const trimmed = roleId.trim()
    if (!/^\d+$/.test(trimmed)) continue
    unique.add(trimmed)
  }

  return [...unique]
}

export async function getModRoleIds(kv: KVNamespace, guildId: string): Promise<string[]> {
  const stored = await kv.get(modRoleKey(guildId), 'json')
  return parseRoleIds(stored)
}

export async function addModRole(
  kv: KVNamespace,
  guildId: string,
  roleId: string,
): Promise<{ added: boolean, roles: string[] }> {
  const roles = await getModRoleIds(kv, guildId)
  if (roles.includes(roleId)) return { added: false, roles }

  const updatedRoles = [...roles, roleId]
  await kv.put(modRoleKey(guildId), JSON.stringify(updatedRoles))
  return { added: true, roles: updatedRoles }
}

export async function removeModRole(
  kv: KVNamespace,
  guildId: string,
  roleId: string,
): Promise<{ removed: boolean, roles: string[] }> {
  const roles = await getModRoleIds(kv, guildId)
  if (!roles.includes(roleId)) return { removed: false, roles }

  const updatedRoles = roles.filter(id => id !== roleId)
  if (updatedRoles.length === 0) {
    await kv.delete(modRoleKey(guildId))
  }
  else {
    await kv.put(modRoleKey(guildId), JSON.stringify(updatedRoles))
  }

  return { removed: true, roles: updatedRoles }
}

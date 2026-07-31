import type { Context } from 'hono'
import type { Env } from '../env.ts'
import type { DiscordGuildIdentity } from '@civup/utils'
import { getLegacyPrimaryDiscordGuildId, normalizeDiscordGuildIdentity, readAuthorizedActivityIdentity, resolveApprovedDiscordGuildConfiguration } from '@civup/utils'
import { hasAdminPermission } from '../services/permissions/index.ts'

export interface AuthenticatedActivityIdentity {
  userId: string
  displayName: string | null
  avatarUrl: string | null
  guildId: string | null
  guildPermissions: string | null
  guildRoleIds: string[]
  sourceGuild: DiscordGuildIdentity | null
}

export function requireAuthenticatedActivity(
  c: Context<Env>,
): { ok: true, identity: AuthenticatedActivityIdentity } | { ok: false, response: Response } {
  const configuredSecret = c.env.CIVUP_SECRET?.trim() ?? ''
  if (configuredSecret.length === 0) {
    return {
      ok: false,
      response: c.json({ error: 'Activity auth is not configured' }, 503),
    }
  }

  const identity = readAuthorizedActivityIdentity(c.req.raw.headers, configuredSecret)
  if (!identity) {
    return {
      ok: false,
      response: c.json({ error: 'Unauthorized activity request' }, 401),
    }
  }
  const guildConfig = resolveApprovedDiscordGuildConfiguration(c.env)
  if (!guildConfig.ok) {
    return {
      ok: false,
      response: c.json({ error: 'Approved Discord server configuration is invalid' }, 503),
    }
  }
  if (!identity.guildId || !guildConfig.guildIds.includes(identity.guildId)) {
    return {
      ok: false,
      response: c.json({ error: 'Activity source server is not approved' }, 403),
    }
  }

  return {
    ok: true,
    identity: {
      userId: identity.userId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      guildId: identity.guildId ?? null,
      guildPermissions: identity.guildPermissions ?? null,
      guildRoleIds: identity.guildRoleIds ?? [],
      sourceGuild: normalizeDiscordGuildIdentity(identity.guildId
        ? { id: identity.guildId, name: identity.guildName, iconUrl: identity.guildIconUrl }
        : null),
    },
  }
}

export function hasAuthenticatedActivityAdminPermission(
  env: Env['Bindings'],
  identity: AuthenticatedActivityIdentity,
): boolean {
  const primaryGuildId = getLegacyPrimaryDiscordGuildId(env)
  return primaryGuildId != null
    && identity.guildId === primaryGuildId
    && hasAdminPermission({ permissions: identity.guildPermissions ?? undefined })
}

export function rejectMismatchedActivityUser(c: Context<Env>, providedUserId: unknown, actualUserId: string): Response | null {
  if (providedUserId == null) return null
  if (typeof providedUserId !== 'string' || providedUserId.length === 0) {
    return c.json({ error: 'userId is required' }, 400)
  }
  if (providedUserId !== actualUserId) {
    return c.json({ error: 'Authenticated activity user mismatch' }, 403)
  }
  return null
}

export function rejectMismatchedActivityParam(c: Context<Env>, actualUserId: string, paramName = 'userId'): Response | null {
  const providedUserId = c.req.param(paramName)
  if (!providedUserId || providedUserId === actualUserId) return null
  return c.json({ error: 'Authenticated activity user mismatch' }, 403)
}

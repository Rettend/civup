import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb } from '@civup/db'
import { isAuthorizedInternalRequest, isPublicLeaderboardResponse, resolveApprovedDiscordGuildConfiguration } from '@civup/utils'
import { getKnownGuildIdentities } from '../services/discord/guild-metadata.ts'
import {
  buildPublicLeaderboardResponse,
  buildPublicLeaderboardServerCatalog,
  PublicLeaderboardPayloadTooLargeError,
  serializePublicLeaderboardResponse,
} from '../services/leaderboard/public.ts'
import { createStatsContext } from '../services/stats/context.ts'

export const PUBLIC_LEADERBOARD_BOT_CACHE_TTL_SECONDS = 15 * 60
export const PUBLIC_LEADERBOARD_SUCCESS_CACHE_CONTROL = 'public, max-age=300, s-maxage=900'

const PUBLIC_LEADERBOARD_CACHE_VERSION = 1
const PUBLIC_LEADERBOARD_PATH = '/api/public/leaderboards'

export function registerPublicLeaderboardRoutes(app: Hono<Env>) {
  app.get(PUBLIC_LEADERBOARD_PATH, async (c) => {
    if (!isAuthorizedInternalRequest(c.req.raw.headers, c.env.CIVUP_SECRET)) return publicError('Unauthorized', 401)

    const guildConfig = resolveApprovedDiscordGuildConfiguration(c.env)
    if (!guildConfig.ok) return publicError('Approved server configuration is invalid', 503)

    const serverId = parseServerQuery(new URL(c.req.url))
    if (!serverId) return publicError('Exactly one valid server query parameter is required', 400)
    if (!guildConfig.guildIds.includes(serverId)) return publicError('Server is not approved', 403)

    const cacheKey = publicLeaderboardResponseCacheKey(guildConfig.guildIds, serverId)
    const cached = await readCachedResponse(c.env.KV, cacheKey)
    if (cached) return serializedSuccess(cached)

    try {
      const knownServers = await getKnownGuildIdentities(c.env.KV, c.env.DISCORD_TOKEN, guildConfig.guildIds)
      const payload = await buildPublicLeaderboardResponse(
        createDb(c.env.DB),
        c.env.KV,
        createStatsContext(serverId, guildConfig.primaryGuildId),
        buildPublicLeaderboardServerCatalog(guildConfig.primaryGuildId, guildConfig.guildIds, knownServers),
      )
      const serialized = serializePublicLeaderboardResponse(payload)
      await c.env.KV.put(cacheKey, serialized, { expirationTtl: PUBLIC_LEADERBOARD_BOT_CACHE_TTL_SECONDS })
      return serializedSuccess(serialized)
    }
    catch (error) {
      if (error instanceof PublicLeaderboardPayloadTooLargeError) return publicError('Leaderboard payload is too large', 503)
      console.error('[public-leaderboards] projection failed', { serverId }, error)
      return publicError('Leaderboard data could not be assembled', 502)
    }
  })

  app.all(PUBLIC_LEADERBOARD_PATH, () => publicError('Method not allowed', 405))
}

export function publicLeaderboardResponseCacheKey(approvedGuildIds: readonly string[], serverId: string): string {
  return `public:leaderboards:v${PUBLIC_LEADERBOARD_CACHE_VERSION}:${approvedGuildIds.join('.')}:${serverId}`
}

function parseServerQuery(url: URL): string | null {
  const entries = [...url.searchParams.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== 'server') return null
  const serverId = entries[0][1].trim()
  return /^\d{17,20}$/.test(serverId) ? serverId : null
}

async function readCachedResponse(kv: KVNamespace, key: string): Promise<string | null> {
  const serialized = await kv.get(key)
  if (!serialized) return null
  try {
    const parsed: unknown = JSON.parse(serialized)
    return isPublicLeaderboardResponse(parsed) ? serializePublicLeaderboardResponse(parsed) : null
  }
  catch {
    return null
  }
}

function serializedSuccess(serialized: string): Response {
  return new Response(serialized, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': PUBLIC_LEADERBOARD_SUCCESS_CACHE_CONTROL,
    },
  })
}

function publicError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

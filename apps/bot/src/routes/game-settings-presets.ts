import type { Context, Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb } from '@civup/db'
import { CIV_LOBBY_SETTINGS_MAX_COMMUNITY_PRESETS_PER_OWNER, CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES, CivLobbySettingsValidationError } from '@civup/game'
import {
  createGameSettingsPreset,
  deleteGameSettingsPreset,
  listGameSettingsPresets,
  updateGameSettingsPreset,
} from '../services/game-settings-presets.ts'
import { requireAuthenticatedActivity } from './auth.ts'
import { readJsonWithByteLimit, RequestBodyTooLargeError } from './request-body.ts'

const PRESET_REQUEST_MAX_BYTES = CIV_LOBBY_SETTINGS_PROFILE_MAX_BYTES + 2_048

export function registerGameSettingsPresetRoutes(app: Hono<Env>) {
  app.get('/api/game-settings/presets', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const presets = await listGameSettingsPresets(createDb(c.env.DB))
    return c.json({ presets })
  })

  app.post('/api/game-settings/presets', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const body = await readJsonObject(c.req.raw).catch(error => error)
    if (body instanceof RequestBodyTooLargeError) return c.json({ error: body.message }, 413)
    if (!body) return c.json({ error: 'Invalid JSON payload' }, 400)
    try {
      const result = await createGameSettingsPreset(createDb(c.env.DB), {
        ownerDiscordUserId: auth.identity.userId,
        ownerDisplayName: auth.identity.displayName,
        name: body.name,
        profile: body.profile,
      })
      if (!result.ok) return writePresetError(c, result.reason)
      return c.json(result.preset, 201)
    }
    catch (error) {
      return writeValidationError(c, error)
    }
  })

  app.patch('/api/game-settings/presets/:id', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const body = await readJsonObject(c.req.raw).catch(error => error)
    if (body instanceof RequestBodyTooLargeError) return c.json({ error: body.message }, 413)
    if (!body) return c.json({ error: 'Invalid JSON payload' }, 400)
    const revision = parseRevision(body.revision)
    if (revision == null) return c.json({ error: 'revision must be a positive integer' }, 400)
    if (!Object.prototype.hasOwnProperty.call(body, 'name') && !Object.prototype.hasOwnProperty.call(body, 'profile')) {
      return c.json({ error: 'name or profile is required' }, 400)
    }
    try {
      const result = await updateGameSettingsPreset(createDb(c.env.DB), {
        id: c.req.param('id'),
        ownerDiscordUserId: auth.identity.userId,
        ownerDisplayName: auth.identity.displayName,
        revision,
        ...(Object.prototype.hasOwnProperty.call(body, 'name') ? { name: body.name } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, 'profile') ? { profile: body.profile } : {}),
      })
      if (!result.ok) return writePresetError(c, result.reason)
      return c.json(result.preset)
    }
    catch (error) {
      return writeValidationError(c, error)
    }
  })

  app.delete('/api/game-settings/presets/:id', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const body = await readJsonObject(c.req.raw).catch(error => error)
    if (body instanceof RequestBodyTooLargeError) return c.json({ error: body.message }, 413)
    if (!body) return c.json({ error: 'Invalid JSON payload' }, 400)
    const revision = parseRevision(body.revision)
    if (revision == null) return c.json({ error: 'revision must be a positive integer' }, 400)
    const result = await deleteGameSettingsPreset(createDb(c.env.DB), {
      id: c.req.param('id'),
      ownerDiscordUserId: auth.identity.userId,
      revision,
    })
    if (!result.ok) return writePresetError(c, result.reason)
    return new Response(null, { status: 204 })
  })
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await readJsonWithByteLimit(request, PRESET_REQUEST_MAX_BYTES)
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error
    return null
  }
}

function parseRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function writeValidationError(c: Context<Env>, error: unknown): Response {
  if (error instanceof CivLobbySettingsValidationError) return c.json({ error: error.message }, 400)
  throw error
}

function writePresetError(c: Context<Env>, reason: 'limit' | 'conflict' | 'not-found' | 'forbidden' | 'stale'): Response {
  switch (reason) {
    case 'limit': return c.json({ error: `You can create up to ${CIV_LOBBY_SETTINGS_MAX_COMMUNITY_PRESETS_PER_OWNER} public presets.` }, 409)
    case 'conflict': return c.json({ error: 'You already have a preset with that name.' }, 409)
    case 'not-found': return c.json({ error: 'Preset not found.' }, 404)
    case 'forbidden': return c.json({ error: 'Only the preset owner can change it.' }, 403)
    case 'stale': return c.json({ error: 'Preset changed; refresh and try again.' }, 409)
  }
}

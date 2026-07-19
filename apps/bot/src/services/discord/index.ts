export interface DiscordMessagePayload {
  content?: string | null
  embeds?: unknown[]
  components?: unknown
  flags?: number
  allowed_mentions?: {
    parse?: string[]
    roles?: string[]
    users?: string[]
    replied_user?: boolean
  }
}

export interface DiscordInteractionFilePayload {
  applicationId: string
  interactionToken: string
  content?: string
  filename: string
  contentType: string
  data: Uint8Array
  flags?: number
}

export interface DiscordChannelFilePayload {
  token: string
  channelId: string
  messageId?: string
  content?: string | null
  filename: string
  contentType: string
  data: Uint8Array
  embeds?: unknown[]
  components?: unknown
}

export interface DiscordInteractionFollowupPayload {
  applicationId: string
  interactionToken: string
  payload: DiscordMessagePayload
}

export interface DiscordGuildRolePayload {
  name: string
  color?: number
  hoist?: boolean
  mentionable?: boolean
  permissions?: string
}

export interface DiscordGuildRoleResponse {
  id: string
  name?: string
  hoist?: boolean
  managed?: boolean
  mentionable?: boolean
  permissions?: string
}

export interface DiscordGuildMemberResponse {
  nick?: string | null
  avatar?: string | null
  user?: {
    id?: string
    username?: string
    global_name?: string | null
    avatar?: string | null
  }
}

interface DiscordMessageResponse {
  id: string
}

interface DiscordDmChannelResponse {
  id: string
}

interface DiscordErrorPayload {
  retry_after?: number
  code?: number
}

const MAX_DISCORD_RETRIES = 2

export class DiscordApiError extends Error {
  status: number
  detail: string
  code?: number

  constructor(action: string, status: number, detail: string) {
    super(`Discord ${action} failed: ${status} ${detail}`)
    this.name = 'DiscordApiError'
    this.status = status
    this.detail = detail
    const code = parseDiscordErrorPayload(detail)?.code
    this.code = typeof code === 'number' ? code : undefined
  }
}

export function isDiscordApiError(error: unknown, status?: number): error is DiscordApiError {
  if (!(error instanceof DiscordApiError)) return false
  if (status == null) return true
  return error.status === status
}

export function isDiscordApiErrorCode(error: unknown, code: number): error is DiscordApiError {
  return error instanceof DiscordApiError && error.code === code
}

export async function createChannelMessage(
  token: string,
  channelId: string,
  payload: DiscordMessagePayload,
): Promise<DiscordMessageResponse> {
  const response = await requestDiscord(
    'create message',
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  )

  return response.json<DiscordMessageResponse>()
}

export async function createChannelMessageWithFile(payload: DiscordChannelFilePayload): Promise<DiscordMessageResponse> {
  const response = await requestDiscord(
    'create message',
    `https://discord.com/api/v10/channels/${payload.channelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${payload.token}`,
      },
      body: buildDiscordFileForm(payload),
    },
  )

  return response.json<DiscordMessageResponse>()
}

export async function editOriginalInteractionResponseWithFile(payload: DiscordInteractionFilePayload): Promise<void> {
  const form = new FormData()
  const messagePayload: Record<string, unknown> = {
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: payload.filename }],
  }
  if (payload.content != null) messagePayload.content = payload.content

  form.append('payload_json', JSON.stringify(messagePayload))
  form.append('files[0]', new Blob([payload.data], { type: payload.contentType }), payload.filename)

  await requestDiscord(
    'edit interaction response',
    `https://discord.com/api/v10/webhooks/${payload.applicationId}/${payload.interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      body: form,
    },
  )
}

export async function createInteractionFollowupMessageWithFile(payload: DiscordInteractionFilePayload): Promise<DiscordMessageResponse> {
  const form = new FormData()
  const messagePayload: Record<string, unknown> = {
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: payload.filename }],
  }
  if (payload.content != null) messagePayload.content = payload.content
  if (payload.flags != null) messagePayload.flags = payload.flags

  form.append('payload_json', JSON.stringify(messagePayload))
  form.append('files[0]', new Blob([payload.data], { type: payload.contentType }), payload.filename)

  const response = await requestDiscord(
    'create interaction followup',
    `https://discord.com/api/v10/webhooks/${payload.applicationId}/${payload.interactionToken}`,
    {
      method: 'POST',
      body: form,
    },
  )

  return response.json<DiscordMessageResponse>()
}

export async function createInteractionFollowupMessage(payload: DiscordInteractionFollowupPayload): Promise<DiscordMessageResponse> {
  const response = await requestDiscord(
    'create interaction followup',
    `https://discord.com/api/v10/webhooks/${payload.applicationId}/${payload.interactionToken}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload.payload),
    },
  )

  return response.json<DiscordMessageResponse>()
}

export async function createDmChannel(
  token: string,
  userId: string,
): Promise<DiscordDmChannelResponse> {
  const response = await requestDiscord(
    'create dm channel',
    'https://discord.com/api/v10/users/@me/channels',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: userId }),
    },
  )

  return response.json<DiscordDmChannelResponse>()
}

export async function fetchGuildMember(
  token: string,
  guildId: string,
  userId: string,
): Promise<DiscordGuildMemberResponse> {
  const response = await requestDiscord(
    'fetch guild member',
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  )

  return response.json<DiscordGuildMemberResponse>()
}

export async function editChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  await requestDiscord(
    'edit message',
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  )
}

export async function editChannelMessageWithFile(payload: DiscordChannelFilePayload & { messageId: string }): Promise<void> {
  await requestDiscord(
    'edit message',
    `https://discord.com/api/v10/channels/${payload.channelId}/messages/${payload.messageId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${payload.token}`,
      },
      body: buildDiscordFileForm(payload),
    },
  )
}

export async function deleteChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await requestDiscord(
    'delete message',
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  )
}

export async function unarchiveThread(token: string, channelId: string): Promise<void> {
  await requestDiscord(
    'unarchive thread',
    `https://discord.com/api/v10/channels/${channelId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archived: false }),
    },
  )
}

function buildDiscordFileForm(payload: DiscordChannelFilePayload): FormData {
  const form = new FormData()
  const messagePayload: Record<string, unknown> = {
    content: payload.content ?? null,
    embeds: payload.embeds ?? [],
    components: payload.components ?? [],
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: payload.filename }],
  }

  form.append('payload_json', JSON.stringify(messagePayload))
  form.append('files[0]', new Blob([payload.data], { type: payload.contentType }), payload.filename)
  return form
}

export async function editGuildMemberRoles(
  token: string,
  guildId: string,
  userId: string,
  roleIds: string[],
): Promise<void> {
  await requestDiscord(
    'edit guild member roles',
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ roles: roleIds }),
    },
  )
}

export async function addGuildMemberRole(
  token: string,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await requestDiscord(
    'add guild member role',
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  )
}

export async function removeGuildMemberRole(
  token: string,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await requestDiscord(
    'remove guild member role',
    `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  )
}

export async function createGuildRole(
  token: string,
  guildId: string,
  payload: DiscordGuildRolePayload,
): Promise<DiscordGuildRoleResponse> {
  const response = await requestDiscord(
    'create guild role',
    `https://discord.com/api/v10/guilds/${guildId}/roles`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  )

  return response.json<DiscordGuildRoleResponse>()
}

export async function updateGuildRole(
  token: string,
  guildId: string,
  roleId: string,
  payload: DiscordGuildRolePayload,
): Promise<DiscordGuildRoleResponse> {
  const response = await requestDiscord(
    'update guild role',
    `https://discord.com/api/v10/guilds/${guildId}/roles/${roleId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  )

  return response.json<DiscordGuildRoleResponse>()
}

export async function fetchGuildRoles(
  token: string,
  guildId: string,
): Promise<DiscordGuildRoleResponse[]> {
  const response = await requestDiscord(
    'fetch guild roles',
    `https://discord.com/api/v10/guilds/${guildId}/roles`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  )
  const payload = await response.json<unknown>()
  if (!Array.isArray(payload)) return []
  return payload.filter((role): role is DiscordGuildRoleResponse => {
    return role != null && typeof role === 'object' && typeof (role as { id?: unknown }).id === 'string'
  })
}

export async function deleteGuildRole(
  token: string,
  guildId: string,
  roleId: string,
): Promise<void> {
  await requestDiscord(
    'delete guild role',
    `https://discord.com/api/v10/guilds/${guildId}/roles/${roleId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
  )
}

async function requestDiscord(
  action: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_DISCORD_RETRIES; attempt++) {
    const response = await fetch(url, init)
    if (response.ok) return response

    const detail = await response.text()
    const isRetriable = response.status === 429 || response.status >= 500
    if (!isRetriable || attempt === MAX_DISCORD_RETRIES) {
      throw new DiscordApiError(action, response.status, detail)
    }

    const retryMs = calculateRetryDelayMs(response, detail, attempt)
    await new Promise(resolve => setTimeout(resolve, retryMs))
  }

  throw new DiscordApiError(action, 500, 'Retry loop exited unexpectedly')
}

function calculateRetryDelayMs(response: Response, detail: string, attempt: number): number {
  const headerRetryAfter = response.headers.get('retry-after')
  if (headerRetryAfter) {
    const parsed = Number.parseFloat(headerRetryAfter)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed * 1000)
  }

  if (response.status === 429) {
    const parsedPayload = parseDiscordErrorPayload(detail)
    const retryAfter = parsedPayload?.retry_after
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.ceil(retryAfter * 1000)
    }
  }

  return 250 * (attempt + 1)
}

function parseDiscordErrorPayload(detail: string): DiscordErrorPayload | null {
  try {
    const parsed: unknown = JSON.parse(detail)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as DiscordErrorPayload
  }
  catch {
    return null
  }
}

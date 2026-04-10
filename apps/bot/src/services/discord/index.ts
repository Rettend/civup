export interface DiscordMessagePayload {
  content?: string | null
  embeds?: unknown[]
  components?: unknown
  files?: DiscordFilePayload[]
  allowed_mentions?: {
    parse?: string[]
    roles?: string[]
    users?: string[]
    replied_user?: boolean
  }
}

export interface DiscordFilePayload {
  filename: string
  contentType?: string
  data: ArrayBuffer | Uint8Array
  description?: string
}

export interface DiscordGuildRolePayload {
  name: string
  color?: number
}

interface DiscordMessageResponse {
  id: string
}

interface DiscordGuildRoleResponse {
  id: string
}

interface DiscordDmChannelResponse {
  id: string
}

interface DiscordErrorPayload {
  retry_after?: number
}

const MAX_DISCORD_RETRIES = 2

export class DiscordApiError extends Error {
  status: number
  detail: string

  constructor(action: string, status: number, detail: string) {
    super(`Discord ${action} failed: ${status} ${detail}`)
    this.name = 'DiscordApiError'
    this.status = status
    this.detail = detail
  }
}

export function isDiscordApiError(error: unknown, status?: number): error is DiscordApiError {
  if (!(error instanceof DiscordApiError)) return false
  if (status == null) return true
  return error.status === status
}

export async function createChannelMessage(
  token: string,
  channelId: string,
  payload: DiscordMessagePayload,
): Promise<DiscordMessageResponse> {
  const request = buildDiscordMessageRequest(token, payload)
  const response = await requestDiscord(
    'create message',
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { method: 'POST', ...request },
  )

  return await response.json() as DiscordMessageResponse
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

  return await response.json() as DiscordDmChannelResponse
}

export async function editChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  const request = buildDiscordMessageRequest(token, payload)
  await requestDiscord(
    'edit message',
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { method: 'PATCH', ...request },
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

  return await response.json() as DiscordGuildRoleResponse
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
    const parsed = JSON.parse(detail) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as DiscordErrorPayload
  }
  catch {
    return null
  }
}

function buildDiscordMessageRequest(
  token: string,
  payload: DiscordMessagePayload,
): Pick<RequestInit, 'headers' | 'body'> {
  if (!payload.files || payload.files.length === 0) {
    const { files: _files, ...jsonPayload } = payload
    return {
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jsonPayload),
    }
  }

  const formData = new FormData()
  const files = payload.files
  const jsonPayload = {
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    allowed_mentions: payload.allowed_mentions,
    attachments: files.map((file, index) => ({
      id: index,
      filename: file.filename,
      description: file.description,
    })),
  }

  formData.set('payload_json', JSON.stringify(jsonPayload))
  files.forEach((file, index) => {
    formData.set(
      `files[${index}]`,
      new Blob([toUint8Array(file.data)], {
        type: file.contentType ?? 'application/octet-stream',
      }),
      file.filename,
    )
  })

  return {
    headers: {
      'Authorization': `Bot ${token}`,
    },
    body: formData,
  }
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

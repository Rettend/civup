export interface DiscordMessagePayload {
  content?: string | null
  embeds?: unknown[]
  components?: unknown
}

interface DiscordMessageResponse {
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

  return await response.json() as DiscordMessageResponse
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

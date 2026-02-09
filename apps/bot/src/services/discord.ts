export interface DiscordMessagePayload {
  content?: string | null
  embeds?: unknown[]
  components?: unknown
}

interface DiscordMessageResponse {
  id: string
}

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
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new DiscordApiError('create message', response.status, detail)
  }

  return await response.json() as DiscordMessageResponse
}

export async function editChannelMessage(
  token: string,
  channelId: string,
  messageId: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new DiscordApiError('edit message', response.status, detail)
  }
}

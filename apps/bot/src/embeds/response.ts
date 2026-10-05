import { Embed } from 'discord-hono'

export type EphemeralResponseTone = 'error' | 'info' | 'success'

const RESPONSE_COLORS: Record<EphemeralResponseTone, number> = {
  error: 0xdc2626,
  info: 0x6b7280,
  success: 0x2563eb,
}

export function ephemeralResponseEmbed(message: string, tone: EphemeralResponseTone): Embed {
  const text = message.trim()
  return new Embed().description(text).color(RESPONSE_COLORS[tone])
}

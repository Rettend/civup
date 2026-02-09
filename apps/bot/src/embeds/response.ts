import { Embed } from 'discord-hono'

export type EphemeralResponseTone = 'error' | 'info' | 'success'

const RESPONSE_COLORS: Record<EphemeralResponseTone, number> = {
  error: 0xDC2626,
  info: 0x6B7280,
  success: 0x2563EB,
}

export function ephemeralResponseEmbed(message: string, tone: EphemeralResponseTone): Embed {
  const text = message.trim()
  return new Embed()
    .description(text)
    .color(RESPONSE_COLORS[tone])
}

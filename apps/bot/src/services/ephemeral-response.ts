import type { EphemeralResponseTone } from '../embeds/response.ts'
import { ephemeralResponseEmbed } from '../embeds/response.ts'

export const TRANSIENT_EPHEMERAL_DELETE_MS = 10_000

interface TransientEphemeralContext {
  executionCtx: {
    waitUntil: (promise: Promise<unknown>) => void
  }
  followup: (data?: any) => Promise<unknown>
}

interface DeferredEphemeralContext {
  followup: () => Promise<unknown>
}

export async function clearDeferredEphemeralResponse(c: DeferredEphemeralContext): Promise<void> {
  await c.followup()
}

export async function sendTransientEphemeralResponse(
  c: TransientEphemeralContext,
  message: string,
  tone: EphemeralResponseTone,
): Promise<void> {
  await sendEphemeralResponse(c, message, tone, { autoDeleteMs: TRANSIENT_EPHEMERAL_DELETE_MS })
}

export async function sendEphemeralResponse(
  c: TransientEphemeralContext,
  message: string,
  tone: EphemeralResponseTone,
  options?: {
    components?: unknown
    autoDeleteMs?: number | null
  },
): Promise<void> {
  await c.followup({
    embeds: [ephemeralResponseEmbed(message, tone)],
    components: options?.components,
  })

  const autoDeleteMs = options?.autoDeleteMs
  if (autoDeleteMs == null || autoDeleteMs <= 0) return

  c.executionCtx.waitUntil((async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, autoDeleteMs))
      await c.followup()
    }
    catch (error) {
      console.error('Failed to auto-delete ephemeral response message:', error)
    }
  })())
}

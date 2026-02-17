import { Button, Components } from 'discord-hono'
import type { EphemeralResponseTone } from '../embeds/response.ts'
import { ephemeralResponseEmbed } from '../embeds/response.ts'

export const TRANSIENT_EPHEMERAL_DELETE_MS = 10_000
export const SHOW_EPHEMERAL_RESPONSE_BUTTON_ID = 'admin-show-response'

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
  options?: {
    showButton?: boolean
  },
): Promise<void> {
  await sendEphemeralResponse(c, message, tone, {
    autoDeleteMs: TRANSIENT_EPHEMERAL_DELETE_MS,
    showButton: options?.showButton,
  })
}

export async function sendEphemeralResponse(
  c: TransientEphemeralContext,
  message: string,
  tone: EphemeralResponseTone,
  options?: {
    components?: unknown
    autoDeleteMs?: number | null
    showButton?: boolean
  },
): Promise<void> {
  const components = resolveResponseComponents(options?.components, options?.showButton ?? false)

  await c.followup({
    embeds: [ephemeralResponseEmbed(message, tone)],
    components,
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

function resolveResponseComponents(baseComponents: unknown, showButton: boolean): unknown {
  if (!showButton) return baseComponents

  const rows = normalizeComponentRows(baseComponents)
  rows.push(...showButtonRows())
  return rows
}

function normalizeComponentRows(components: unknown): unknown[] {
  if (!components) return []
  if (Array.isArray(components)) return [...components]

  if (typeof components === 'object' && components !== null) {
    const toJSON = (components as { toJSON?: () => unknown }).toJSON
    if (typeof toJSON === 'function') {
      const json = toJSON.call(components)
      if (!json) return []
      return Array.isArray(json) ? [...json] : [json]
    }
  }

  return [components]
}

function showButtonRows(): unknown[] {
  return normalizeComponentRows(
    new Components().row(
      new Button(SHOW_EPHEMERAL_RESPONSE_BUTTON_ID, 'Show', 'Secondary'),
    ),
  )
}

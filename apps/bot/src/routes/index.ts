import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { registerActivityRoutes } from './activity.ts'
import { registerLobbyRoutes } from './lobby/index.ts'
import { registerMatchRoutes } from './match.ts'
import { registerWebhookRoutes } from './webhooks.ts'

export function registerApiRoutes(app: Hono<Env>) {
  registerActivityRoutes(app)
  registerLobbyRoutes(app)
  registerMatchRoutes(app)
  registerWebhookRoutes(app)
}

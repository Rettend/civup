import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import { registerActivityAdminRoutes } from './activity-admin.ts'
import { registerActivityRoutes } from './activity.ts'
import { registerLobbyRoutes } from './lobby/index.ts'
import { registerMatchRoutes } from './match.ts'
import { registerUploadRoutes } from './uploads.ts'

export function registerApiRoutes(app: Hono<Env>) {
  registerActivityAdminRoutes(app)
  registerActivityRoutes(app)
  registerLobbyRoutes(app)
  registerMatchRoutes(app)
  registerUploadRoutes(app)
}

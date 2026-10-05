import type { Env } from '../env.ts'
import type { Hono } from 'hono'
import { registerActivityAdminRoutes } from './activity-admin.ts'
import { registerActivityRoutes } from './activity.ts'
import { registerDivisionRoleRoutes } from './division-roles.ts'
import { registerLobbyRoutes } from './lobby/index.ts'
import { registerMatchRoutes } from './match.ts'
import { registerUploadRoutes } from './uploads.ts'

export function registerApiRoutes(app: Hono<Env>) {
  registerActivityAdminRoutes(app)
  registerActivityRoutes(app)
  registerLobbyRoutes(app)
  registerMatchRoutes(app)
  registerUploadRoutes(app)
  registerDivisionRoleRoutes(app)
}

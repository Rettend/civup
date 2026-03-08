import type { Env } from './env.ts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { registerApiRoutes } from './routes/index.ts'
import { factory } from './setup.ts'

const discordApp = factory.discord().loader([
  ...Object.values(commands),
  ...Object.values(cron),
])

const app = new Hono<Env>()

app.onError((error, c) => {
  console.error('[bot:unhandled]', c.req.method, new URL(c.req.url).pathname, error)
  return c.json({ error: 'Internal Server Error' }, 500)
})

app.use('/api/*', cors())
registerApiRoutes(app)

app.mount('/', discordApp.fetch)

const worker: ExportedHandler<Env['Bindings']> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  scheduled(controller, env, ctx) {
    const cronEvent = {
      ...controller,
      type: 'scheduled',
    } as Parameters<typeof discordApp.scheduled>[0]
    return discordApp.scheduled(cronEvent, env, ctx)
  },
}

export default worker

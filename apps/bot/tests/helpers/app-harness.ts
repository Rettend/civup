import type { Env } from '../../src/env.ts'
import { Hono } from 'hono'
import { registerApiRoutes } from '../../src/routes/index.ts'

export interface ExecutionContextHarness {
  executionCtx: ExecutionContext
  flushBackgroundTasks: () => Promise<void>
}

export function createBotTestApp(): Hono<Env> {
  const app = new Hono<Env>()
  registerApiRoutes(app)
  return app
}

export function buildBotTestEnv(bindings: Env['Bindings']): Env['Bindings'] {
  return {
    ALLOWED_DISCORD_GUILD_ID: '1234044388733095946',
    ...bindings,
  }
}

export function createExecutionContextHarness(): ExecutionContextHarness {
  const pending = new Set<Promise<unknown>>()

  const executionCtx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      const tracked = Promise.resolve(promise).finally(() => pending.delete(tracked))
      pending.add(tracked)
    },
    passThroughOnException() {},
  }

  return {
    executionCtx,
    async flushBackgroundTasks() {
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    },
  }
}

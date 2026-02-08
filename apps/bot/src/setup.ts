import type { Env } from './env.ts'
import { createFactory } from 'discord-hono'

export const factory = createFactory<Env>()

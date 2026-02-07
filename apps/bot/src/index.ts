import * as commands from './commands/index.ts'
import * as cron from './cron/cleanup.ts'
import { factory } from './setup.ts'

const app = factory.discord().loader([
  ...Object.values(commands),
  ...Object.values(cron),
])

export default app

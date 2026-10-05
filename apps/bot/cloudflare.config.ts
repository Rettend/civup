import process from 'node:process'
import { defineConfig } from 'cf/config'
import { resolveCloudflareTarget } from '../../config/cloudflare-targets.ts'
import { createBotCloudflareConfig } from '../../config/cloudflare-workers.ts'

// Native cf cannot preserve DO tags and keep_vars yet. Bot deployment uses
// the derived Wrangler adapter in config/cloudflare-workers.ts instead.
export default defineConfig(() =>
  createBotCloudflareConfig(
    resolveCloudflareTarget(process.env.CIVUP_TARGET, {
      localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE,
    }),
  ),
)

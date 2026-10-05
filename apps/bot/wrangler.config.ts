import process from 'node:process'
import { defineWranglerConfig } from 'wrangler/experimental-config'
import { resolveCloudflareTarget } from '../../config/cloudflare-targets.ts'
import { createBotWranglerConfig } from '../../config/cloudflare-workers.ts'

export default defineWranglerConfig(() =>
  createBotWranglerConfig(
    resolveCloudflareTarget(process.env.CIVUP_TARGET, {
      localTargetsFile: process.env.CIVUP_LOCAL_TARGETS_FILE,
    }),
  ),
)

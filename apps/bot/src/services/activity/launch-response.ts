import type { Env } from '../../env.ts'
import type { ActivityLaunchTargetSelection } from './launch-target.ts'
import { Button, Components } from 'discord-hono'
import { ephemeralResponseEmbed } from '../../embeds/response.ts'
import type { LaunchModeResolution } from './browser-access.ts'
import { buildBrowserChannelUrl, buildBrowserSessionUrl, resolveInteractionLaunchMode } from './browser-access.ts'
import { storeActivityLaunchTargetSelection } from './launch-target.ts'

export type LaunchDestination
  = | { kind: 'channel', channelId: string }
    | { kind: 'session', sessionId: string }

interface LaunchInteractionContext {
  env: Env['Bindings']
  interaction: {
    member?: { roles?: unknown } | null
    guild_id?: string | null
  }
  flags: (flag: 'EPHEMERAL') => any
  resActivity: () => Response
}

export async function respondWithPreferredLaunch(
  c: LaunchInteractionContext,
  input: {
    destination: LaunchDestination
    activityChannelId: string | null
    activityUserId: string
    activityTarget: ActivityLaunchTargetSelection
    launch?: LaunchModeResolution
  },
): Promise<Response> {
  const launch = input.launch ?? await resolveInteractionLaunchMode(c.env, c.interaction.member?.roles, c.interaction.guild_id)
  if (!launch.ok) return privateLaunchError(c, launch.error)

  if (launch.mode === 'activity') {
    await storeActivityLaunchTargetSelection(
      c.env.Activity,
      c.env.CIVUP_SECRET,
      input.activityChannelId,
      input.activityUserId,
      input.activityTarget,
    )
    return c.resActivity()
  }

  if (!launch.config) return privateLaunchError(c, 'Browser access is not configured.')
  const url = input.destination.kind === 'session'
    ? buildBrowserSessionUrl(launch.config, input.destination.sessionId)
    : buildBrowserChannelUrl(launch.config, input.destination.channelId)

  return c.flags('EPHEMERAL').res({
    components: new Components().row(new Button(url, 'Open in Browser', 'Link')),
  })
}

export function privateLaunchError(c: Pick<LaunchInteractionContext, 'flags'>, message: string): Response {
  return c.flags('EPHEMERAL').res({ embeds: [ephemeralResponseEmbed(message, 'error')] })
}

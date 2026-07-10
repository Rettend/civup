import type { ActivityIdentity } from '@civup/utils'

export type ClientSurface = 'discord-embedded' | 'web'
export type AuthTransport = 'token' | 'cookie'

export type LaunchContext
  = | { kind: 'channel', channelId: string }
    | { kind: 'session', sessionId: string }

export interface ClientBootstrap {
  surface: ClientSurface
  identity: ActivityIdentity
  authTransport: AuthTransport
  launchContext: LaunchContext
}

import type { AuthTransport, ClientSurface } from './types'

let surface: ClientSurface = 'discord-embedded'
let authTransport: AuthTransport = 'token'

export function configureClientPlatform(nextSurface: ClientSurface, nextAuthTransport: AuthTransport): void {
  surface = nextSurface
  authTransport = nextAuthTransport
}

export function getClientSurface(): ClientSurface {
  return surface
}

export function getAuthTransport(): AuthTransport {
  return authTransport
}

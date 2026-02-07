import type { CommandResponse } from '@discord/embedded-app-sdk'
import { DiscordSDK } from '@discord/embedded-app-sdk'

export type Auth = CommandResponse<'authenticate'>

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string

/** Discord SDK instance — constructor establishes RPC transport, nothing travels network until ready() */
export const discordSdk = new DiscordSDK(CLIENT_ID)

/** Full Discord Activity auth flow: ready() -> authorize() -> POST /api/token -> authenticate() */
export async function setupDiscordSdk(): Promise<Auth> {
  // Step 1: Wait for READY from Discord client
  await discordSdk.ready()

  // Step 2: Authorize — opens OAuth modal, returns a code
  const { code } = await discordSdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: [
      'identify',
      'guilds',
      'guilds.members.read',
      'rpc.voice.read',
    ],
  })

  // Step 3: Exchange code for access_token via our Worker
  // In production, Discord proxies this through the activity iframe origin.
  // In dev, Vite's proxy handles it (see vite.config.ts).
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }

  const { access_token } = await response.json() as { access_token: string }

  // Step 4: Authenticate the SDK session
  const auth = await discordSdk.commands.authenticate({ access_token })

  if (!auth) {
    throw new Error('Discord authenticate command failed')
  }

  return auth
}

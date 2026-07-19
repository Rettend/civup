import { getClientSurface } from './runtime'

export async function openExternalLink(url: string): Promise<boolean> {
  if (getClientSurface() === 'web') {
    window.open(url, '_blank', 'noopener')
    return true
  }

  try {
    const { discordSdk } = await import('../discord')
    const response = await discordSdk.commands.openExternalLink({ url })
    if (response?.opened === true) return true
  }
  catch {}
  return false
}

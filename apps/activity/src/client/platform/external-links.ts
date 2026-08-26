<<<<<<< New base: feat: save file analyzer
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
|||||||
=======
import { getClientSurface } from './runtime'

export async function openExternalLink(url: string): Promise<boolean> {
  if (getClientSurface() === 'web') {
    return window.open(url, '_blank', 'noopener') != null
  }

  try {
    const { discordSdk } = await import('../discord')
    const response = await discordSdk.commands.openExternalLink({ url })
    if (response?.opened === true) return true
  }
  catch {}
  return false
}
>>>>>>> Current commit: feat: external browser draft WIP

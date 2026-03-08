import { isDev as sharedIsDev } from '@civup/utils'

const ACTIVITY_HOST = import.meta.env.VITE_ACTIVITY_HOST as string | undefined
const BOT_HOST = import.meta.env.VITE_BOT_HOST as string | undefined

export function isDev() {
  return sharedIsDev({
    viteDev: import.meta.env.DEV,
    host: typeof window !== 'undefined' ? window.location.hostname : undefined,
    configuredHosts: [ACTIVITY_HOST, BOT_HOST],
  })
}

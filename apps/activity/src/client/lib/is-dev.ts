import { isDev as sharedIsDev } from '@civup/utils'

export function isDev() {
  return sharedIsDev({
    viteDev: import.meta.env.DEV,
    host: typeof window !== 'undefined' ? window.location.hostname : undefined,
  })
}

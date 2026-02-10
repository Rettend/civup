/* @refresh reload */
import { render } from 'solid-js/web'
import { relayDevLog } from './lib/dev-log'
import '@fontsource-variable/inter'
import 'virtual:uno.css'

function setupGlobalDevErrorRelay() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return

  window.addEventListener('error', (event) => {
    relayDevLog('error', 'Global window error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    relayDevLog('error', 'Unhandled promise rejection', event.reason)
  })
}

async function bootstrap() {
  setupGlobalDevErrorRelay()

  relayDevLog('info', 'Activity bootstrap started', {
    search: typeof window !== 'undefined' ? window.location.search : '',
  })

  const { default: App } = await import('./App')

  const root = document.getElementById('root')

  if (!root) {
    throw new Error('Root element #root not found')
  }

  render(() => <App />, root)
}

void bootstrap().catch((error) => {
  relayDevLog('error', 'Activity bootstrap failed', error)
  console.error(error)
})

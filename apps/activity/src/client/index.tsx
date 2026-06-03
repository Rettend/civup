import { render } from 'solid-js/web'
import { relayDevLog, shouldRelayDevLog } from './lib/dev-log'
import '@fontsource-variable/inter'
import 'virtual:uno.css'

declare global {
  interface Window {
    __civupDevErrorRelaySetup?: boolean
  }
}

let disposeRoot = import.meta.hot?.data.disposeRoot as ReturnType<typeof render> | undefined

function setupGlobalDevErrorRelay() {
  if (!shouldRelayDevLog() || typeof window === 'undefined') return
  if (window.__civupDevErrorRelaySetup) return
  window.__civupDevErrorRelaySetup = true

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

  const { default: App } = await import('./App')

  const root = document.getElementById('root')

  if (!root) {
    throw new Error('Root element #root not found')
  }

  disposeRoot?.()
  root.textContent = ''
  disposeRoot = render(() => <App />, root)

  if (import.meta.hot) {
    import.meta.hot.data.disposeRoot = disposeRoot
  }
}

void bootstrap().catch((error) => {
  relayDevLog('error', 'Activity bootstrap failed', error)
  console.error(error)
})

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose((data) => {
    data.disposeRoot = disposeRoot
  })
}

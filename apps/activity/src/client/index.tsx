/* @refresh reload */
import { render } from '@solidjs/web'
import { postDevTrace, updateDevOverlay } from './lib/debug-trace'
import { relayDevLog, shouldRelayDevLog } from './lib/dev-log'
import '@fontsource-variable/inter'
import 'virtual:uno.css'

function setupGlobalDevErrorRelay() {
  if (!shouldRelayDevLog() || typeof window === 'undefined') return

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

function setupRootObserver(root: HTMLElement) {
  updateDevOverlay('Activity boot', { phase: 'root-ready' })

  const report = (reason: string) => {
    const bodyText = root.textContent?.trim().replace(/\s+/g, ' ').slice(0, 240) ?? ''
    updateDevOverlay('Activity DOM', {
      reason,
      rootChildren: root.childElementCount,
      text: bodyText || '[empty]',
    })
    postDevTrace('Activity root snapshot', {
      reason,
      rootChildren: root.childElementCount,
      text: bodyText || '[empty]',
    })
  }

  report('initial')

  const observer = new MutationObserver(() => report('mutation'))
  observer.observe(root, { childList: true, subtree: true, characterData: true })
}

async function bootstrap() {
  setupGlobalDevErrorRelay()

  const { default: App } = await import('./App')

  const root = document.getElementById('root')

  if (!root) {
    throw new Error('Root element #root not found')
  }

  render(() => <App />, root)
  setupRootObserver(root)
}

void bootstrap().catch((error) => {
  relayDevLog('error', 'Activity bootstrap failed', error)
  console.error(error)
})

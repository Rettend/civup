import { createSignal, Show } from 'solid-js'
import { buildStartupDiagnostics, copyStartupDiagnostics } from '../lib/startup-diagnostics'

export function CopyDiagnostics() {
  const [copied, setCopied] = createSignal(false)
  const [manualCopy, setManualCopy] = createSignal('')
  const copy = async () => {
    const report = buildStartupDiagnostics()
    setCopied(false)
    if (await copyStartupDiagnostics(report)) {
      setManualCopy('')
      setCopied(true)
    } else {
      setManualCopy(report)
    }
  }
  return (
    <div class="mt-4">
      <button
        type="button"
        class="text-xs text-fg-muted hover:text-fg underline underline-offset-4 cursor-pointer"
        onClick={() => void copy()}
      >
        {copied() ? 'Copied' : 'Copy diagnostics'}
      </button>
      <span class="sr-only" role="status">
        {copied() ? 'Diagnostics copied.' : ''}
      </span>
      <Show when={manualCopy()}>
        <label class="block mt-3 text-xs text-fg-muted">
          Copy this text and send it with your bug report.
          <textarea
            aria-label="Connection diagnostics"
            class="block mt-2 w-full min-w-64 max-w-full h-32 p-2 text-xs text-fg bg-bg border border-border rounded font-mono"
            readonly
            value={manualCopy()}
            onFocus={event => event.currentTarget.select()}
          />
        </label>
      </Show>
    </div>
  )
}

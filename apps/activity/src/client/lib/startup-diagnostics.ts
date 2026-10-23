// Local, bounded startup diagnostics. Never retain SDK payloads, request data or storage.
const startedAt = Date.now()
const entries: { elapsedMs: number; stage: string; outcome: string; error?: unknown }[] = []
let currentStage = 'starting'
let stageStartedAt = startedAt
let installed = false
const SDK_FIELDS = new Set([
  'data',
  'cmd',
  'evt',
  'nonce',
  'code',
  'message',
  'user',
  'member',
  'id',
  'username',
  'global_name',
  'display_name',
  'discriminator',
  'avatar',
  'flags',
  'public_flags',
  'primary_guild',
  'guild_id',
  'channel_id',
  'application',
  'scopes',
  'expires',
  'access_token',
  'locale',
  'premium_type',
  'avatar_decoration_data',
  'permissions',
  'config',
  'api_endpoint',
  'session_id',
])
const SDK_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'])

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s)]+/gi, '[url]')
    .replace(/(?:\/[\w./%-]+)?[?#][^\s)]+/g, '[url details omitted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(?:[\w.-]*(?:token|secret|password|cookie|authorization)[\w.-]*|code)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted]',
    )
    .replace(/\b(?:payload|headers|storage|response body)\s*[:=][\s\S]*/gi, '[details omitted]')
    .replace(
      /\b(?:access[ _-]?token|session[ _-]?token|auth(?:orization)?[ _-]?code|cookies?|password|secret)\b[\s\S]*/gi,
      '[private details omitted]',
    )
    .replace(/\{[\s\S]*\}|\[[\s\S]*\]/g, '[structured details omitted]')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '[quoted value omitted]')
    .replace(/\b[\w.-]{24,}\b/g, '[opaque value omitted]')
    .slice(0, 1200)
}

function safeStackFrame(frame: string): string {
  // Keep asset line/column positions useful without copying origins or URL parameters.
  const location = frame.match(/https?:\/\/[^\s)]+/i)?.[0]
  if (!location) return sanitizeDiagnosticText(frame)
  const position = location.match(/:(\d+):(\d+)$/)
  const path = (position ? location.slice(0, position.index) : location).split(/[?#]/)[0]!
  const asset = path.match(/\/assets\/([\w.-]+\.js)$/)?.[1]
  const safeLocation = asset ? `${asset}${position ? `:${position[1]}:${position[2]}` : ''}` : 'script'
  return `${sanitizeDiagnosticText(frame.replace(location, 'script'))} (${safeLocation})`
}

function safeError(error: unknown): unknown {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  const numericCode = typeof code === 'number' && Number.isFinite(code) ? { code } : {}
  if (!(error instanceof Error))
    return { name: 'Unknown rejection', message: 'Non-Error details omitted', ...numericCode }
  // Zod errors can embed the entire received SDK payload in their message.
  const issues = (error as Error & { issues?: unknown }).issues
  return {
    name: sanitizeDiagnosticText(error.name),
    ...numericCode,
    ...(typeof (error as Error & { status?: unknown }).status === 'number'
      ? { status: (error as Error & { status: number }).status }
      : {}),
    message: Array.isArray(issues) ? 'SDK validation failed' : sanitizeDiagnosticText(error.message),
    ...(Array.isArray(issues)
      ? {
          issues: issues.slice(0, 12).map(issue => {
            const detail = issue as { code?: unknown; path?: unknown; expected?: unknown }
            const issueCode = detail?.code
            return {
              code: typeof issueCode === 'string' && /^[a-z_]{1,40}$/.test(issueCode) ? issueCode : 'validation_error',
              path: Array.isArray(detail?.path)
                ? detail.path
                    .slice(0, 10)
                    .map(part => (typeof part === 'string' && SDK_FIELDS.has(part) ? part : '[field]'))
                : [],
              expected:
                typeof detail?.expected === 'string' && SDK_TYPES.has(detail.expected) ? detail.expected : undefined,
            }
          }),
        }
      : {}),
    // Only stack frames, never the repeated error message or custom attached data.
    stack: error.stack
      ?.split('\n')
      .filter(line => /^\s*at\s/.test(line))
      .slice(0, 10)
      .map(safeStackFrame),
  }
}

export function recordStartupDiagnostic(stage: string, outcome: string, error?: unknown) {
  entries.push({
    elapsedMs: Date.now() - startedAt,
    stage,
    outcome,
    ...(error === undefined ? {} : { error: safeError(error) }),
  })
  if (entries.length > 40) entries.shift()
}

export async function startupStage<T>(
  stage: string,
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  currentStage = stage
  stageStartedAt = Date.now()
  recordStartupDiagnostic(stage, 'started')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Racing also handles SDK promises (and mocked fetches) which cannot be aborted.
    const value = await Promise.race([
      task(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Startup timeout: ${stage}`))
          controller.abort()
        }, timeoutMs)
      }),
    ])
    recordStartupDiagnostic(stage, 'completed')
    return value
  } catch (error) {
    recordStartupDiagnostic(stage, 'failed', error)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function installStartupDiagnostics(): () => void {
  if (installed || typeof window === 'undefined') return () => {}
  installed = true
  const onError = (event: ErrorEvent) => recordStartupDiagnostic('window', 'error', event.error)
  const onRejection = (event: PromiseRejectionEvent) =>
    recordStartupDiagnostic('window', 'unhandled rejection', event.reason)
  const originalError = console.error
  let parsingError = false
  const captureError: typeof console.error = (...args) => {
    // The Discord SDK swallows malformed events, logging only "Failed to parse" + Error.
    // Do not retain its other arguments: these can contain the raw SDK payload.
    const parseLabel = args.some(arg => typeof arg === 'string' && /^Failed to parse\b/.test(arg))
    for (const arg of args)
      if (arg instanceof Error)
        recordStartupDiagnostic(parsingError || parseLabel ? 'SDK parse' : 'Console error', 'error', arg)
    // The SDK logs its payload and Error in two consecutive calls.
    parsingError = parseLabel
    originalError.apply(console, args)
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  console.error = captureError
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    if (console.error === captureError) console.error = originalError
    installed = false
  }
}

export function buildStartupDiagnostics(): string {
  return JSON.stringify(
    {
      report: 'CivUp connection diagnostics',
      build: import.meta.env.VITE_BUILD_MARKER || 'activity-startup-hotfix-2',
      time: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      stageElapsedMs: Date.now() - stageStartedAt,
      stage: currentStage,
      environment: typeof window === 'undefined' ? 'unknown' : window.self === window.top ? 'browser' : 'embedded',
      userAgent:
        typeof navigator === 'undefined' ? 'unknown' : sanitizeDiagnosticText(navigator.userAgent ?? 'unknown'),
      entries,
    },
    null,
    2,
  )
}

export async function copyStartupDiagnostics(text: string): Promise<boolean> {
  // execCommand still works in some embedded clients that deny the Clipboard API.
  const fallback = () => {
    const previous = document.activeElement
    const field = document.createElement('textarea')
    field.value = text
    field.readOnly = true
    field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none'
    document.body.appendChild(field)
    try {
      field.focus()
      field.select()
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      field.remove()
      if (previous instanceof HTMLElement) previous.focus()
    }
  }
  if (fallback()) return true
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    if (!navigator.clipboard?.writeText) return false
    return await Promise.race([
      navigator.clipboard.writeText(text).then(() => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), 1500)
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

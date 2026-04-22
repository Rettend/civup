export interface RuntimeInvariantViolation {
  scope: string
  message: string
  context?: Record<string, unknown>
}

export interface RuntimeInvariantOptions {
  logger?: Pick<Console, 'error'>
  strict?: boolean
}

interface RuntimeEnvCarrier {
  env?: Record<string, string | undefined>
}

export class RuntimeInvariantError extends Error {
  constructor(public readonly violations: RuntimeInvariantViolation[]) {
    super(violations.map(violation => `[${violation.scope}] ${violation.message}`).join('\n'))
    this.name = 'RuntimeInvariantError'
  }
}

export function shouldThrowRuntimeInvariants(strict?: boolean): boolean {
  if (typeof strict === 'boolean') return strict

  const runtime = globalThis as typeof globalThis & {
    Bun?: RuntimeEnvCarrier
    process?: RuntimeEnvCarrier
  }
  const nodeEnv = runtime.process?.env?.NODE_ENV ?? runtime.Bun?.env?.NODE_ENV
  if (!nodeEnv) return false
  return nodeEnv !== 'production'
}

export function enforceRuntimeInvariants(
  violations: RuntimeInvariantViolation[],
  options: RuntimeInvariantOptions = {},
): void {
  if (violations.length === 0) return
  if (shouldThrowRuntimeInvariants(options.strict)) {
    throw new RuntimeInvariantError(violations)
  }

  const logger = options.logger ?? console
  for (const violation of violations) {
    if (violation.context) logger.error(`[${violation.scope}] ${violation.message}`, violation.context)
    else logger.error(`[${violation.scope}] ${violation.message}`)
  }
}

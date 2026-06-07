export const PAGINATION_COMPONENT_ID = 'pagination'

const DISCORD_ACTION_ROW_COMPONENT_TYPE = 1
const DISCORD_BUTTON_COMPONENT_TYPE = 2
const DISCORD_BUTTON_SECONDARY_STYLE = 2
const DISCORD_HONO_CUSTOM_ID_SEPARATOR = ';'
const PAGINATION_PAYLOAD_SEPARATOR = ':'
const PAGINATION_ACTIONS = ['top', 'prev', 'next', 'bottom'] as const

type PaginationAction = typeof PAGINATION_ACTIONS[number]

export interface PaginationRequest {
  namespace: string
  pageIndex: number
  args: readonly string[]
}

export interface PaginationControlsOptions {
  namespace: string
  pageIndex: number
  pageCount: number
  args?: readonly string[]
}

interface DiscordButtonComponent {
  type: typeof DISCORD_BUTTON_COMPONENT_TYPE
  style: number
  label: string
  custom_id: string
  disabled?: boolean
}

interface DiscordActionRowComponent {
  type: typeof DISCORD_ACTION_ROW_COMPONENT_TYPE
  components: DiscordButtonComponent[]
}

export function clampPageIndex(pageIndex: number, pageCount: number): number {
  const normalizedPageCount = Math.max(1, Math.floor(pageCount))
  if (!Number.isFinite(pageIndex)) return 0
  return Math.min(Math.max(0, Math.floor(pageIndex)), normalizedPageCount - 1)
}

export function paginationComponents(options: PaginationControlsOptions): DiscordActionRowComponent[] {
  const pageCount = Math.max(1, Math.floor(options.pageCount))
  if (pageCount <= 1) return []

  const pageIndex = clampPageIndex(options.pageIndex, pageCount)
  const lastPageIndex = pageCount - 1
  const args = options.args ?? []

  return [{
    type: DISCORD_ACTION_ROW_COMPONENT_TYPE,
    components: [
      paginationButton('Top', 'top', options.namespace, 0, args, pageIndex === 0),
      paginationButton('Prev', 'prev', options.namespace, pageIndex - 1, args, pageIndex === 0),
      paginationButton('Next', 'next', options.namespace, pageIndex + 1, args, pageIndex === lastPageIndex),
      paginationButton('Bottom', 'bottom', options.namespace, lastPageIndex, args, pageIndex === lastPageIndex),
    ],
  }]
}

export function parsePaginationCustomId(value: string | undefined): PaginationRequest | null {
  if (!value) return null

  const payload = value.startsWith(`${PAGINATION_COMPONENT_ID}${DISCORD_HONO_CUSTOM_ID_SEPARATOR}`)
    ? value.slice(PAGINATION_COMPONENT_ID.length + DISCORD_HONO_CUSTOM_ID_SEPARATOR.length)
    : value
  const [namespaceRaw, pageRaw, maybeActionRaw, ...restParts] = payload.split(PAGINATION_PAYLOAD_SEPARATOR)
  const namespace = decodePaginationPart(namespaceRaw)
  if (!namespace) return null

  const pageIndex = Number.parseInt(decodePaginationPart(pageRaw) ?? '', 10)
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return null

  const maybeAction = decodePaginationPart(maybeActionRaw)
  const argParts = isPaginationAction(maybeAction)
    ? restParts
    : maybeActionRaw == null
      ? []
      : [maybeActionRaw, ...restParts]
  const args: string[] = []
  for (const part of argParts) {
    const decoded = decodePaginationPart(part)
    if (decoded == null) return null
    args.push(decoded)
  }

  return { namespace, pageIndex, args }
}

function paginationButton(
  label: string,
  action: PaginationAction,
  namespace: string,
  pageIndex: number,
  args: readonly string[],
  disabled: boolean,
  style = DISCORD_BUTTON_SECONDARY_STYLE,
): DiscordButtonComponent {
  const targetPageIndex = Math.max(0, pageIndex)
  return {
    type: DISCORD_BUTTON_COMPONENT_TYPE,
    style,
    label,
    custom_id: encodePaginationCustomId({ namespace, pageIndex: targetPageIndex, args }, action),
    disabled,
  }
}

function encodePaginationCustomId(request: PaginationRequest, action: PaginationAction): string {
  const payload = [request.namespace, String(request.pageIndex), action, ...request.args]
    .map(encodePaginationPart)
    .join(PAGINATION_PAYLOAD_SEPARATOR)
  return `${PAGINATION_COMPONENT_ID}${DISCORD_HONO_CUSTOM_ID_SEPARATOR}${payload}`
}

function encodePaginationPart(value: string): string {
  return encodeURIComponent(value)
}

function decodePaginationPart(value: string | undefined): string | null {
  if (value == null) return null
  try {
    return decodeURIComponent(value)
  }
  catch {
    return null
  }
}

function isPaginationAction(value: string | null): value is PaginationAction {
  return PAGINATION_ACTIONS.includes(value as PaginationAction)
}

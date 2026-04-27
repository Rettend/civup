export const PARTYSERVER_ROOM_HEADER = 'x-partykit-room'
export const PARTYSERVER_NAMESPACE_HEADER = 'x-partykit-namespace'

export interface PartyServerRoomRouting {
  party: string
  room: string
}

export interface PartyServerDurableObjectFetchOptions extends PartyServerRoomRouting {
  input: RequestInfo | URL
  init?: RequestInit
}

export interface PartyServerDurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface PartyServerDurableObjectNamespace<TId = unknown> {
  idFromName(name: string): TId
  get(id: TId): PartyServerDurableObjectStub
}

export function buildPartyServerRequest(input: RequestInfo | URL, init: RequestInit | undefined, routing: PartyServerRoomRouting): Request {
  const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
  request.headers.set(PARTYSERVER_ROOM_HEADER, routing.room)
  request.headers.set(PARTYSERVER_NAMESPACE_HEADER, routing.party)
  return request
}

export async function fetchPartyServerDurableObject(
  namespace: PartyServerDurableObjectNamespace,
  options: PartyServerDurableObjectFetchOptions,
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(options.room))
  return await stub.fetch(buildPartyServerRequest(options.input, options.init, options))
}

import { routePartykitRequest } from 'partyserver'
import { Main } from './draft-room'
import { State } from './state-store'

export { Main }
export { State }

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return (await routePartykitRequest(request, env, { prefix: 'parties' }))
      ?? new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Cloudflare.Env>

import { routePartykitRequest } from 'partyserver'
import { Main } from './draft-room'

export { Main }

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    return (await routePartykitRequest(request, env, { prefix: 'parties' }))
      ?? new Response('Not Found', { status: 404 })
  },
} satisfies ExportedHandler<Cloudflare.Env>

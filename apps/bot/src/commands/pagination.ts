import { createDb } from '@civup/db'
import { Button } from 'discord-hono'
import { getKvStore } from '../services/kv/batch.ts'
import { PAGINATION_COMPONENT_ID, parsePaginationCustomId } from '../services/response/pagination.ts'
import { factory } from '../setup.ts'
import { buildCivLeaderboardCommandPayload, isCivLeaderboardPaginationNamespace } from './civ-leaderboard.ts'
import { parseCivLeaderboardBoard } from '../embeds/civ-leaderboard.ts'

export const component_pagination = factory.component(
  new Button(PAGINATION_COMPONENT_ID, 'Page', 'Secondary'),
  async (c) => {
    const request = parsePaginationCustomId(c.var.custom_id)
    if (!request) return c.flags('EPHEMERAL').res('This pagination control is invalid or expired.')

    if (isCivLeaderboardPaginationNamespace(request.namespace)) {
      const board = parseCivLeaderboardBoard(request.args[0])
      if (!board) return c.flags('EPHEMERAL').res('This civ leaderboard page is invalid or expired.')

      const db = createDb(c.env.DB)
      const kv = getKvStore(c.env)
      const payload = await buildCivLeaderboardCommandPayload(db, kv, board, { pageIndex: request.pageIndex })
      return c.update().res({
        content: payload.content ?? undefined,
        embeds: payload.embeds,
        components: payload.components,
        allowed_mentions: payload.allowed_mentions,
      } as NonNullable<Parameters<typeof c.res>[0]>)
    }

    return c.flags('EPHEMERAL').res('This pagination control is no longer supported.')
  },
)

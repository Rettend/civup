import { createDb } from '@civup/db'
import { Button, Command, Components, Modal, Option, TextInput } from 'discord-hono'
import { matchEmbed } from '../embeds/match.ts'
import { confirmMatch, reportMatch } from '../services/match.ts'
import { factory } from '../setup.ts'

interface Var {
  match_id?: string
  custom_id?: string
  placements?: string
}

export const command_report = factory.command<Var>(
  new Command('report', 'Report a match result').options(
    new Option('match_id', 'Match ID to report').required(),
  ),
  (c) => {
    const matchId = c.var.match_id
    if (!matchId)
      return c.res('Please provide a match ID.')

    // Open a modal for entering the result
    return c.resModal(
      new Modal('report-result', 'Report Match Result')
        .row(new TextInput('match_id', 'Match ID', 'Single').value(matchId))
        .row(
          new TextInput('placements', 'Placements', 'Multi')
            .placeholder(
              'Team games: "A" or "B" for winning team\n'
              + 'FFA: player names/IDs in placement order, one per line',
            )
            .required(),
        ),
    )
  },
)

export const modal_report_result = factory.modal<Var>(
  new Modal('report-result', 'Report Match Result')
    .row(new TextInput('match_id', 'Match ID'))
    .row(new TextInput('placements', 'Placements', 'Multi')),
  (c) => {
    const matchId = c.var.match_id
    const placements = c.var.placements
    const reporterId = c.interaction.member?.user?.id ?? c.interaction.user?.id

    if (!matchId || !placements || !reporterId) {
      return c.res('Missing information.')
    }

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)

      const result = await reportMatch(db, {
        matchId,
        reporterId,
        placements,
      })

      if ('error' in result) {
        await c.followup(result.error)
        return
      }

      const embed = matchEmbed(result.match, result.participants)
      await c.followup({
        content: `Match **${matchId}** reported by <@${reporterId}>. Another participant, please confirm:`,
        embeds: [embed],
        components: new Components().row(
          new Button('report-confirm', ['✅', 'Confirm Result'], 'Success')
            .custom_id(matchId),
          new Button('report-dispute', ['❌', 'Dispute'], 'Danger')
            .custom_id(matchId),
        ),
      })
    })
  },
)

export const component_report_confirm = factory.component(
  new Button('report-confirm', 'Confirm Result', 'Success'),
  (c) => {
    const matchId = c.var.custom_id
    const confirmerId = c.interaction.member?.user?.id ?? c.interaction.user?.id

    if (!matchId || !confirmerId) {
      return c.flags('EPHEMERAL').res('Something went wrong.')
    }

    return c.resDefer(async (c) => {
      const db = createDb(c.env.DB)
      const result = await confirmMatch(db, c.env.KV, matchId, confirmerId)

      if ('error' in result) {
        await c.followup(result.error)
        return
      }

      const embed = matchEmbed(result.match, result.participants)
      await c.followup({
        content: `Match **${matchId}** confirmed! Ratings updated.`,
        embeds: [embed],
      })
    })
  },
)

export const component_report_dispute = factory.component(
  new Button('report-dispute', 'Dispute', 'Danger'),
  (c) => {
    const matchId = c.var.custom_id
    const disputerId = c.interaction.member?.user?.id ?? c.interaction.user?.id

    if (!matchId || !disputerId) {
      return c.flags('EPHEMERAL').res('Something went wrong.')
    }

    return c.flags('EPHEMERAL').res(
      `Match **${matchId}** disputed by <@${disputerId}>. An admin can resolve this with \`/admin match resolve ${matchId}\`.`,
    )
  },
)

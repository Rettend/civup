import type { Env } from './env.ts'
import { CUSTOM_ID_SEPARATOR } from 'discord-hono'
import { rejectDisallowedDiscordGuildInteraction } from './services/discord/interaction-guild.ts'
import { factory } from './setup.ts'

type HandlerDefinition = Parameters<typeof factory.getCommands>[0][number]
type DiscordAppOptions = Parameters<typeof factory.discord>[0]

interface GuardedInteractionContext {
  env: Env['Bindings']
  interaction: {
    type?: number
    guild_id?: string | null
  }
}

type InteractionHandler<TContext extends GuardedInteractionContext> = (context: TContext) => Response | Promise<Response>

export function createDiscordApp(handlers: HandlerDefinition[], options?: DiscordAppOptions) {
  const app = factory.discord(options)

  for (const definition of handlers) {
    if ('command' in definition) {
      const commandName = definition.command.toJSON().name
      if ('autocomplete' in definition) {
        app.autocomplete(commandName, guardInteractionHandler(definition.autocomplete), guardInteractionHandler(definition.handler))
      }
      else {
        app.command(commandName, guardInteractionHandler(definition.handler))
      }
      continue
    }
    if ('component' in definition) {
      const component = definition.component.toJSON()
      if ('custom_id' in component) app.component(component.custom_id.split(CUSTOM_ID_SEPARATOR)[0] ?? '', guardInteractionHandler(definition.handler))
      continue
    }
    if ('modal' in definition) {
      app.modal(definition.modal.toJSON().custom_id.split(CUSTOM_ID_SEPARATOR)[0] ?? '', guardInteractionHandler(definition.handler))
      continue
    }
    app.cron(definition.cron, definition.handler)
  }

  return app
}

function guardInteractionHandler<TContext extends GuardedInteractionContext>(handler: InteractionHandler<TContext>): InteractionHandler<TContext> {
  return async (context) => {
    const rejected = rejectDisallowedDiscordGuildInteraction(context.interaction, context.env)
    return rejected ?? handler(context)
  }
}

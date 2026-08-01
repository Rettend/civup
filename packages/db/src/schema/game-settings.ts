import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const gameSettingsPresets = sqliteTable('game_settings_presets', {
  id: text('id').primaryKey(),
  ownerDiscordUserId: text('owner_discord_user_id').notNull(),
  ownerDisplayName: text('owner_display_name'),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  profileJson: text('profile_json').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  uniqueIndex('game_settings_presets_owner_name_idx').on(table.ownerDiscordUserId, table.normalizedName),
  index('game_settings_presets_updated_idx').on(table.updatedAt, table.id),
  index('game_settings_presets_owner_updated_idx').on(table.ownerDiscordUserId, table.updatedAt),
])

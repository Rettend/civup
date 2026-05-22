import { describe, expect, test } from 'bun:test'
import { getIdentity, getIdentityByUserId } from '../../src/commands/identity.ts'

describe('command identity', () => {
  test('prefers invoking member nickname and guild avatar', () => {
    const identity = getIdentity({
      interaction: {
        guild_id: 'guild-1',
        member: {
          nick: ' Server Nick ',
          avatar: 'a_member-avatar',
          user: {
            id: 'user-1',
            username: 'username',
            global_name: 'Global Name',
            avatar: 'user-avatar',
          },
        },
      },
    })

    expect(identity).toEqual({
      userId: 'user-1',
      displayName: 'Server Nick',
      avatarUrl: 'https://cdn.discordapp.com/guilds/guild-1/users/user-1/avatars/a_member-avatar.gif?size=128',
    })
  })

  test('prefers resolved member nickname and guild avatar', () => {
    const identity = getIdentityByUserId({
      interaction: {
        guild_id: 'guild-1',
        member: {
          user: { id: 'self', username: 'self', global_name: null, avatar: null },
        },
        data: {
          resolved: {
            users: {
              target: {
                id: 'target',
                username: 'target-user',
                global_name: 'Target Global',
                avatar: 'target-avatar',
              },
            },
            members: {
              target: {
                nick: 'Target Nick',
                avatar: 'target-member-avatar',
              },
            },
          },
        },
      },
    }, 'target')

    expect(identity).toEqual({
      userId: 'target',
      displayName: 'Target Nick',
      avatarUrl: 'https://cdn.discordapp.com/guilds/guild-1/users/target/avatars/target-member-avatar.png?size=128',
    })
  })
})

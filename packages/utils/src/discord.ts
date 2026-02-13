export function buildDiscordAvatarUrl(userId: string, avatarHash: string | null | undefined): string {
  if (avatarHash) {
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png'
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=128`
  }

  try {
    const index = Number((BigInt(userId) >> 22n) % 6n)
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`
  }
  catch {
    return 'https://cdn.discordapp.com/embed/avatars/0.png'
  }
}

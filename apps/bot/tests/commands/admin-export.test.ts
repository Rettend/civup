import { expect, mock, test } from 'bun:test'
import { handleExport } from '../../src/commands/admin/export.ts'

test('/admin export points server admins to the bounded Activity export', () => {
  const respond = mock((message: string) => message)
  const flags = mock(() => ({ res: respond }))

  const result = handleExport({
    flags,
    env: {},
    interaction: { member: { user: { id: 'administrator' } } },
  } as any)

  expect(flags).toHaveBeenCalledWith('EPHEMERAL')
  expect(respond).toHaveBeenCalledWith('Open CivUp and use Player Data at the bottom of the lobby overview to export the workbook.')
  expect(result).toContain('Player Data')
})

test('/admin export points every server admin to the Activity export', () => {
  const respond = mock((message: string) => message)
  const result = handleExport({
    flags: () => ({ res: respond }),
    env: {},
    interaction: { member: { user: { id: 'ordinary-admin' } } },
  } as any)

  expect(respond).toHaveBeenCalledWith('Open CivUp and use Player Data at the bottom of the lobby overview to export the workbook.')
  expect(result).toContain('Player Data')
})

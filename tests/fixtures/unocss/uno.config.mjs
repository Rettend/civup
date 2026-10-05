import activityConfig from '../../../apps/activity/uno.config.ts'

export default {
  ...activityConfig,
  blocklist: [['blocked-token', { message: 'Fixture-only blocked utility' }]],
}

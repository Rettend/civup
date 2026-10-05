import { definePlugin, defineRule } from 'vite-plus/lint/plugins'
import { playerCopyRule } from './rule.js'

export default definePlugin({
  meta: { name: 'civup-copy' },
  rules: { 'plain-language': defineRule(playerCopyRule) },
})

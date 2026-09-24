import antfu from '@antfu/eslint-config'
import { playerCopyConfig } from './scripts/eslint-player-copy.js'

export default antfu({
  formatters: true,
  unocss: true,
  solid: true,
  typescript: true,
  rules: {
    'no-console': 'warn',
    'antfu/if-newline': 'off',
    'jsdoc/check-alignment': 'off',

    // 'style/curly-newline': [
    //   'warn',
    //   {
    //     TryStatementBlock: 'never',
    //     TryStatementHandler: 'never',
    //     TryStatementFinalizer: 'never',
    //   },
    // ],
    'style/max-statements-per-line': ['warn', { max: 2 }],
    'nonblock-statement-body-position': ['warn', 'beside'],
  },
}, playerCopyConfig)

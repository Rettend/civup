import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  unocss: true,
  solid: true,
  typescript: true,
  rules: {
    'no-console': 'warn',
    'antfu/if-newline': 'off',

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
})

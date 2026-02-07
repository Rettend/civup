import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  unocss: true,
  solid: true,
  typescript: true,
  rules: {
    'no-console': 'warn',
  },
})

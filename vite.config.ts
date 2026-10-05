import { fileURLToPath } from 'node:url'
import solid from 'eslint-plugin-solid/configs/v2'
import { defineConfig } from 'vite-plus'

const generatedFiles = [
  '**/node_modules/**',
  '**/dist/**',
  '**/out/**',
  '**/.wrangler/**',
  '**/.cloudflare/**',
  '**/coverage/**',
  '**/.cache/**',
  '**/.vite/**',
  '**/.vite-plus/**',
  '**/.tmp/**',
  'tmp/**',
  '**/*.tsbuildinfo',
  '**/*.generated.*',
  '**/worker-configuration.d.ts',
  'packages/civ6-mod/vendor/**',
  'packages/db/migrations/meta/**',
  'packages/game/src/leaders.ts',
  'packages/game/src/leaders-beta.ts',
  'apps/bot/src/constants/tournament-emoji-icons.ts',
  'mods/preset_loader/**',
  'mods/python/.venv/**',
  'mods/python/.pyinstaller/**',
  'tests/fixtures/**',
]

export default defineConfig({
  // Do not load the Activity build config here: lint and format need no assets or Discord settings.
  lint: {
    plugins: ['eslint', 'typescript', 'import', 'unicorn', 'node', 'oxc'],
    jsPlugins: [
      'eslint-plugin-solid',
      { name: 'unocss', specifier: '@unocss/eslint-plugin' },
      './scripts/player-copy/plugin.js',
    ],
    categories: { correctness: 'error', suspicious: 'warn', perf: 'warn' },
    env: { builtin: true },
    settings: {
      solid: solid.settings.solid,
      unocss: { configPath: fileURLToPath(new URL('./apps/activity/uno.config.ts', import.meta.url)) },
    },
    options: { reportUnusedDisableDirectives: 'error' },
    ignorePatterns: [...generatedFiles, '**/*.md'],
    rules: {
      'curly': ['warn', 'multi-or-nest', 'consistent'],
      'eqeqeq': ['error', 'smart'],
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import/first': 'error',
      'import/no-duplicates': 'error',
      'import/no-unassigned-import': 'off',
      'no-alert': 'error',
      'no-await-in-loop': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          vars: 'all',
          varsIgnorePattern: '^_',
        },
      ],
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-const': ['error', { destructuring: 'all', ignoreReadBeforeAssign: true }],
      'prefer-template': 'error',
      'typescript/consistent-type-definitions': ['error', 'interface'],
      'typescript/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'separate-type-imports',
          prefer: 'type-imports',
        },
      ],
      'typescript/no-explicit-any': 'off',
      'typescript/no-require-imports': 'error',
      'typescript/no-wrapper-object-types': 'error',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/prefer-node-protocol': 'error',
    },
    overrides: [
      {
        files: ['apps/activity/src/client/**', 'apps/activity/tests/**'],
        env: { browser: true },
        rules: {
          ...solid.rules,
          'solid/jsx-no-undef': ['error', { typescriptEnabled: true }],
        },
      },
      {
        files: ['apps/activity/**/*.{tsx,jsx}'],
        rules: {
          // Solid's compiler assigns ref={name}; the native rule cannot see those assignments.
          'no-unassigned-vars': 'off',
        },
      },
      {
        files: ['apps/*/src/**/*.{ts,tsx}'],
        rules: { 'civup-copy/plain-language': 'error' },
      },
      {
        files: ['apps/activity/src/client/**/*.{ts,tsx}'],
        rules: {
          // Uses the Activity's UnoCSS presets and shortcuts, not Tailwind's class order.
          'unocss/order': 'warn',
          'unocss/blocklist': 'error',
          // Both rules depend on Vue template parser services and do not check Solid JSX.
          'unocss/order-attributify': 'off',
          'unocss/enforce-class-compile': 'off',
        },
      },
      {
        files: ['apps/bot/src/**', 'apps/activity/src/server/**', 'packages/utils/src/**'],
        env: { worker: true, serviceworker: true },
      },
      {
        files: ['**/*.config.{ts,js,mjs}', 'config/**'],
        env: { node: true },
      },
      {
        files: [
          'scripts/**',
          'ppl/**',
          '**/scripts/**',
          'apps/bot/tests/**',
          'packages/**/tests/**',
          'packages/**/*.test.ts',
          'packages/civup-analyzer/src/**',
          'tests/*.ts',
          'apps/bot/src/register.ts',
        ],
        env: { node: true },
        globals: { Bun: 'readonly' },
      },
      {
        files: ['apps/activity/tests/**'],
        env: { node: true },
      },
    ],
  },
  fmt: {
    semi: false,
    singleQuote: true,
    tabWidth: 2,
    useTabs: false,
    arrowParens: 'avoid',
    quoteProps: 'consistent',
    printWidth: 120,
    sortImports: {
      groups: [
        'type',
        'builtin',
        'external',
        ['internal', 'subpath'],
        ['parent', 'sibling', 'index'],
        'style',
        'side_effect',
        'unknown',
      ],
      internalPattern: ['~/', '@civup/'],
      newlinesBetween: false,
      // CSS resets and startup modules must keep their evaluation order.
      sortSideEffects: false,
    },
    sortPackageJson: true,
    // Oxfmt's Tailwind sorter does not understand UnoCSS presets, shortcuts, or variant groups.
    sortTailwindcss: false,
    overrides: [
      {
        files: ['apps/activity/src/client/index.tsx'],
        // sortSideEffects:false still moves named imports across bare imports in Oxfmt 0.70.
        options: { sortImports: false },
      },
    ],
    ignorePatterns: [
      ...generatedFiles,
      '**/*.md',
      'bun.lock',
      'apps/activity/public/**',
      'packages/game/data/**',
      'ppl/data/**',
      'ppl/reports/**',
      'ppl/snapshots/**',
    ],
  },
})

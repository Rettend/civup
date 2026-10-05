import type { Plugin } from 'vite-plus/lint/plugins'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import unocss from '@unocss/eslint-plugin'
import solid from 'eslint-plugin-solid'
import { format } from 'vite-plus/fmt'
import { eslintCompatPlugin } from 'vite-plus/lint/plugins'
import { RuleTester } from 'vite-plus/lint/plugins-dev'
import config from '../vite.config.ts'

describe('workspace formatter', () => {
  it('keeps the relative order of bare CSS and startup imports', async () => {
    const imports = [
      "import './startup-z'",
      "import z from './z'",
      "import './startup-a'",
      "import './styles-z.css'",
      "import a from './a'",
      "import './styles-a.css'",
    ]
    const result = await format('imports.ts', imports.join('\n'), config.fmt)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(
      result.code
        .trim()
        .split('\n')
        .filter(line => line.startsWith("import '")),
      imports.filter(line => line.startsWith("import '")),
    )
  })

  it('does not move named imports across Activity startup imports', async () => {
    const entrypoint = 'apps/activity/src/client/index.tsx'
    const override = config.fmt?.overrides?.find(entry => entry.files.includes(entrypoint))
    assert.equal(override?.options?.sortImports, false)
    const source = "import './startup'\nimport { start } from './consumer'\nimport './styles.css'\n"
    const result = await format(entrypoint, source, { ...config.fmt, ...override.options })
    assert.deepEqual(result.errors, [])
    assert.equal(result.code, source)
  })

  it('leaves UnoCSS shortcuts and variant groups to the UnoCSS lint plugin', async () => {
    const classes = 'text-heading focus-ring hover:(bg-accent text-bg) flex text-white'
    const result = await format('classes.tsx', `<div class="${classes}" />`, config.fmt)
    assert.deepEqual(result.errors, [])
    assert.ok(result.code.includes(`class="${classes}"`))
  })
})

RuleTester.describe = describe
RuleTester.it = it

describe('Solid 2 lint configuration', () => {
  it('uses the v2 preset while leaving TypeScript JSX names to the compiler', () => {
    assert.deepEqual(config.lint?.settings?.solid, { version: 2 })
    const activity = config.lint?.overrides?.find(entry => entry.files.includes('apps/activity/src/client/**'))
    assert.deepEqual(activity?.rules, {
      ...solid.configs.v2.rules,
      'solid/jsx-no-undef': ['error', { typescriptEnabled: true }],
    })
  })
})

const solidPlugin = eslintCompatPlugin(solid as unknown as Plugin)
function solidFixture(code: string) {
  return { filename: 'activity.tsx', settings: { solid: { version: 2 } }, code }
}

new RuleTester().run('solid/removed-api', solidPlugin.rules['removed-api']!, {
  valid: [
    solidFixture('import { createStore, flush, onSettled } from "solid-js"; import { render } from "@solidjs/web";'),
    solidFixture('<div class={{ active: true }} />'),
  ],
  invalid: [
    {
      ...solidFixture('import { createResource } from "solid-js";'),
      errors: [{ messageId: 'removed' }],
    },
    {
      ...solidFixture('import { createStore } from "solid-js/store";'),
      errors: [{ messageId: 'storeMoved' }],
      output: 'import { createStore } from "solid-js";',
    },
  ],
})

new RuleTester().run('solid/no-single-arg-create-effect', solidPlugin.rules['no-single-arg-create-effect']!, {
  valid: [
    solidFixture('import { createEffect as effect } from "solid-js"; effect(() => count(), value => save(value));'),
  ],
  invalid: [
    {
      ...solidFixture('import { createEffect as effect } from "solid-js"; effect(() => save(count()));'),
      errors: [{ messageId: 'singleArgEffect' }],
    },
    {
      ...solidFixture('import { createRenderEffect } from "solid-js"; createRenderEffect(() => save(count()));'),
      errors: [{ messageId: 'singleArgRenderEffect' }],
    },
  ],
})

new RuleTester().run('solid/no-store-mutation-outside-setter', solidPlugin.rules['no-store-mutation-outside-setter']!, {
  valid: [
    solidFixture(
      'import { createStore } from "solid-js"; const [state, setState] = createStore({ count: 0 }); setState(draft => { draft.count++; });',
    ),
  ],
  invalid: [
    {
      ...solidFixture(
        'import { createStore } from "solid-js"; const [state, setState] = createStore({ count: 0 }); state.count++;',
      ),
      errors: [{ messageId: 'mutateStore' }],
    },
    {
      ...solidFixture(
        'import { createStore } from "solid-js"; const [state, setState] = createStore({ items: [] }); state.items.push(1);',
      ),
      errors: [{ messageId: 'mutateStore' }],
    },
  ],
})

new RuleTester().run('solid/event-handlers uses v2 semantics', solidPlugin.rules['event-handlers']!, {
  valid: [solidFixture('<button onClick={() => save()} />'), solidFixture('<button onclick="save()" />')],
  invalid: [
    {
      ...solidFixture('<button onclick={() => save()} />'),
      errors: [{ messageId: 'lowercase-attribute-v2' }],
      output: '<button onClick={() => save()} />',
    },
    {
      ...solidFixture('<button onClick="save()" />'),
      errors: [{ messageId: 'static-handler-v2' }],
    },
  ],
})

// UnoCSS's broad ESLint type includes function rules; these shipped rules are all object definitions.
const uno = eslintCompatPlugin(unocss as unknown as Plugin)
const settings = {
  unocss: { configPath: fileURLToPath(new URL('../apps/activity/uno.config.ts', import.meta.url)) },
}
assert.deepEqual(config.lint?.settings?.unocss, settings.unocss)

new RuleTester().run('unocss/order', uno.rules.order!, {
  valid: [{ filename: 'classes.tsx', settings, code: '<div class="text-fg flex" />' }],
  invalid: [
    {
      filename: 'classes.tsx',
      settings,
      code: '<div class="flex text-fg" />',
      errors: [{ messageId: 'invalid-order' }],
      output: '<div class="text-fg flex" />',
    },
  ],
})

const blocklistSettings = {
  unocss: { configPath: fileURLToPath(new URL('./fixtures/unocss/uno.config.mjs', import.meta.url)) },
}
new RuleTester().run('unocss/blocklist', uno.rules.blocklist!, {
  valid: [{ filename: 'classes.tsx', settings: blocklistSettings, code: '<div class="flex" />' }],
  invalid: [
    {
      filename: 'classes.tsx',
      settings: blocklistSettings,
      code: '<div class="blocked-token" />',
      errors: [{ messageId: 'in-blocklist' }],
    },
  ],
})

new RuleTester().run('unocss/order-attributify does not check Solid JSX', uno.rules['order-attributify']!, {
  valid: [{ filename: 'classes.tsx', settings, code: '<div text-white flex />' }],
  invalid: [],
})

new RuleTester().run('unocss/enforce-class-compile does not check Solid JSX', uno.rules['enforce-class-compile']!, {
  valid: [{ filename: 'classes.tsx', settings, code: '<div class="flex text-white" />' }],
  invalid: [],
})

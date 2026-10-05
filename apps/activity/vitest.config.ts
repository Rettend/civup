import { fileURLToPath } from 'node:url'
import solid from '@solidjs/vite-plugin'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: false,
  plugins: [solid()],
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
    dedupe: ['solid-js', '@solidjs/web'],
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: './tests/activity-dom-environment.ts',
    environmentOptions: { happyDOM: { url: 'http://localhost/' } },
    setupFiles: ['./tests/setup-dom.ts'],
    isolate: true,
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: '../../coverage/activity',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
    },
  },
})

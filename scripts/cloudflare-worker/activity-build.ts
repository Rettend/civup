import type { EnvironmentOptions } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export function activityClientBuildEnvironment(root: string): EnvironmentOptions {
  return {
    build: {
      // UnoCSS 66.10.5 records CSS hooks by output directory in configResolved.
      // Declare Cloudflare 1.62.5's final client path before its plugin forces
      // Build Output paths later in that hook phase. This avoids a stale lookup
      // without patching plugins or changing UnoCSS's global generation mode.
      outDir: resolve(root, '.cloudflare/output/v0/workers/default/assets'),
    },
  }
}

export function readActivityBuildStyles(assetsRoot: string) {
  const html = readFileSync(resolve(assetsRoot, 'index.html'), 'utf8')
  const stylesheets = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter(([tag]) => /\brel\s*=\s*["']stylesheet["']/i.test(tag))
    .map(([tag]) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
    .filter((href): href is string => !!href)
  const css = stylesheets
    .map(href => {
      const path = resolve(assetsRoot, href.split(/[?#]/)[0]!.replace(/^\/+/, ''))
      if (/^[a-z]+:/i.test(href) || !path.startsWith(`${resolve(assetsRoot)}${sep}`))
        throw new Error('The Activity stylesheet is not included in its built assets.')
      return readFileSync(path, 'utf8')
    })
    .join('\n')
  return { html, stylesheets, css }
}

export function assertActivityBuildStyles(assetsRoot: string): void {
  const { stylesheets, css } = readActivityBuildStyles(assetsRoot)
  const hasGrid = /\.grid(?=[,\s{])[^{}]*\{[^}]*display:\s*grid\b/.test(css)
  const hasFlex = /\.flex(?=[,\s{])[^{}]*\{[^}]*display:\s*flex\b/.test(css)
  if (!stylesheets.length || css.includes('#--unocss--') || !hasGrid || !hasFlex) {
    throw new Error(
      'The Activity build is missing its layout styles. Build the Activity again before using this artifact.',
    )
  }
}

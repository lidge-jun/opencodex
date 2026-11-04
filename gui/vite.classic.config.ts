import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * The classic dashboard: the pre-redesign UI, built into dist/classic and served at /classic/.
 *
 * classic/src holds only the files the redesign changed, frozen at their pre-redesign content
 * (plus every old stylesheet, so CSS @import chains resolve inside the snapshot). Everything
 * else (API clients, hooks, locale catalogues, icons, pure helpers) is shared with src/, so the
 * classic UI keeps talking to the current proxy through the same code. The overlay plugin below
 * makes that work: an import resolves to the classic copy when one exists, otherwise to src/.
 */
const GUI = fileURLToPath(new URL('.', import.meta.url))
const SRC = join(GUI, 'src')
const CLASSIC_SRC = join(GUI, 'classic', 'src')
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) ? rel : null
}

function classicOverlay(): Plugin {
  return {
    name: 'opencodex-classic-overlay',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0') || !(source.startsWith('.') || source.startsWith('/'))) return null
      const importerPath = importer.split('?')[0]!
      // A classic file resolves its relative imports as if it still sat in src/.
      const fromClassic = inside(CLASSIC_SRC, importerPath)
      const asImporter = fromClassic ? join(SRC, fromClassic) : importerPath
      const resolved = await this.resolve(source, asImporter, { ...options, skipSelf: true })
      if (!resolved || resolved.external) return resolved
      const [file, query = ''] = resolved.id.split('?')
      const rel = inside(SRC, file!)
      if (!rel) return resolved
      const classic = join(CLASSIC_SRC, rel)
      return existsSync(classic) ? { ...resolved, id: query ? `${classic}?${query}` : classic } : resolved
    },
  }
}

export default defineConfig({
  root: join(GUI, 'classic'),
  base: '/classic/',
  // The favicon and logo are served from the dashboard root, which the main build fills.
  publicDir: false,
  plugins: [classicOverlay(), react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: join(GUI, 'dist', 'classic'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
  resolve: { alias: { '@': SRC } },
})

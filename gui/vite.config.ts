import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Bake the parent package version into the bundle as a fallback for moments when the runtime
// `/healthz` version is not reachable yet.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
})

import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Bake the parent package version into the bundle as a fallback for moments when the runtime
// `/healthz` version is not reachable yet.
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const proxyTarget = process.env.OPENCODEX_PROXY_TARGET

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  /* [Decision Log]
  - 목적: 로컬 Vite GUI가 실행 중인 opencodex API를 same-origin으로 호출해 CORS 잡음 없이 실제 데이터를 보여준다.
  - 대안 분석: API 없이 정적 화면만 띄우면 기능 검증이 불가능하고, 별도 프록시 서버는 유지보수 대상이 늘며, Vite 내장 proxy는 개발 시에만 기존 서버를 재사용한다.
  - 선택 근거: 환경변수가 있을 때만 활성화되어 프로덕션 번들과 기본 개발 동작을 바꾸지 않고 로컬 통합 검증에 필요한 경로만 연결한다.
  */
  server: proxyTarget ? {
    proxy: {
      '/api': { target: proxyTarget, changeOrigin: true },
      '/healthz': { target: proxyTarget, changeOrigin: true },
    },
  } : undefined,
})

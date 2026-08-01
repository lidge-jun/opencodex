# 010 — Phase 1: authMode Implementation

## src/types.ts (line ~251, OcxClaudeCodeConfig)
ADD: authMode?: "subscription" | "proxy"

## src/cli/claude.ts (line ~49)
MODIFY: authMode === "proxy"일 때 ANTHROPIC_AUTH_TOKEN=opencodex-proxy 주입
apiKeys 없어도 placeholder 토큰 설정

## src/server/system-env.ts (line ~28, ~239)
MODIFY: systemEnv 구성 시 authMode === "proxy"면 동일 placeholder 주입

## gui/src/pages/ClaudeCode.tsx
ADD: authMode Select (subscription/proxy) + 수동 명령에 placeholder export

## gui/src/i18n/*.ts
ADD: claude.authMode, claude.authModeHint, claude.authModeSubscription, claude.authModeProxy

## src/server/management-api.ts
MODIFY: /api/claude-code GET/PUT에 authMode 필드 추가

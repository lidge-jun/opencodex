# 000 — Plan: Claude Code Proxy Mode (authMode)

## Objective

Claude Code를 Anthropic 계정 없이 opencodex 프록시만으로 사용 가능하게 하는 authMode 설정 추가.

## Context

- 서버 측 라우팅은 이미 Anthropic 없이 동작 (claude-messages.ts:300 — Responses 변환)
- 병목: ocx claude가 ANTHROPIC_AUTH_TOKEN placeholder를 주입하지 않음 (cli/claude.ts:49)
- sk-ant- prefix만 native credential로 인정 (claude-messages.ts:80)
- 참고: claude-code-router(35.7k stars), CCS, claude-code-proxy

## File Change Map

| File | Action | Description |
|------|--------|-------------|
| src/types.ts:251 | MODIFY | OcxClaudeCodeConfig에 authMode 필드 추가 |
| src/cli/claude.ts:49 | MODIFY | proxy 모드시 placeholder token 주입 |
| src/server/system-env.ts | MODIFY | systemEnv에 동일 정책 적용 |
| gui/src/pages/ClaudeCode.tsx | MODIFY | authMode 토글 UI + 수동 명령 안내 |
| gui/src/i18n/ko.ts,en.ts,de.ts,zh.ts | MODIFY | authMode i18n 키 |
| src/server/management-api.ts | MODIFY | /api/claude-code에 authMode 필드 |

## Design

authMode: "subscription" (기본) | "proxy"
- subscription: 현재 동작 유지, Claude OAuth 보존
- proxy: ANTHROPIC_AUTH_TOKEN=opencodex-proxy placeholder 주입

## Accept Criteria

1. authMode: proxy시 ocx claude가 Anthropic 로그인 없이 실행
2. placeholder가 upstream Anthropic으로 안 감 (sk-ant- 체크)
3. subscription 기본값에서 기존 동작 변화 없음
4. GUI에서 authMode 토글 가능

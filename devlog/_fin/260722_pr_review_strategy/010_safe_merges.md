# WP1: Safe Merges — #215, #224, #211 → dev

## 작업

### #215 agent_message id strip
- 변경: src/adapters/openai-responses.ts (1줄), tests/openai-responses-passthrough.test.ts (2줄)
- 검증: bun test tests/openai-responses-passthrough.test.ts

### #224 prompt_cache_key
- 변경: src/adapters/openai-chat.ts, src/providers/registry.ts, src/router.ts, src/types.ts, tests/openai-chat-hardening.test.ts
- 검증: bun test tests/openai-chat-hardening.test.ts

### #211 RU docs refresh
- 변경: gui/src/i18n/ru.ts, gui/src/i18n/frontier-i18n.ts, README.ru.md, docs-site RU pages
- 검증: cd gui && bun run build

## 순서: #215 → #224 → #211 (의존성 없음, 충돌 없음)
## 완료 기준: 3개 PR 전부 MERGED, git pull로 dev 동기화

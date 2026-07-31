# 134 — B/C 기록: Desktop effort + usage/캐시 투명성 구현

## 구현 델타 (B)

| 항목 | 파일 | 내용 |
|------|------|------|
| B0 별칭 | `src/claude/desktop-3p.ts` | `desktop3pAlias` → `claude-opus-4-8-{code}` (export), `legacyDesktop3pAlias` 디코드 존치, anthropic 실모델 레지스트리 미등록(패스스루 보존), config discovery/static 모드 |
| B0 CLI | `src/cli/index.ts` | `ocx claude desktop [--static]` — 기본 discovery 모드 |
| B4b | `src/claude/model-info.ts` (NEW) | 공식 ModelInfo 형태 + capabilities(effort/thinking). native=clamp 항등 rung만, routed=`reasoningEfforts`만, 없으면 supported:false. created_at 고정, max_tokens null |
| B4b | `src/server/index.ts` | anthropic-flavor /v1/models를 ModelInfo 목록으로 교체 |
| B4b | `src/server/management-api.ts` | GUI 별칭 미리보기도 새 별칭으로 |
| B1 | `src/claude/inbound-debug.ts` (NEW) | opt-in 캡처 링 20건, allowlist 스칼라 + 프로세스 salt equality tag, OFF 플러시 |
| B1 | `src/lib/debug-settings.ts`, `management-api.ts`, `gui Debug.tsx` | `claude` 디버그 키, `GET /api/claude/inbound-debug`, 캡처 표 UI |
| B2 | `src/usage/log.ts`, `request-log.ts`, `responses.ts` | `providerAdapter` 기반 estimated 판정(`cursor-pb51d9b` 버그 수정), 추정 병합 시 estimated 마크 |
| B2 | `src/server/claude-messages.ts` | cursor/kiro 라우트만 `usageLogInputTokens` 추정치 세팅 (정확 usage 무접촉) |
| B2 GUI | `gui Logs.tsx` + i18n×4 | 추정치 `~` 접두, 캐시 미보고 라벨/툴팁 |
| B3 | `src/claude/inbound.ts` | `anthropicToResponsesTranslation` 튜플(`cacheKeySource`), metadata 없고 system 있을 때 system-hash `prompt_cache_key` fallback |
| B3 | `src/server/claude-messages.ts` | session_id 헤더 합성은 metadata 유래 키일 때만 |
| SoT | docs-site claude-code.md (en/ko/zh) | 별칭/capabilities 서술 갱신 |

## 검증 (C)

- `bun x tsc --noEmit` — 클린 (exit 0)
- `bun test` — **2198 pass / 0 fail** (9306 expect, 215 files)
- `cd gui && bun run build` — 성공 (466.61 kB js)
- `cd docs-site && bun run build` — 성공 (55 pages)

활성화 증거 (C-ACTIVATION-GROUNDING-01):
- B0: `tests/desktop-3p.test.ts` — anthropic id 레지스트리 배제 + `resolveInboundModel` 항등,
  legacy/new 별칭 decode, discovery/static config shape.
- B1: `tests/claude-inbound-debug.test.ts` — OFF 미기록, ON 캡처(프롬프트 원문 부재 단언),
  equality tag 동등성, OFF 플러시, budget_tokens 와이어.
- B2: `tests/request-log.test.ts` — cursor in:0→44000 추정 병합+estimated, anthropic 무접촉;
  `tests/usage-log.test.ts` — `cursor-pb51d9b` estimated 판정.
- B3: `tests/claude-inbound.test.ts` — metadata/system/none 3분기 + wire body 무오염.
- B4b: `tests/claude-model-info.test.ts` — ladder 정직성(clamp 항등, 추측 금지, ultra 필터),
  `tests/claude-models-discovery.test.ts` — 엔드포인트가 ModelInfo 계약으로 응답.

## 사용자 실험 절차 (라이브 판정 대기)

1. `ocx stop && ocx start` (새 코드 반영)
2. `ocx claude desktop` (discovery 모드 config 작성) → Claude Desktop 재시작
3. GUI Debug 페이지에서 "Claude 인바운드" 토글 ON
4. Desktop에서 라우팅 모델 선택 → effort 슬라이더 low→max 이동하며 메시지 전송
5. 캡처 표에서 `output_config.effort` 값이 슬라이더 위치별로 도달하는지 확인
6. 연속 턴 후 로그에서 openai/native 경유 행의 `c`(캐시) 수치 발생 확인

## 남은 리스크
- Desktop이 discovery capabilities를 실제 소비하는지는 실험으로만 판정 가능 (131 미해결).
- discovery 모드에선 tier 핀(anthropicFamilyTier)이 사라짐 — 필요 시 `--static`.

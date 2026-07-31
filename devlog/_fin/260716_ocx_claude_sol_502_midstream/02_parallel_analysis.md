# 병렬 분석 종합 — sol 코드 경로 + cxc-search 웹 검증 (2026-07-16)

분석 체계: 메인 에이전트가 증거 타임라인(01)을 만든 뒤, gpt-5.6-sol 서브에이전트(코드
경로, read-only)와 cxc-search 서브에이전트(Tier 1 발견 → Tier 2 원문 증명)를 병렬로 돌려
교차 검증했다. 코드는 한 줄도 수정하지 않았다(조사 전용).

## 결론 (한 줄)

ChatGPT Codex 백엔드(`chatgpt.com/backend-api/codex/responses`)가 장시간 요청에서
비선언 transient 502를 뱉었고, **ocx는 HTTP 502를 재시도하지 않고 Anthropic
`api_error`로 변환해 내려보내기 때문에** Claude Code Task(sol 빌더)가 재시도 신호 없이
치명 에러로 즉사했다. 모델 라우팅 충돌은 없었다.

## 실패 체인 (sol 서브에이전트, file:line 근거)

```
Claude Code /v1/messages (model claude-ocx-native--gpt-5.6-sol[1m])
  └ index.ts:450,461            라우터 → handleClaudeMessages (타임아웃 비활성)
  └ claude-messages.ts:302,307  [1m] 마커 제거 → alias 해석
  └ claude/alias.ts:40,48       native pseudo-provider → bare gpt-5.6-sol
  └ claude-messages.ts:336,345  Anthropic→Responses 번역, 내부 스트리밍 강제
  └ claude-messages.ts:426,442  내부 POST /v1/responses 재진입
  └ responses.ts:649,666,697    passthrough 어댑터 → fetchWithResetRetry(fetchWithHeaderTimeout)
  └ upstream-retry.ts:4,55,124  ★ 연결 리셋(ECONNRESET 등)만 재시도, HTTP 5xx는 재시도 제외
  └ responses.ts:804            502 status 그대로 릴레이
  └ claude-messages.ts:449~464  Anthropic 에러 봉투로 재조립
  └ claude/outbound.ts:23,35    ★ 529만 overloaded_error, 502는 api_error로 분류
  → Claude Code: api_error = 재시도 불가 치명 에러 → Task 에이전트 사망 (72콜 유실)
```

핵심 판정 두 곳:

1. `src/lib/upstream-retry.ts` — 모듈 계약 자체가 "HTTP 에러와 mid-stream 리셋은 제외"
   (line 4). 즉 502는 설계상 재시도 대상이 아니었다.
2. `src/claude/outbound.ts:23,35` — 529→`overloaded_error`, 502/500→`api_error`.
   Claude Code(Anthropic SDK 기반)는 `overloaded_error`/5xx를 백오프 재시도하지만,
   여기서는 그 신호가 전달되지 않는다.

부가 확인:

- `[1m]` 접미사는 alias 해석 전에 제거되어 라우팅/재시도에 영향 없음 (`claude/inbound.ts:27`).
- `Connection closed mid-response...`(사건 2)는 repo에 없는 문자열 → Claude Code
  클라이언트 합성 메시지. 터미널 프레임 없이 전송이 끊긴 경우다. 비-Windows에서는
  `relaySseWithFailedTail`(responses.ts:762,793 / relay.ts:42~71)이 합성
  `response.failed`를 붙여 이 상태를 막으려 하지만, 완전히 없애지는 못한다.
- mid-stream 실패의 blind replay는 relay.ts:46 주석대로 의도적으로 금지
  (업스트림에 이미 커밋된 요청의 중복 출력 위험) — 이 fail-closed 자체는 옳다.
- 191,677ms + 502 + usage unreported는 "느린 502"인지 "SSE 시작 후 response.failed"인지
  단독으로 구별 불가. 구별 필드(`terminalStatus`/`closeReason`/`upstreamError`)는
  request-log에 있으나 **메모리 200개 링버퍼**(request-log.ts:79-85)라 프록시 재시작
  (오늘 08:29 KST)으로 어젯밤 항목은 유실됨.
- sol 검증: 관련 테스트 50개 통과 확인(리셋 전용 재시도, HTTP 비재시도, failed-tail
  변환, outbound 매핑, /v1/messages 라우팅). 코드 무수정.

## 웹 검증 (cxc-search, Tier 2 원문 증명 완료분)

| 판정 | 근거 | 상태 |
|---|---|---|
| OpenAI 공식 문서: 500은 "brief wait 후 재시도" | developers.openai.com/api/docs/guides/error-codes | Tier-2 증명 (2026-07-16 열람) |
| 공식 문서에 502 항목은 **없음** (Tier-1 스니펫이 과장했던 부분 — 정정) | 같은 페이지, "502" 0회 | 반증됨 |
| OpenAI 공식 SDK는 conn error/408/409/429/**>=500**을 기본 2회 지수백오프 재시도 → 502 포함 | openai-python README Retries 절 | Tier-2 증명 |
| Anthropic: 529=`overloaded_error` "temporarily overloaded", 공식 SDK는 5xx를 retry-after 존중하며 2회 재시도 | platform.claude.com/docs/en/api/errors | Tier-2 증명 |
| Anthropic 에러 모델 자체가 "200 이후 SSE 중 에러는 상태코드 재시도 규칙과 별개" — 우리의 pre-stream/mid-stream 분리와 동일 구조 | 같은 페이지 | Tier-2 증명 |
| status.openai.com: 7/15 00:39Z 이후 7/16까지 선언된 인시던트 **없음** → 17:20Z/23:20Z 502는 비선언 transient | status.openai.com/history + incidents JSON | Tier-2 증명 |

Tier-1 후보로 남은 것(스니펫만, 원문 미확인): Codex 백엔드 SSE 중단 보고
(openai/codex#10378, 커뮤니티 포럼 2026-02-08, Reddit), "An error occurred… request ID"
= 일반 transient 메시지(help.openai.com/7996703). 미검증: Claude Code 앱 자체가 529를
재시도한다는 문서 진술(SDK 레벨은 증명, 앱 레벨은 추론), Codex 엔드포인트 WebSocket 전환설.

## 하드닝 옵션 (우선순위순, 미실행 — 조사 전용 턴)

1. **pre-stream 502/503/504 한정 재시도**: passthrough에서 스트림 시작 전 5xx면
   짧은 백오프로 2~3회 재시도. replay-safe 바디 한정, Retry-After 존중, 실패 바디 cancel.
   OpenAI SDK의 >=500 재시도 관행과 일치. (가장 효과 큼 — 42건/48h의 sol 502 대부분이
   초 단위 재시도로 성공했음)
2. **transient 502 → Anthropic 529/`overloaded_error` 매핑**: `claude/outbound.ts`
   분류만 바꾸면 Claude Code 쪽 내장 재시도가 작동. 1번보다 구현이 작고 겹쳐 써도 됨.
   선행 확인 1건: Claude Code가 529를 실제 재시도하는지 실측(잔여 항목).
3. **request-log 5xx 영속화**: 200개 링버퍼라 사후 분석이 불가능했다. 5xx/terminal
   이상 항목만이라도 `~/.opencodex/`에 append 하면 다음 사건은 즉시 판별 가능.
4. (보류) mid-stream resume은 업스트림 커서 없이는 불안전 — 현행 fail-closed 유지.

## 잔여 항목 (정직한 미해결)

- 23:20:46Z 502가 슬로우 502였는지 SSE 도중 `response.failed`였는지 확정 불가 (로그 유실).
- Claude Code 앱 레벨 529 재시도 여부 실측 필요 (옵션 2의 전제).
- status 페이지 비선언이므로 upstream 원인 자체는 블랙박스 — request ID
  `44041aaa-beda-42a8-90ce-44cba8115d5f`만 기록해 둔다.

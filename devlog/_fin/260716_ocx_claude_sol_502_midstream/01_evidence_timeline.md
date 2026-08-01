# `ocx claude` sol 서브에이전트 사망 — 증거 타임라인 (2026-07-16)

조사 대상: 최근 `ocx claude`로 실행한 Claude Code 세션에서 sol 빌더 서브에이전트가
API 오류로 죽은 사건. 로그 원본과 프록시 usage 레저를 교차 대조한 결과.

## 사건 1 — codexclaw 세션 sol 빌더 사망 (주 사건)

- Claude Code 세션: `~/.claude/projects/-Users-jun-Developer-new-700-projects-codexclaw/7060d3a5-8af5-4004-b2ca-ea26eae9630a.jsonl`
- 워크플로 출력: `/private/tmp/claude-501/-Users-jun-Developer-new-700-projects-codexclaw/7060d3a5-.../tasks/wquor8kk2.output`
- 죽은 에이전트: `sol:build-registry` (agentType `ocx-gpt-5-6-sol`, model `claude-ocx-native--gpt-5.6-sol[1m]`)
  - 72 tool calls, 643초 진행 후 `state: "error"`
  - 에러: `API Error: An error occurred while processing your request. ... request ID 44041aaa-beda-42a8-90ce-44cba8115d5f`
  - OpenAI 쪽 request ID가 붙어 있음 → 업스트림(ChatGPT Codex 백엔드)에서 발급한 5xx 에러 본문

### 프록시 레저 대조 (`~/.opencodex/usage.jsonl`, UTC)

| 시각 | status | model | duration | 비고 |
|---|---|---|---|---|
| 23:13:14 | 200 | gpt-5.6-sol | — | sol 빌더 시작 (startedAt 1784157194942) |
| 23:13~23:18 | 200 다수 | gpt-5.6-sol | 2~126초 | 정상 진행 (72 tool calls) |
| **23:20:46** | **502** | **gpt-5.6-sol** | **191,677ms** | **usageStatus=unreported — 사망 지점** |
| 23:23:58 | — | — | — | Claude Code가 workflow `completed`(실패 요약) 통지 수신 |
| 23:24:35 | 502→200 | gpt-5.6-sol | 9.5초 | 즉시 재시도는 성공 |
| 23:25:54 | 502→200 | gpt-5.4-mini | 2.2초 | 같은 패턴 |

- 502가 뜬 요청은 **191초를 소모한 뒤** 실패했고 usage가 unreported → 스트림이 시작됐거나
  헤더 대기 중 장시간 붙잡혀 있다가 업스트림이 끊은 형태.
- 직후 같은 모델 요청이 초 단위로 200을 받음 → 일시적(transient) 업스트림 장애.

## 사건 2 — opencodex 세션 mid-stream 종료 (부 사건)

- 세션: `~/.claude/projects/-Users-jun-Developer-new-700-projects-opencodex/69edf4a1-759c-4a02-a1e6-692d4e086a01.jsonl` line 475
- `2026-07-15T17:26:30.998Z` — `API Error: Connection closed mid-response. The response above may be incomplete.` (model `<synthetic>`, isApiErrorMessage=true)
- 같은 시간대 프록시 레저: 17:20~17:30에 병렬 스웜 부하 중 499(클라이언트 abort) 11건,
  502 다수, 그중 초장시간 스트림 실패 3건:
  - 17:26:47 — 502, 179,977ms (openai-p4483bc/gpt-5.6-sol)
  - 17:28:30 — 502, 167,040ms (openai/gpt-5.6-sol)
  - 23:20:46 — 502, 191,677ms (사건 1과 동일 패턴)

## 규모 — 최근 48시간 4xx/5xx 집계 (usage.jsonl)

| 건수 | status | provider/model |
|---|---|---|
| 42 | 502 | openai/gpt-5.6-sol |
| 41 | 502 | openai/gpt-5.4-mini |
| 23 | 520 | openai/gpt-5.6-sol |
| 11 | 499 | openai/gpt-5.6-sol |
| 9 | 502 | openai/gpt-5.6-terra |
| 9 | 504 | anthropic/claude-fable-5 |
| 기타 | 499/502/503/504/507/520 | anthropic-native, openai-p4483bc 등 |

→ 단발 사고가 아니라 **장시간·고병렬 요청에서 chatgpt 백엔드 5xx가 상시 발생**하는 패턴.
대부분은 다음 턴 재시도로 흡수되지만, Claude Code **Task(서브에이전트) 안에서 터지면
워크플로 에이전트가 통째로 죽고** 72콜 분량의 작업이 유실된다.

## 미해결 질문 (병렬 분석로 이관)

1. ocx가 502를 재시도하는가, 아니면 그대로 클라이언트에 치명 에러로 전달하는가? (sol 코드 분석)
2. `Connection closed mid-response`는 ocx 생성인가 Claude Code 클라이언트 합성인가? (sol 코드 분석)
3. 502 사전-스트림 재시도 / Anthropic `overloaded_error`(529) 매핑이 표준 관행에 부합하는가? (cxc-search 웹 검증)

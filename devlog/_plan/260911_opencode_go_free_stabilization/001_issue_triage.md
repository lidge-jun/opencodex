# 010 — opencode-go / zen / free 이슈·PR 트리아지

수집일 2026-09-11. 소스: `gh issue list` / `gh pr list` (lidge-jun/opencodex), dev HEAD `b550d24e1`.

## 열린 이슈 중 이 영역에 걸리는 것

| 번호 | 제목 | 판정 | 근거 |
| --- | --- | --- | --- |
| #4253 | Command Code live model `deepseek/deepseek-v4.1-flash` advertises no reasoning efforts | 유효, 단 **인접 PR #4258이 담당** | PR #4258이 `src/providers/command-code-efforts.ts`에 v4.1-flash / Qwen3.8-Flash 행 추가, base dev, mergeable, CI green |

열린 이슈 60건 중 opencode-go/zen/free 고유 결함은 없다. 이 영역의 최근 결함은 대부분 닫혔다.

## 최근 닫힌 항목 (2026-08-15 이후, 32건 중 발췌)

| 번호 | 종료 | 제목 요약 | 현재 의미 |
| --- | --- | --- | --- |
| #4172 | COMPLETED | Go sessionless 요청이 `x-opencode-session` 누락 | 랜딩됨. `src/providers/opencode-go-transport.ts` |
| #4121 | COMPLETED | opencode-free: Zen이 세션 헤더 없는 요청 거부 | 랜딩됨. 무키 티어는 레지스트리 note로 차단 고지 |
| #3945 / #3857 / #3378 | COMPLETED | Claude/Pi 경로의 Go 세션 친화성 | 랜딩됨 |
| #3402 | COMPLETED | muse-spark via go: 미선언 클라이언트 툴이 서브에이전트 턴을 죽임 | 랜딩됨 |
| #2442 | COMPLETED | Go Responses가 `search_content_types` 거부 | 랜딩됨 |
| #2410 | COMPLETED | 신규 opencode-go 모델의 reasoningEfforts 누락 | **재발 구조 남음**: 030 참조 |
| #2193 / #2194 / #2156 | COMPLETED | muse-spark 502 / 스트림 중단 | 랜딩됨 |
| #1338 / #1415 | COMPLETED | Console Go 업스트림이 `response_format` json_schema를 400으로 거절 | **노브만 추가됨(#1424)**, 프리셋 시딩 없음 |

## NOT_PLANNED로 닫혔지만 사실은 유효했던 것

| 번호 | 사유 | 실제 상태 |
| --- | --- | --- |
| #3362 | `#3378`로 통합 | 메인테이너가 유효·재현 가능으로 확인. `indexed_web_access` 미제거. #3378에서 처리 |
| #3344 | `#3378`로 통합 | 동일 |
| #2480 / #2394 | 템플릿 미비로 봇이 자동 종료 | 재현 정보 없음. 정보부족으로 남김 |
| #2484 | 템플릿 미비 | 보고자 스스로 `preserveResponsesReasoningContent` 미설정이 교란 변수였다고 정정 |

## 남는 실물 갭

1. **구조화 출력 400**: #1338/#1415는 per-model 옵트아웃 노브(#1424)로만 닫혔다. Zen Go DeepSeek에 대한 기본 시딩은 없어서 사용자가 직접 config를 고쳐야 한다. 2026-09-11 커뮤니티 제보(디시인사이드 ai_utilize)에서 실제로 사용자가 `noStructuredOutputModels`에 deepseek를 넣어 해결했다.
2. **정확-id 표 드리프트**: #2410이 한 번 고쳐진 부류의 결함이 구조적으로 재발 가능하다. 030 참조.

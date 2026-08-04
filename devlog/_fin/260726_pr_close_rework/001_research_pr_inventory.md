# 001 — 조사 근거: 열린 PR/이슈 전수 인벤토리

연구 전용 문서다. diff는 담지 않는다 (LEXICO-SPLIT-01).
구현 지시는 010~090 decade 문서에 있다.

스냅샷: 2026-07-26 09:00 KST. 기준 `dev = origin/dev = 8756daa5`.
방법: gpt-5.6-sol medium 3기 병렬 파견. 각 PR head를 scratch ref로 fetch해
`git show`/`git merge-tree`로 실제 소스 대조. 워크트리 미변경.

## 외부 근거 원문 확인

A-gate 리뷰어가 아래 3건을 독립 재확인했다. 계획서의 인용을 그대로 믿지 않고
원문을 다시 열었다.

| 주장 | 출처 | 결과 |
|---|---|---|
| `MAX_TOKENS`/`CONTENT_FILTERED`/`TOOL_USE`가 서로 다른 종료 상태 | AWS SDK `StopReason` enum | 확인됨 |
| Opus 5가 `output_config.effort`로 low/medium/high/xhigh/max 수용 | kiro.dev/docs/cli/chat/effort | 확인됨 |
| MiniMax `reasoning_split`, M3의 `adaptive|disabled` thinking | platform.minimax.io text-openai-api | 확인됨 |

## PR head 이동 기록

PR head는 계획 수립 중에도 움직인다. 특히 #466이 심하다.

| PR | 최초 분석 | A-gate 감사 | A-gate 반영 |
|---|---|---|---|
| #466 | `9c7e922e` | `138751f7` | `7b0bcda7` |
| #467 | `b3324686` | `b3324686` | `b3324686` |
| #468 | `8b7c73fd` | `8b7c73fd` | `8b7c73fd` |

이 때문에 각 구현 work-phase의 B 단계 첫 동작은 `PRE_APPLY_HEAD` 재확인이다.
어제 배치(`260725_pr_issue_rework`)에서 #426이 head 이동으로 리뷰 초안이 STALE이 된
선례가 있다. 같은 실수를 반복하지 않는다.

## 보안 경계 판정 근거

`MAINTAINERS.md`가 명시하는 경계는 인증, 자격증명/토큰 취급, OAuth 흐름,
GitHub Actions 워크플로, 릴리스 자동화, 의존성 설치다.

최초 self-merge로 분류한 8건이 이 경계를 넘지 않는지 리뷰어가 개별 확인했다.
(이 8건은 **초기 분류**다. 실행 중 #466은 동료 머지로, #429는 shell 실행 도구
입력 경계 재분류로 빠져 현재는 6건이다.)
단 아래 3건은 **범위 제외를 전제로만** 안전하다.

| PR | 제외 대상 | 제외 안 하면 |
|---|---|---|
| #466 | `gui/src/api.ts` | 자격증명 보관이 sessionStorage→모듈 메모리로 바뀜 |
| #431 | `src/oauth/index.ts`, `src/oauth/login-cli.ts`, `src/server/auth-cors.ts` | OAuth/자격증명 구성/safe-DTO 표면 발생 |
| #405 | `derive.ts`, `registry.ts` 훅 | 디렉터리 ID가 런타임 provider를 덮어써 destination 탈취 가능 |

리뷰어가 제외 후에도 잔여 파일이 제외 심볼을 직접 import하지 않음을 확인했다.

## 이슈 인벤토리 요약

열린 이슈 18건. **dev에서 이미 고쳐졌는데 안 닫힌 건은 0건**이다.

| 분류 | 건수 | 비고 |
|---|---|---|
| already-fixed-closable | 0 | 이번 루프에서 이슈 close 대상 없음 |
| addressed-by-open-PR | 3 | #457(#459/#464), #443(#469), #425(#426) |
| needs-work | 15 | 실제 미구현 |
| invalid | 0 | |

#42(Storage cleanup)는 Phase 1(`src/storage/scanner.ts`, `/api/storage`)만 의도적으로
전달된 부분 완료 상태이며 close 대상이 아니다.

upstream-tracking 라벨 4건(#417 #241 #92, 그리고 #418)은 우리 코드로 해결할 수 없는
상류 이슈이거나 동일 실행 트레이스가 없어 재현 근거가 부족하다.

## 통합 대상 PR의 이슈 연결

최초 self-merge 분류 8건(#437 #429 #460 #466 #468 #467 #431 #405) 중 본문에
closing keyword를 가진 PR은 **없다.** 따라서 이 배치의 이슈 close는 0건이다.

실행 중 이 목록이 두 번 바뀌었다.

- **#466 제외** — 동료가 `d9e5102a`로 직접 머지해 우리 통합이 불필요해졌다.
- **#429 제외** — A-gate 리뷰어가 shell 실행 도구 입력 경계임을 지적해 보안 보류로
  재분류했다. 구현 계약은 020 문서에 남기되 병합은 사용자 승인 사항이다.

따라서 현재 self-merge 대상은 6건(#437 #460 #468 #467 #431 #405)이다.

#459는 본문에 `Fixes #457`이 있지만 통합 없이 close하므로 #457은 열어둔다.
#464는 `Refs #457`(비-closing)이다.

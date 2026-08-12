# 010 — wp1: PR #711 랜딩 (data-only Responses SSE 수용)

## 목표

PR #711을 `dev`에 머지하고 이슈 #700을 닫는다. 코드 변경은 컨트리뷰터가 이미 올바르게
했으므로 이 work-phase는 **검증 + 랜딩**이다. 우리 쪽 코드 패치는 계획하지 않는다.

## 현재 상태 (실측)

```
PR #711  head fcd3298f  base dev  non-draft  MERGEABLE / UNSTABLE  reviewDecision 없음
author snowyukitty  maintainerCanModify true  commits 1  +119/-3  2파일
```

체크 (`check-runs?per_page=40` on `fcd3298f`):

| 체크 | 결론 |
|------|------|
| ubuntu-latest | success |
| macos-latest | success |
| windows-latest | **cancelled** |
| npm-global ubuntu/macos/windows | success ×3 |
| react-doctor | success |
| enforce-target | success |
| label | success |

`UNSTABLE`의 유일한 원인이 cancelled된 `windows-latest`다.

## 변경 내용 (컨트리뷰터 diff, 검토용)

### `src/claude/outbound.ts` — `responsesSseToAnthropicSse()`

```diff
-              if (!eventName || !dataLine) continue;
+              if (!dataLine) continue;
               let data: unknown;
               try { data = JSON.parse(dataLine); } catch { continue; }
               if (!isRec(data)) continue;
-              if (terminated) continue;
-              handleFrame(eventName, data);
+              // Responses-compatible gateways may omit the optional SSE event field
+              // while retaining the event name in the JSON payload's required type.
+              const resolvedEventName = eventName || (typeof data.type === "string" ? data.type : "");
+              if (!resolvedEventName || terminated) continue;
+              handleFrame(resolvedEventName, data);
```

판정: 신고된 결함(#700)에 대해 올바르다. 단 **완전하지는 않다** — 아래 잔여 결함 참조.

- `event:` 없는 프레임을 버리지 않고 payload의 required `type`으로 이벤트명을 해석.
- `dataLine`이 없으면 여전히 skip — 빈 프레임/주석은 그대로 무시.
- `type`이 문자열이 아니면 `resolvedEventName`이 빈 문자열이 되어 skip.
- `[DONE]` 센티넬은 `JSON.parse`가 throw해 `catch { continue }`로 걸러지고, `isRec`도
  배열을 거부한다. Responses 이벤트명이 아닌 `type`은 `handleFrame`의 `default: break`로
  무시된다 — 폴백이 프레임을 오라우팅하지 않는다 (감사에서 독립 확인).
- `terminated` 검사가 `handleFrame` 앞에 유지되어 터미널 이후 프레임 처리 금지 불변식
  보존.
- EOF-without-terminal = truncation 규칙 자체는 손대지 않음. 정상 프레임을 다시 보게
  되니 truncation 오판만 사라진다.

### 잔여 결함: `event: message`를 명시 전송하는 게이트웨이 (감사 지적 3)

WHATWG SSE에서 `event` 필드 부재는 "이벤트 타입이 `message`"를 뜻한다. 그래서 어떤
게이트웨이는 필드를 **생략하는 대신 `event: message`를 명시 전송**한다. 그 경우:

```
eventName === "message"   (truthy)
  → `eventName || data.type` 에서 왼쪽이 채택되어 payload type을 보지 않음
  → handleFrame("message", …) 이 default: break 로 빠짐  (outbound.ts:298-300 부근)
  → 터미널 프레임을 못 봄 → EOF truncation 502
```

즉 이 PR은 **필드 생략 형태만** 고친다. 올바른 최종 형태는 `eventName`이 비었거나
`"message"`일 때 payload `type`으로 해석하는 것이다.

처리 방침: **이 PR을 막지 않는다.** #700이 신고한 형태는 정확히 고쳐지고, 회귀 테스트도
붙었다. `event: message` 변종은 별도 후속 이슈로 분리해 기록한다(D 요약에 남긴다).
같은 파일을 이 사이클에서 추가로 고치면 컨트리뷰터 PR의 범위를 침범하고 리뷰 부담이
커진다.

### `tests/claude-outbound.test.ts`

추가 케이스 **5개** (초판은 2개로 적었다 — 감사 지적 10, 정정):

1. `data-only Responses frames infer event names from payload types` —
   `response.created` / `output_text.delta` / `response.completed` + `[DONE]`을 전부
   `data:` 온리로 보내고 `message_start … message_stop` 7개 이벤트 시퀀스, delta 텍스트,
   `stop_reason: end_turn`, usage를 검증.
2. `explicit and data-only Responses frames can interleave` — `event:` 있는 프레임과
   없는 프레임 혼재 처리 검증.
3. 비스트리밍 집계 경로 (`collectAnthropicMessage`)에서의 data-only 처리.
4. 명시 `event:`가 payload `type`보다 우선하는지 검증.
5. 터미널 프레임 없는 `[DONE]`에서 fail-closed 되는지 검증.

판정: 회귀 커버리지가 AGENTS.md 요구(서브시스템 인접 위치의 집중 테스트)를 만족한다.
실제 커버리지가 초판 판단보다 넓다.

참고(감사에서 검토 후 기각): `src/claude/outbound.ts:661` 부근의 두 번째
`if (!eventName || !dataLine) continue;`는 패치되지 않았지만 **결함이 아니다**.
`collectAnthropicMessage`는 `responsesSseToAnthropicSse`의 *출력*을 소비하고
(`src/server/claude-messages.ts:749`), 그 출력은 항상 `sseFrame`으로 `event:`를 붙인다
(`outbound.ts:75-77`). 업스트림 Responses 프레이밍을 직접 보지 않으므로 엄격한 게이트가
오히려 옳다.

## 실행 계획

### 1. cancelled 체크 재실행

```bash
gh api -X POST repos/lidge-jun/opencodex/actions/jobs/90673729420/rerun
# 실패 시 (job rerun 미지원 상태): 런 단위 실패-only 재실행
gh run rerun 30480687886 --failed
```

`--failed`가 cancelled를 집지 않으면 런 전체 재실행으로 폴백한다.

### 2. 로컬 독립 검증

```bash
bun x tsc --noEmit
bun test tests/claude-outbound.test.ts
```

`tests/claude-endpoint.test.ts`는 이 저장소에 없다(초판 오기). SSE 인접 스위트는
`rg --files tests | rg -i "claude|sse"`로 실재 파일을 먼저 확인한 뒤 고른다.
베이스라인: 현재 `dev`에서 `bun test tests/claude-outbound.test.ts` → 25 pass / 0 fail
(감사 실측). PR 적용 후에는 신규 5케이스가 더해진 수치가 나와야 한다.

원격 CI를 신뢰하되 로컬에서도 독립적으로 재현한다(C 단계 증거).

### 3. 승인 + 머지

```bash
gh pr review 711 --approve --body "<영문 리뷰: 스펙 근거 + 검증 결과>"
gh pr merge 711 --squash --delete-branch=false
```

MAINTAINERS.md: 머지 전 메인테이너 승인 1건 + 필수 CI green.
리뷰는 AGENTS.md 규칙에 따라 **영문**으로 작성한다.

### 4. 이슈 클로즈 확인

PR 본문이 `#700`을 참조하는지 확인하고, 자동 클로즈되지 않으면 수동으로 닫는다.

```bash
gh pr view 711 --json mergedAt,state
gh issue view 700 --json state
gh issue close 700 --comment "<머지 커밋 참조>"   # 필요 시
```

## 수용 기준

- `windows-latest`가 `success` (또는 재실행 후에도 cancelled면 원인을 규명하고 기록)
- 로컬 `tsc` exit 0, `claude-outbound` 스위트 전건 pass
- `gh pr view 711` → `mergedAt` non-null, `state: MERGED`
- `gh issue view 700` → `state: CLOSED`
- `event: message` 잔여 결함이 후속 이슈로 기록됨

## 활성화 근거 (C-ACTIVATION-GROUNDING-01)

이 변경은 **조건 분기**를 건드린다: "`event:` 필드 부재" 경로.
기존 테스트는 전부 `event:` 있는 프레임을 보내므로 새 분기를 밟지 않는다.
새 테스트 케이스 1이 정확히 그 트리거(`dataOnlySse()`로 `event:` 없는 프레임 생성)를
구동하고, 관측 효과는 "7개 Anthropic 이벤트 시퀀스가 생성됨"이다. 수정 전이라면
프레임이 전부 버려져 truncation 에러가 났을 자리다.
→ **패치를 되돌린 상태에서 새 테스트가 실제로 실패하는지** 확인해 분기 활성화를
증명한다 (역방향 ablation).

## 범위 경계

- IN: #711 검증·머지, #700 클로즈
- OUT: `src/claude/outbound.ts`에 추가 리팩터 금지 — **`event: message` 변종 수정도
  이 사이클 범위 밖**이며 후속 이슈로 분리한다. truncation 정책 자체 변경 금지.
  다른 SSE 이슈(#658 AgentRouter terminal frame 부재)도 별건이다.

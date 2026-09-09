# wp8 — 처분 기록과 최종 회귀 증명

구현이 끝난 뒤 남는 것을 종결시키고, `dev`가 이번 작업으로 깨지지 않았음을 증명한다.

## 처분 1 — PR #3061 close

저자는 메인테이너 본인(@lidge-jun)이고, 이 PR은 이미 무의미하다.

`78c630a93` (#3351 "test: stop three CI timing flakes from blocking the release train")이
`origin/dev`의 조상이고, 같은 파일에 같은 세 가지를 더 나은 형태로 이미 적용했다:

| 항목 | #3061이 하려던 것 | dev에 이미 있는 것 |
|------|------------------|-------------------|
| stdio 캡처 | 추가 | `tests/shutdown-launcher.test.ts:119` |
| 예산 상향 | 하드코딩 | `:84` `process.env.CI ? 60_000 : 20_000` |
| 진단 | `console.error` | `:143-150` exit code/signal/launcher 출력 |
| 테스트 타임아웃 | 하드코딩 `130_000` | `:174` `STARTUP_BUDGET_MS + 40_000` |

게다가 전제가 반증됐다. macOS job 99447051971에서 SIGINT 케이스가 **90초를 다 쓰고**
실패했다(`[90209.88ms]`). 20초 천장이 원인이라면 90초에서는 통과했어야 한다.
바로 다음 SIGTERM이 1623ms, SIGHUP이 825ms에 통과했으므로 "러너가 바빴다"도 성립하지 않는다.

@Ingwannu의 CHANGES_REQUESTED가 추가로 지적한 것도 현재 파일에서 확인된다:
`scripts/ci/run-bun-test-batches.sh:6`이
`BATCH_TIMEOUT_SECONDS="${BUN_TEST_BATCH_TIMEOUT_SECONDS:-120}"`이고 `:113-114`가
`"${BATCH_TIMEOUT_SECONDS}s"`로 배치를 감싼 뒤 `bun test --isolate --timeout 60000`을
돌린다. 따라서 #3061이 넣으려던 130초 per-test 예산은 120초 배치 봉투를 초과해
절대 소진될 수 없다.

## 처분 3 — 식별된 결함의 배정

#3425 조사 중 별도 결함 하나가 나왔다. `tests/codex-routing.test.ts:527`의
characterization 테스트가 `reconcileCodexRoutingHealth`를 한 번도 호출하지 않아
`liveHealthAccountIds`가 빈 Set인 상태를 고정한다. 프로덕션에서는 재현되지 않는
상태이므로, 이 테스트는 도달 불가능한 경로를 초록으로 굳히는 false confidence다.

이것은 "결정이 필요한 항목"이 아니라 식별된 결함이다. 처분을 미루지 않고
#3425 코멘트에 별도 항목으로 명시해 기록한다. 이번 유닛에서 테스트를 고치지 않는
이유는 그 수정이 #3425의 근본 원인 판정과 함께 가야 하기 때문이고, 그 사실 자체를
코멘트에 적는다.

처분: 근거를 단 close. 되살릴 이유가 없다.

## 처분 2 — 설계 결정이 선행하는 항목의 근거 게시

아래는 이번 유닛에서 코드를 건드리지 않되, 왜 안 하는지를 해당 PR/이슈에 남긴다.
침묵은 처분이 아니다.

- **PR #3348** — blocker 잔존 확인. head `928841669`의 `src/combos/failover.ts:627`이
  `[401, 402, 403, 404, 408, 410, 413, 425, 429]`로 generic 410/413을 hop 리스트에 넣는다.
  dev는 `[401, 403, 404, 408, 429]`다. 무관한 application 410과 진짜 과대 요청 413이
  다음 프로바이더로 재전송된다. `devlog/_fin/260703_sse-midstream-reset-tail/00_plan.md:19-23`이
  중복 완료·중복 과금을 이유로 이미 거부한 동작이다. 안전하게 떼어낼 조각 3개
  (DeepSeek quota 9줄, pacing 503, preflight 502)를 PR에 나열해 저자가 직접 쪼갤 기회를 준다.
- **PR #3389** — 전제 반증. "0바이트면 업스트림이 아무것도 커밋 안 했다"가 안전성 논거인데,
  Bun에서 2청크 방출 후 리셋 시 리더가 0바이트를 관측하는 것이 4/4 재현됐다.
  커밋된 비멱등 턴(`store: true`, `mcp`, `web_search`)이 중복 전송될 수 있다.
  게이트를 바이트 수가 아니라 SSE 프로토콜 이벤트 증거로 바꿔야 한다.
- **PR #3329** — 신규 노브에 더해 `coolComboTarget` 쿨다운 우선순위를 무단 역전한다.
  `options.cooldownMs ?? parseRetryAfterMs(...)` → `parseRetryAfterMs(..., {preserveImmediate: true}) ?? ...`.
  모든 기존 combo 사용자에게 적용되는 동작 변경이고, "Retry-After가 항상 설정값을 이긴다"는
  제품 판단이다. 3조각 분할 제안.
- **이슈 #3425** — 이전 REJECT 유효, 새 용의자도 반증. `src/codex/routing.ts:2195`의
  가드는 `writerGeneration < lastReconciledGeneration && !liveHealthAccountIds.has(accountId)`
  라는 AND 조건인데, `liveHealthAccountIds`는 `:331`에서 `context.codexAccountIds`로
  채워지고 그 값은 `listLiveCodexAccountIds`(`:282`)가 config 전체 id를 담아 만든다.
  보고자의 계정 A는 등록된 채 살아 있었으므로 두 번째 조건이 false이고 early return이
  일어나지 않는다. 삭제된 계정에만 발화하는 가드다.
  보고자 질문을 "config reload"에서 **"계정 삭제/재등록 여부"와
  "Codex App이 계정을 고정(fixed)해 보내는 구성인지"**로 교체한다.
- **이슈 #3245** — BLOCKED 유지. 실패가 첫 POST 이전 지점이라 SSE relay/repair/timeout
  코드에 도달조차 하지 않는다. `stale-needs-info`가 타임아웃을 소유한다.

## 최종 회귀 증명

`dev`는 이 세션 중에도 움직인다. 따라서 회귀 확인은 "머지 전 green"이 아니라
**최종 dev head에서의 green**이어야 한다.

1. `git fetch origin dev` — 최종 head SHA를 기록.
2. 이번에 랜딩한 모든 머지 SHA에 대해 `git merge-base --is-ancestor <sha> FETCH_HEAD`.
3. 최종 head의 CI run을 `gh run list --branch dev --limit 5`로 찾아 결론 확인.
4. **작업 시작 시점 대비 비교**: base `2421e44ce`의 CI 결론과 최종 head의 결론을
   나란히 놓는다. 시작 시점이 이미 빨간색이었다면 그 실패가 그대로인지(회귀 아님)
   새 실패가 붙었는지(회귀)를 job 이름 단위로 구분한다.
5. 실패가 있으면 그것이 이번 변경에서 온 것인지 focused 테스트로 좁힌다.
   전체 스위트는 여전히 금지 — CI가 3개 OS에서 이미 돌린다.

시작 시점 확인이 특히 중요하다. base `2421e44ce`의 CI run `33867257170`이 이미
`failure`였다는 관측이 있으므로, 그 실패의 정체를 먼저 확정하지 않으면
"내가 깼는지"를 판정할 수 없다.

## Accept criteria

- #3061이 근거 코멘트와 함께 closed.
- #3348 / #3389 / #3329 / #3425 / #3245에 각각 판정 코멘트가 게시됨.
- 랜딩한 모든 SHA가 최종 `origin/dev`의 조상임이 증명됨.
- 최종 dev head의 CI 결론이 base 대비 새 실패 0건임이 job 단위로 확인됨.

# 040 — 다음 구현 라운드 지도

`030`의 F1~F6을 decade 번호로 옮긴다. 이 문서는 다음 유닛의 입력이다.

다음 유닛 이름: `devlog/_plan/YYMMDD_stream_termination_and_triage_fixes/`
(착수일로 YYMMDD를 정한다)

## 단계 지도

`DIFFLEVEL-ROADMAP-01`에 따라, 각 단계는 착수 전 P에서 diff 수준으로 구체화된다.
아래는 **범위와 의존 관계**를 고정하는 것이지 diff 자체가 아니다. 이 유닛은 문서만
만들기로 한 범위이므로, diff는 다음 유닛의 첫 P가 쓴다.

| 문서 | 단계 | 선행 | 성격 |
|---|---|---|---|
| `000_plan.md` | 목표·제약·단계 지도 | — | 연구 |
| `010_bridge_tool_termination.md` | F1 bridge 취소 경로 | — | 구현 |
| `020_agentrouter_eof_profile.md` | F2 #658 호환 모드 | **010** | 구현 |
| `030_tool_schema_root_type.md` | F3 #745 정규화 + 테스트 | — | 구현 |
| `040_acl_directory_state.md` | F4 #782 상태 전파 | — | 구현 |
| `050_kiro_catalog_budget.md` | F5 #719 총량 예산 | — | 구현 |
| `060_kiro_windows_install.md` | F6 #716 플랫폼 안내 | — | 구현 |
| `070_test_quality_audit.md` | 약한 테스트 3건 + 패턴 | — | 구현 |

`010` → `020`만 실제 의존이다. 나머지는 병렬 가능하다. 그렇다고 한 사이클에 둘을
넣지는 않는다 — 하나의 work-phase는 하나의 PABCD 사이클이다.

## 각 단계의 완료 조건

### 010 — bridge tool call 종료 (F1)

**범위**: `src/bridge.ts`. `closeCurrentToolCall()`(`:378-417`)과 병렬로 취소
경로를 두고, `:776`(error)과 `:835`(암묵 EOF) 양쪽에서 실패 시 취소를 쓴다.
PR #781의 `failCurrentToolCall()`을 리베이스해 살리는 것이 출발점이다.

**같이 고칠 것**: `bridge.ts:436-441` 주석이 `response.completed`를 합성한다고
하는데 실제로는 `:838`이 `response.incomplete`를 낸다.

**증명**: 취소 경로를 `closeCurrentToolCall()`로 되돌리는 ablation에서 실패해야
한다. 통과하면 그 테스트는 무력하다.

**주의**: 빈 인자는 `"{}"`로 직렬화돼야 한다(`:381-383` 주석). `JSON.parse("")`가
다음 턴 전체를 400으로 만든다. 취소 경로에서도 이 불변식이 유지돼야 한다.

### 020 — AgentRouter EOF 프로파일 (F2)

**범위**: `bridge.ts:105-145` 시그니처에 provider 정책 파라미터 추가,
`responses/core.ts:2463-2477` 호출부에서 전달. **어댑터는 건드리지 않는다.**

**완료 조건**: 프로파일 OFF에서 기존 절단 테스트 전부 통과, ON에서만 AgentRouter
형태가 완료. 기본값 fail-closed.

### 030 — tool schema 루트 type (F3)

**범위**: `src/responses/parser.ts:137-149`,
`src/adapters/openai-responses.ts:920-951`(passthrough). `schema.ts:99-105`도 볼 것.

**완료 조건**: 두 경로 모두 테스트. 파서만 덮으면 passthrough 라우트가 빈다.

### 040 — ACL 디렉터리 상태 (F4)

**범위**: `src/server/management-auth.ts`. `assertSafeDirectory`가 상태를 반환하고
파일 쪽 상태와 OR 결합.

**범위 밖**: opt-in 정책을 열 것인가는 메인테이너 보안 리뷰다. 우리는 보고가
사실과 맞게 만드는 것까지.

### 050 — Kiro 카탈로그 예산 (F5)

**범위**: `src/adapters/kiro-tools.ts`. 현재 `truncateDescription()`(`:144-148`)만
있고 총량 예산이 없다.

**선행 결정**: 초과 시 무엇을 버리는가. 임의 절단은 도구를 조용히 없앤다.

### 060 — Kiro Windows 안내 (F6)

**범위**: `src/oauth/kiro.ts:360,378` + 로케일 5개.

**선행 조건**: 공식 Windows 설치 명령 확인. 모르면 추측해서 쓰지 않는다.

### 070 — 테스트 품질 (별도)

**범위**: `tests/logs-timezone.test.ts:44,57`,
`tests/service-stop-verification.test.ts:40`,
`tests/windows-tray-run-limit.test.ts:18`.

각각 프로덕션 동작을 되돌려도 통과한다. 고치는 것보다 **패턴을 막는 것**이 중요하다.
직전 라운드 #790·#758에 이번 3건이면 다섯이다.

## 게이트 결과

| 게이트 | 결과 |
|---|---|
| `bun run typecheck` | PASS |
| `bun run test` | **6251 pass / 0 fail / 4 skip**, 455파일 |
| `bun run privacy:scan` | PASS |
| `bun run test tests/repo-hygiene.test.ts` | 10 pass / 0 fail |

게이트를 돌리는 과정에서 세 번 막혔고, **셋 다 코드 결함이 아니었다.** 기록해둔다.

### 1·2. 의존성 미설치 (루트, gui)

`bun run typecheck`가 `Cannot find type definition file for 'bun-types'`로 실패했다.
새 워크트리라 `node_modules`가 비어 있었다. `bun install` 후 통과.

같은 이유로 전체 스위트가 `Cannot find module 'react/jsx-dev-runtime'`로 2건
실패했다. `gui/`에서도 `bun install`이 필요했다. 이후 0 fail.

### 3. 저장소 트립와이어가 우리 문서를 잡았다

`tests/repo-hygiene.test.ts:161`의
`no open devlog plan carries an unresolved security verdict`가 실패했다.

규칙(`:174-175`): `_plan/`의 추적 문서가 미해결 판정(`NEEDS-CHANGES` 등)과
보안 경계 어휘를 **함께** 담으면 위반이다. 어휘 목록은 한국어를 포함한다(`:143`) —
영어만 있던 초안이 정작 excision을 촉발한 문서를 못 잡았기 때문이다.

`010`이 정확히 그 형태였다. 리뷰가 안 끝난 PR 6건을 표로 만들면서 각 표면을
구체적으로 적었다.

**정규식을 피해 가는 방식으로 고치지 않았다.** 그러면 게이트를 무력화하는 것이고,
`020`에서 무력한 테스트를 지적한 것과 같은 잘못이 된다. 대신 공개 문서에 남길
분석의 양을 줄였다 — 진행에 필요한 사실(어느 PR이 리뷰 대기인지, 확인된 결함 위치)만
남기고 표면별 매핑은 스크래치로 보냈다.

이 게이트는 실제로 작동한다. AGENTS.md가 "메인테이너에게도 똑같이 적용된다"고
적어둔 규칙이 이번에 우리에게 적용됐다.

## 이 라운드에서 배운 것

다음 유닛이 같은 실수를 안 하도록 남긴다.

**`gh pr diff`의 앞부분은 최종 상태가 아니다.** #781을 빈 PR로 오독할 뻔했다.
여러 번 force-push된 PR의 순 변경은 `git diff origin/dev...<head>`로 본다.

**CI 적색은 클래스를 나눠서 읽어야 한다.** 이번엔 세 갈래였다 — 런처 경로,
Bun 런타임 패닉, 무관한 flaky. 한 덩어리로 읽으면 27건 중 상당수를 근거 없이
"깨짐"으로 분류한다. 실제로 PR 고유 Windows 실패는 0건이었다.

**환경 문제를 코드 결함으로 적지 않는다.** `node_modules`가 비어서 난 typecheck
실패를 트리 결함으로 기록할 뻔했다. `bun install` 후 exit 0.

**"고쳐졌다"와 "안 고쳐졌다"가 동시에 참일 수 있다.** #570이 그랬다. 보고된 실패
모드가 해소됐는지와 인접 기능이 완성됐는지는 다른 질문이다. 이슈는 전자로 닫는다.

**동결 인벤토리는 실제로 필요했다.** 트리아지 중 #780이 머지됐고 PR 3건이 새로
열렸다. 동결이 없었으면 `010`과 `020`이 서로 다른 스냅샷을 봤을 것이다.

**감사가 잡은 것을 세어둔다.** 계획 감사가 blocker 4건을 냈고 전부 실제 결함이었다.
그중 base 브랜치 게이트는 작성 당시 위반 0건이라 형식적으로 보였는데, 30분 뒤
`main`을 겨냥한 PR이 실제로 나타났다.

## 이 유닛의 이월 조건

`devlog/README.md:26-28`대로 터미널 결과가 기록되면 `_fin/`으로 옮긴다. 다만 이
유닛의 산출물은 다음 라운드의 입력이므로, `030`/`040`이 후속 유닛에 반영될 때까지
`_plan/`에 남는다.

## 이월되는 미결

- **동결 이후 PR 3건**(#798 #799 #800) — 전부 base 위반. 리타깃 후 심사.
  #798의 주제(TLS hostname mismatch 구분)는 #553과 겹친다.
- **#780** 머지됨. 다음 라운드는 새 HEAD에서 `020`의 #764 행을 다시 봐야 한다.
- **오너 판단 대기**: #773 리버트 사유(#793/#735 잔여가 여기 걸림), #690
  `bypassPermissions` 정책, #586 UI 위치, #572 umbrella 처리.
- **이슈 미개설 4건** — `030` 참조.

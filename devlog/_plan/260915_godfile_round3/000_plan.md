# 260915 godfile round3 — 남은 src 갓파일 5개 분해

직전 라운드가 여섯 파일을 facade 뒤로 옮기고 파일 크기 래칫을 `dev`에 올린 뒤, `src/`에는 2,000줄 이상 파일이 아홉 개 남았다. 이 단위는 그중 다섯 개를 같은 방식으로 분해한다. 남기는 넷 중 `src/server/responses/core.ts`는 함수 하나가 5,000줄이 넘어 별도 프로그램이고, `src/server/index.ts`는 분해가 동기 activation 가드를 무력화하므로 가드를 먼저 고쳐야 한다. `src/adapters/openai-responses.ts`와 `src/bridge.ts`는 export 밀도가 낮아 경계가 아니라 단일 흐름이라는 뜻이고, 쪼개면 내부 상태가 인자 목록으로 샌다.

기여자에게 바뀌는 것은 없다. 다섯 파일 모두 facade가 남고 공개 export 표면이 보존되므로 import 경로는 그대로다.

## 로프스펙

| 항목 | 내용 |
|---|---|
| Loop archetype | satisfy-spec. 파일별 완료 조건이 고정돼 있고 사이클마다 종료한다 |
| Trigger | 직전 라운드 완료 후 "5개 정도 더" 요청 |
| Goal | 다섯 파일을 1,999줄 이하로 분해하고 스택 PR로 `origin/dev`에 머지 |
| Non-goals | `core.ts`·`server/index.ts`·`openai-responses.ts`·`bridge.ts`, 기능 변경, 버그 수정 동반, `tests/` 분해 |
| Verifier | hosted CI. 로컬은 `structure:check`·래칫·`/tmp/m3_verify.ts`(파싱·export 표면·상대경로·tsc) |
| Stop condition | 다섯 파일이 모두 분해되고 레인이 `dev`에 머지될 때 |
| Memory artifact | 이 단위와 각 PR 본문 |
| Expected outcomes | 성공 = 5파일 facade화 + 래칫 녹색 / 차단 = tip CI 적색이 반복되고 원인이 분해 외부일 때 |
| Escalation | `auth-api.ts`의 credential 경계를 옮기는 PR은 보안 검토 대상이다 |

## 직전 라운드가 남긴 교훈

지난 라운드에서 로컬 구문 검사와 export 표면 대조만으로는 네 종류의 결함을 전부 놓쳤고 hosted CI가 잡았다. 리프가 심볼을 정의하고 export하지 않은 경우, 파사드가 re-export만 하고 로컬 import를 빠뜨린 경우, 타입을 엉뚱한 모듈에서 가져온 경우, 그리고 정의가 통째로 사라지고 호출부만 남은 경우다. 마지막으로 한 단계 깊어진 디렉터리에서 `../config`가 `src/codex/config`로 해석돼 routing 그래프를 로드하는 모든 테스트 샤드가 import 시점에 죽었다.

그래서 이번 라운드의 검증은 `/tmp/m3_verify.ts` 하나로 묶었다. 파싱, `origin/dev` 대비 facade export 표면, 상대 import 해석, 그리고 노드/Bun 타입 부재 노이즈를 걸러낸 tsc 오류를 한 번에 본다. 각 구현자는 이 스크립트가 `ALL CHECKS PASS`를 낼 때까지 보고하지 않는다.

## 작업 단계 지도

아래 표의 브랜치 열은 실행되지 않았다. 다섯 파일이 서로 겹치지 않아 한 워킹트리에서 동시에 작업했고 결과가 두 개의 PR로 수렴했다. 무엇이 실제로 일어났는지는 [`090_outcome.md`](./090_outcome.md)가 기록한다. 각 decade 문서의 이동 계약과 함정 항목은 그대로 실행됐다.

| 사이클 | 문서 | 대상 | 현재 줄 | 브랜치 |
|---|---|---|---|---|
| 0 | `000_plan.md` + 010~050 | 로드맵(코드 변경 없음) | — | `codex/m3-l1-roadmap` |
| 1 | `010_phase1_config.md` | `src/config.ts` | 4,799 | `codex/m3-l2-config` |
| 2 | `020_phase2_providers_registry.md` | `src/providers/registry.ts` | 3,744 | `codex/m3-l3-registry` |
| 3 | `030_phase3_codex_auth_api.md` | `src/codex/auth-api.ts` | 3,134 | `codex/m3-l4-auth-api` |
| 4 | `040_phase4_catalog_provider_fetch.md` | `src/codex/catalog/provider-fetch.ts` | 2,944 | `codex/m3-l5-provider-fetch` |
| 5 | `050_phase5_adapters_openai_chat.md` | `src/adapters/openai-chat.ts` | 2,234 | `codex/m3-l6-openai-chat` |

다섯 파일은 서로 겹치지 않으므로 체인 순서는 리뷰 편의를 위한 것이다. `config.ts`를 먼저 두는 이유는 문서(10곳)와 오라클(9건)을 가장 많이 끌고 있어 나머지가 그 패턴을 재사용하기 때문이고, `auth-api.ts`를 중간에 두는 이유는 보안 검토가 필요한 유일한 대상이라 앞뒤 레이어와 분리해 두기 위해서다.

## 스택과 머지

수동 브랜치 체인이다. 각 링크의 PR base는 아래 링크의 head이고 최하단만 `dev`를 base로 한다. 체인 자식은 top-down으로 머지한다. 스택 자식을 머지하면 trunk가 아니라 부모 브랜치에 착지하기 때문이다. 최하단을 `dev`에 머지하기 직전의 exact-head CI가 이 단위의 최종 게이트다.

`dev`는 하루 수백 커밋이 움직이므로 최종 머지 직전에 `dev`를 다시 병합하고 래칫 기준선을 병합 트리 기준으로 재시드한다. 지난 라운드에서 기준선이 분기 시점에 고정돼 있어 그사이 `dev`가 키운 파일 다섯이 `GREW`로 잡혔다.

## 완료 조건

| 검사 | 조건 |
|---|---|
| 파일 크기 | 대상 5개가 전부 1,999줄 이하, 새 모듈 전부 1,999줄 이하 |
| 검증 | 각 대상에 `/tmp/m3_verify.ts` `ALL CHECKS PASS` |
| 구조 | `bun run structure:check` 녹색, 백틱 경로가 새 소유 모듈을 가리킴 |
| 래칫 | 병합 트리 기준 재시드 후 통과 |
| 오라클·INV | 본문을 텍스트로 읽는 오라클의 읽기 경로 갱신, INV 승계 모듈 지정 |
| 보안 | `auth-api.ts`의 credential 이동 PR은 별도 검토 기록 |
| 머지 | 6개 PR 전부 MERGED, `dev` 착지 후 회귀 녹색 |

머지 행은 실제로 2개 PR(#4658 → #4655)로 충족됐다. 나머지 조건은 모두 충족됐고 증거는 `090_outcome.md`에 있다.

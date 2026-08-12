# 070_closeout — 유닛 종료 요약

작성 2026-07-31. 유닛 `260731_structure_sot_refresh`. 결과 `DONE`.

## 무엇을 고쳤나

`structure/` 아홉 문서 전부. 커밋 일곱 개, 전부 로컬(푸시 없음):

| WP | 커밋 | 대상 | 감사 |
|----|------|------|------|
| WP0 | `c8771b91b` | devlog 유닛 (문서 전용 로드맵) | 4라운드, 43 블로커 → GO-WITH-FIXES |
| WP1 | `e9d6f0200` | `00_overview`, `01_runtime` | 1라운드 PASS |
| WP2 | `988a7a7bd` | `02_config-and-codex-home`, `03_catalog-and-subagents` | 1라운드 GO-WITH-FIXES (4) |
| WP3 | `0eb3bbea8` | `04_transports-and-sidecars` | 2라운드 → PASS (2) |
| WP4 | `46a81aaf4` | `05_gui-and-management-api` + 검증기 수정 | 2라운드 → PASS (2) |
| WP5 | `b95b0e742` | `06_docs-and-release`, `07_design-methodology`, `08_openai-provider-tiers` | 2라운드 → PASS (1) |
| WP6 | 이 커밋 | Reading order 동기화, 라우트 커버리지 마감, 이 문서 | — |

정정한 서술: STALE 12건(S1–S12), IMPRECISE 10건(I1–I10).
가장 값이 큰 것은 S1이다. `04`가 `Claude-3p`를 "폐기된 경로"로 서술했는데 실제로는 Desktop의
현행 기본값이었다. 그 문서를 따랐다면 접미사를 다시 제거해 #539를 재도입했을 것이다.

## 측정 (`004_measure.sh`)

| 지표 | WP0 기준선 | 종료 |
|------|-----------|------|
| `documented_route_literals` | 25 | 88 |
| `undocumented_dirs` | 9 | 0 |
| `dead_paths` | 0 | 0 |
| `doc_only_routes` | 0 | 0 |
| `brace_paths` | — | 0 |

등록 라우트 90개 중 88개가 문서에 있다. 남은 2개(`/api/`, `/api/codex-auth/`)는 접두 매칭
문자열이고 실제 엔드포인트가 아니다 — 이건 커버리지 공백이 아니라 측정 방식의 잔재다.

게이트: `bun x tsc --noEmit` 0, `bun test tests/repo-hygiene.test.ts` 10 pass,
`bun run privacy:scan` 통과, `git diff --check` 클린. work-phase마다 재실행했다.
전체 `bun test`는 WP0에서 백그라운드로 띄웠으나 병렬 작업 부하(load 6–7)로 60분 넘게 끝나지
않아 완주를 확인하지 못했다. 문서 편집이 영향을 줄 수 있는 계열
(repo-hygiene, privacy, ci-workflows, api-usage, codex-inject, claude-desktop-config-path,
vision-fail-closed)은 모두 개별로 통과시켰다. 이건 "전체 통과"가 아니므로 그렇게 적지 않는다.

## `04` 분할 판단 (`002` §G 미결 사항)

**분할하지 않는다.** `04`는 40.8KB로 이 폴더에서 가장 크지만, Writing rule의 분할 기준은 크기가
아니라 "한 문서가 독립적인 두 주제를 담아 독자가 자기 주제만 읽을 수 없는가"다. `04`는 그 상태가
아니다: 전부 하나의 축 — 업스트림으로 나가는 바이트가 어떤 계약을 지켜야 하는가 — 위에 있고,
새로 추가한 Transport inventory 표가 오히려 진입점 역할을 해서 특정 프로바이더를 찾는 독자가
전체를 읽지 않아도 되게 만들었다. 분할하면 공통 계약(HTTP/SSE, WebSocket, heartbeat, retry)과
프로바이더별 하드닝 사이에 상호 참조가 늘어나고, 그 참조가 다음 드리프트의 자리가 된다.
재검토 조건: 프로바이더별 절이 지금의 두 배가 되거나, 공통 계약 절이 프로바이더 절을 참조하지
않고 독립적으로 읽히기 시작하면 그때 `09_provider-transports.md`로 분리한다.

## 되짚어볼 것

감사가 총 12라운드 돌았고 블로커 52건이 나왔다. 전부 수용했고 반박은 없었다. 패턴은 하나다:
**드리프트 판정은 정확했고, 그것을 고치는 문안이 부정확했다.**

- WP0 계획 감사가 3라운드 연속 FAIL. 원인은 매번 같았다 — 확인하지 않은 절대어(`never`,
  `always`)와 셋 크기 주장. 개별 문장을 고치는 방식으로는 수렴하지 않아서, `000_plan.md`에
  서술 계약 7개 항을 박고 각 phase 문서에 자기점검 표를 붙였다. 그 뒤 WP1은 1라운드 PASS.
- 그래도 완전히 사라지지는 않았다. WP2 4건, WP3 2건, WP4 2건, WP5 1건. 살아남은 것들의 공통점이
  분명하다: **그 사이클에서 열어보지 않은 파일에 대한 주장.** WP4부터 라우트 모듈을 먼저 다 읽고
  쓰기 시작했고, 그 라운드의 라우트 등록 오류는 0건이었다(남은 2건은 payload 형태와 컴포넌트 소유).
- 3라운드 감사는 반대 방향 사고도 잡았다. 내가 `00_overview.md:4`의 **맞는 문장**을 STALE로
  판정했다. `docs/README.md`가 스스로 조사·진단 노트를 담는다고 선언하고 있었다. 감사가 없었으면
  맞는 문서를 틀리게 고쳤을 것이다. 그래서 서술 계약 1항은 판정에도 적용된다.
- 죽은 하이포시시스: "링크가 깨진 문서를 고치는 작업"이라는 최초 가정. 문서가 지목한 소스 경로
  35개는 전부 살아 있었다. 낡은 것은 경로가 아니라 동작 서술과 커버리지였다.
- 내 검증기도 틀렸다. WP4에서 경로 정규식이 `tsx`보다 `ts`를 먼저 시도해 `.tsx` 인용 8개를 죽은
  경로로 보고했다. 거짓 양성을 내는 검증기는 무시하도록 학습시키므로, 이 수정은 문서 수정만큼
  중요하다.

## 후속 (이 유닛 범위 밖)

1. `AGENTS.md:47` — "Nothing in the build, typecheck, or test path reads from `devlog/`"는 거짓이다.
   `tests/repo-hygiene.test.ts`가 devlog Markdown을 열거하고 열린 plan을 읽으며,
   `scripts/privacy-scan.ts`와 두 개의 릴리스 게이트 스크립트도 읽는다.
2. `AGENTS.md:19` — "`go/` — retired Go native-runtime experiment; kept only where the TypeScript
   runtime still references it"도 거짓이다. `git ls-files go`는 0을 반환한다. 추적되는 `go/` 트리는
   없다.
3. 이 유닛의 `_fin` 승격은 공개 랜딩 이후 관리자 작업이다. `AGENTS.md:39-42`가 `_fin`을
   "이미 공개 git 히스토리에 보이는 작업의 기록"으로 정의하므로 로컬 커밋만으로는 조건을 못 채운다.

두 `AGENTS.md` 오류는 조용히 고치지 않았다. 이 유닛은 `structure/**`만 소유하고, 범위를 넘겨
고치면 그 변경은 감사받지 않은 채 남는다.

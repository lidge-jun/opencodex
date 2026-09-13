# 000 — Devin 착지와 캐싱 개선 (계획)

- 단위 슬러그: `260913_devin_landing_and_caching`
- 세션: `01a0985e-ce1a-7d12-81b9-c2e93a2bce67` (HOTL, cxc-loop)
- 기준 HEAD: `7ca00ffe7c1299e80d650a3243b2bc7cf09109ad` (= `origin/dev`, 확인 시각 2026-09-13)
- 워크트리: `/Users/jun/.codex/worktrees/8513/opencodex` (detached, app-managed)

## 목적

열려 있는 Devin 관련 draft 두 건을 현재 `dev`에 착지시키고, 그 위에서 Devin
트랜스포트의 캐싱을 CLIProxyAPIPlus와 omp/omo보다 낫게 만든다. 작업 중 사용자가
실제로 맞은 런타임 오류(`stream disconnected before completion: cloud-direct:
time-to-first-byte timeout (60000ms)`)도 같은 단위에서 근본 원인까지 고친다.

그 오류는 부수적인 잡음이 아니라 이 단위의 핵심이다. Devin에게 직접 코드를
수정시키려던 시도가 실패한 이유가 바로 이것이고, 아래 wp3에서 보듯 프록시가
살아 있는 업스트림을 스스로 끊고 있었다.

## 제약 (사용자 지시 + AGENTS.md)

| 제약 | 내용 |
|---|---|
| 로컬 스위트 금지 | `bun run test` / `typecheck` / `build` / `install` / `structure:check` / `privacy:scan` 모두 **NOT RUN**. 증거는 carry PR의 exact-final-head hosted CI. |
| 푸시 경로 | `dev`/`main`/`preview` 직접 푸시 금지. 전부 PR 경유. |
| 머지 권한 | `lidge-jun`은 `admin`. MAINTAINERS.md의 maintainer integration 조항으로 `dev` 한정 단독 통합 가능. 결정과 exact-head 검증을 PR에 기록해야 한다. |
| 저작자 보존 | 남의 PR을 carry하면 `Co-authored-by` 트레일러 필수 (AGENTS.md, CREDITS.md). 산문 언급은 무효. |
| 보안 노트 | 미공개 취약점 분석은 `.tmp/`에만. `devlog/`는 공개 디렉터리다. |
| 서브에이전트 | `xai/grok-4.6` 무제한 병렬 파견 허용 (사용자 명시). 리프는 쓰기 범위가 서로 겹치지 않아야 한다. |

## 조사 산출물 (이 계획의 근거)

5개 레인을 `xai/grok-4.6`으로 병렬 파견해 얻은 read-only 리포트. 전부 `.tmp/`에 있고
추적되지 않는다.

| 레인 | 산출물 | 핵심 결론 |
|---|---|---|
| A | `.tmp/research/laneA-devin-binary.md` | 로컬 Devin CLI `3000.10.21 (611c1cba)` 해부 |
| B | `.tmp/research/laneB-cliproxyapiplus.md` | Plus vs omp/omo vs opencodex 3자 대조 |
| C | `.tmp/research/laneC-our-devin.md` | 자사 devin/devin-cli 캐싱 전수 인벤토리 |
| D | `.tmp/research/laneD-ttfb.md` | TTFB 504 근본 원인 + 라이브 로그 3건 |
| E | `.tmp/research/laneE-carry-prs.md` | #4420/#4384 patch, 트레일러, apply 검증 |

참조 클론: `devlog/_chase/CLIProxyAPIPlus/` (gitignored, AGENTS.md `_chase` 규약).

## 3자 대조 요약

가장 중요한 발견은 두 구현이 정확히 반대 방향으로 반쪽이라는 것이다.

| 능력 | CLIProxyAPIPlus | omp/omo | opencodex (오늘) | 판정 |
|---|---|---|---|---|
| 세션/캐스케이드 재사용 | 매 요청 새로 생성 (`devin_executor.go:626-637`) | 해당 없음 | `(host, apiKey)` 재사용 (`chat.ts:72-91`) | **OCX 우위** |
| 프롬프트 캐시 옵션 f13 | 항상 전송 (`devin_request.go:335`, `devinEncodeCacheOptions`) | 해당 없음 | **없음** (`chat.ts:650-673`) | **OCX 결손** |
| 카탈로그 TTL 캐시 | 없음 | 없음 | 10분 (`catalog.ts:54`) | OCX 우위 |
| `invalid_argument` cooldown 회피 | HTTP 400 재분류 (`devin_executor.go:959-983`) | 해당 없음 | 없음 (`devin.ts:53-64`) | **OCX 결손** |
| tool 설명 절단 | 1024B rune-safe (`devin_tools.go:125-151`) | 해당 없음 | 6998 JS `slice` (`chat.ts:586-587`) | **OCX 결손** (한글 중간 절단) |
| 자격증명 identity 분리 | 요청 스코프 | 해당 없음 | `(host, apiKey)` 싱글톤, 계정 전환 시 미소거 | **OCX 결손** |

`omp`/`omo`는 Devin 트랜스포트가 아니다. `omp.ts`는 Oh My Pi YAML, `omo`는 senpi
`models.json` + `sendSessionAffinityHeaders`다. 캐싱 비교 대상은 실질적으로 Plus 하나이며,
"Plus보다 낫게"의 정의는 **OCX의 세션 재사용 + Plus의 f13 + Plus에 없는 identity 분리**다.

## 작업 단계 지도 (의존 순)

```
wp0 (이 문서) ──┬── wp1  #4420 carry      (독립)
                ├── wp2  #4384 carry      (독립)
                ├── wp3  TTFB 생성 데드라인 (독립, 사용자 실측 버그)
                └── wp4  Devin 캐싱/identity (wp3와 같은 파일 → wp3 다음)
```

| wp | 문서 | 산출물 | 쓰기 범위 |
|---|---|---|---|
| wp0 | 이 문서 + 010/020/030/040 | 로드맵 | `devlog/_plan/260913_devin_landing_and_caching/` |
| wp1 | `010_wp1_swe2_effort_carry.md` | carry PR → merge | `src/adapters/devin.ts`, `tests/providers/devin-adapter.test.ts`, docs/structure |
| wp2 | `020_wp2_devin_cli_fixture_carry.md` | carry PR → merge | `tests/providers/devin-cli-login.test.ts` |
| wp3 | `030_wp3_ttfb_generation_deadline.md` | 버그픽스 PR → merge | `src/adapters/devin/cloud-direct/chat.ts`, `src/adapters/devin.ts`, 신규 테스트 |
| wp4 | `040_wp4_devin_prompt_cache_and_identity.md` | 기능 PR → merge | `chat.ts` 인코더/세션, `catalog.ts`, `auth.ts`, 신규 테스트 |

wp1과 wp2는 파일이 겹치지 않는다 (레인 E 확인). wp3과 wp4는 둘 다 `chat.ts`를
만지므로 순차로 간다.

## 완료 기준

| id | 기준 | 증거 |
|---|---|---|
| c-1 | 이 단위가 000 + 단계별 decade 문서를 diff 수준으로 보유 | 파일 목록 |
| c-2 | #4420 수정이 `dev`에 merge | merge SHA + 트레일러 + CI run id |
| c-3 | #4384 수정이 `dev`에 merge | merge SHA + 트레일러 + CI run id |
| c-4 | TTFB 504가 사라지고 회귀 테스트 존재 | merge SHA + CI run id |
| c-5 | 캐싱 개선이 merge되고 Plus/omp 대조표가 문서화 | merge SHA + 이 문서의 대조표 |
| c-6 | 모든 merge가 exact-final-head hosted CI 성공 | PR별 run id, cancelled/skipped는 성공으로 세지 않음 |

## 종료 조건

- `DONE`: c-1..c-6 전부 충족, 이 단위를 `_fin/`으로 이동.
- `BLOCKED`: fork 푸시 거부로 carry 불가, 또는 동일 head에서 CI 2회 연속 red.


## A 단계 감사 결과 (2026-09-13)

`xai/grok-4.6` 리뷰어 2명을 병렬로 붙여 로드맵 전체를 트리와 대조했다. 두 감사 모두
`VERDICT: fail`로 돌아왔고, 블로커 4건은 아래처럼 반영했다.

| 블로커 | 내용 | 반영 |
|---|---|---|
| A-1 | `EFFORT_SUFFIXES`에 `priority` 누락 → `-priority` UID에 접미사 이중 부착 | **wp5 신설** (`050_...md`) |
| A-2 | abort 사유를 `CloudChatError`로 감싸도 `AbortError`에 먹힐 수 있음 | 030 감사 반영 절 (catch에서 명시 throw) |
| B-1 | `clearSessionIds()`가 전역 `Map.clear()`라 타 계정 진행 턴을 끊음 | 040 감사 반영 절 (identity 스코프 + epoch) |
| B-2 | (통과) 필드 13 인코딩 `6a 02 08 01` Plus와 바이트 동일 | 변경 없음 |

함께 확인된 것: 여섯 개 structure 복붙 hunk를 빼도 `structure:check`는 깨지지 않는다
(게이트는 경로 존재만 본다). sha256 캐시 키 전환을 깨뜨릴 호출자나 테스트는 없다.

감사 원문: `.tmp/research/audit-a-facts.md`, `.tmp/research/audit-b-cache.md`.

## 갱신된 작업 단계 지도

```
wp0 ──┬── wp1  #4420 carry
      ├── wp2  #4384 carry
      ├── wp3  TTFB 생성 데드라인
      ├── wp4  Devin 캐싱/identity   (wp3 다음, 같은 파일)
      └── wp5  effort 접미사 통합    (wp1 다음, 같은 함수)
```


## P 단계 수정 — wp6 추가 (2026-09-13, wp1 사이클 진입 시)

사용자가 `AssignModel` 누락을 지적했다. TTFB 원인으로는 기각됐지만(030 말미 참조 —
Plus도 `devinIsRouterModel` 가드 뒤에서만 부르고 `swe-2-high`는 걸리지 않는다),
라우터 uid를 아예 처리 못 한다는 별개 결손이 확인되어 wp6으로 세웠다.

| wp | 문서 | 산출물 |
|---|---|---|
| wp6 | `060_wp6_assign_model_router.md` | 라우터 uid용 AssignModel 선행 호출 + 필드 26 |

```
wp0 ──┬── wp1  #4420 carry
      │     └── wp5  effort 접미사 통합
      ├── wp2  #4384 carry
      └── wp3  TTFB 헤더 예산
            └── wp4  프롬프트 캐시 / identity
                  └── wp6  AssignModel 라우터
```

같은 검증에서 확정된 두 가지도 030에 기록했다: 헤더 이후 구간은 추론 프레임이
`resetIdle()`을 재무장시켜 이미 안전하고, Plus의 `http.Client{Timeout: 120s}`는
Go에서 전체 요청 예산이라 정상적인 3분 턴도 자른다 — 따라가지 않는다.

| id | 기준 | 증거 |
|---|---|---|
| c-7 | effort 접미사 통합 merge | merge SHA + CI run id |
| c-8 | AssignModel 라우터 지원 merge | merge SHA + CI run id |


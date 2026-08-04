# 000_plan — GUI 하이드레이션 회귀 수습 + 전 탭 로딩 계약 통일

유닛 `260730_gui_hydration_loading_unify`. 작성 2026-07-30.
근거: `000_research.md`, `001_live_evidence.md`.

## 목표

탭을 전환하면 어느 탭이든 (1) 즉시 요청이 나가고, (2) 데이터가 오기 전에는 그 화면의
실제 레이아웃을 닮은 로딩 표시가 뜨고, (3) 빈 결과·실패·로딩이 서로 구별되고,
(4) 배경 재검증이 이미 보이는 데이터를 지우지 않는다. 그리고 설정 카드가 앱 전체에서
한 가지 패턴을 따른다.

## 비목표

- 라우터 교체, 상태 관리 라이브러리 도입, 디자인 시스템 재작성.
- 새 디자인 토큰 발명 (`styles.css` 기존 토큰만 사용).
- 서버 API 계약 변경 — WP5의 쿼터 팬아웃 완화는 캐시/단일 비행 내부 최적화로 한정.

## 제약

- Bun 네이티브 TypeScript. `bun run typecheck` / `bun run test` / `bun run lint:gui` 통과 필수.
- 모든 PR은 `dev` 대상. 푸시는 사용자 명시 승인 후에만.
- 계정 이메일·계정 ID·토큰이 로그·문서·캐시에 평문으로 남지 않는다.
  `sessionStorage`에는 자격증명성 데이터 금지 (기존 주석 규약 유지).

## 의존성 순서 work-phase 맵

효과 크기나 작업량이 아니라 **의존 관계**로 자른다. A 감사(블로커 4) 정정 후:
독립 트랙은 병렬 가능으로 명시하고, 선행은 실제 산출물 소비 관계가 있을 때만 둔다.

| WP | 문서 | 내용 | 선행 (소비하는 산출물) |
|----|------|------|----------------------|
| WP1 | 이 문서 + `000` + `001` | 리서치·근본원인·이슈 등록 (docs-only) | — |
| WP2 | `010_loading_contract.md` | 로딩 계약 + `useKeyedClientResource` 위 어댑터 + 카드/로더 프리미티브 export | WP1의 인벤토리 |
| WP3 | `020_page_migration.md` | 15개 표면을 WP2 계약으로 이관 | WP2의 계약 + export된 프리미티브 |
| WP4 | `030_revalidation_policy.md` | 재검증·폴링·요청 중복 제거 | WP3의 단일 진입점 (모든 표면이 한 곳을 지나야 조정 가능) |
| WP5 | `040_accounts_fanout.md` | `/accounts` 팬아웃 완화 + 관측성 | **WP1만.** WP2~WP4와 병렬 가능 — 서버 측이고 GUI 계약을 소비하지 않는다 |
| WP6 | `050_settings_card_unify.md` | 설정 카드/스위치 정렬 통일 | **WP1만 (확정).** WP2가 카드 프리미티브를 만들지 않기로 했으므로 병렬 가능 |
| WP7 | `060_multimodel_demotion.md` | 멀티모델 개별 설정 API/CLI 이관 | **자체 CLI/API 수용 매니페스트.** WP6의 스타일링에 의존하지 않는다 |

실제 소비 관계:

- WP2 → WP3: WP3은 WP2가 export한 계약 타입과 로더 컴포넌트를 import한다. 계약 없이
  15개를 이관하면 각자 다른 모양이 된다.
- WP3 → WP4: 중복 제거는 모든 페치가 한 진입점을 지난 뒤에만 한 곳에서 가능하다.
  이관 전에 중복 제거를 하면 15곳에 흩어진 특수 케이스가 된다.
- WP5는 병렬: `src/codex/auth-api.ts`의 WHAM 팬아웃은 GUI 계약과 무관하고,
  WP1의 측정치(`8s × ceil(n/4)`)만으로 착수 가능하다.
- WP6은 **병렬 확정**: `010_loading_contract.md`가 로더 프리미티브(skeleton/status)만 export하고
  카드/row 프리미티브는 만들지 않기로 결정했다. 따라서 WP6이 정본 카드 마크업을 직접 정의하며
  WP2를 기다리지 않는다. `050_settings_card_unify.md`에 두 갈래가 기록되어 있고
  이 문서가 그중 "WP2 로더 전용" 갈래를 확정한다.
- WP7은 WP6과 무관: 컨트롤 제거는 CLI 대체 경로 존재 여부에만 달려 있다.
  자체 수용 매니페스트(§WP7 수용 조건)로 닫는다.

### 대상 표면 매니페스트 (15개)

"모든 탭"의 정의. `app-routing.ts`의 `Page` 유니온 13개 + 중첩 하위 표면 2개.

| # | 표면 | 라우트 | 소유 파일 | 현재 데이터 진입점 |
|---|------|--------|-----------|-------------------|
| 1 | Dashboard | `#dashboard` | `pages/Dashboard.tsx` | `use-dashboard-data.ts` (keyed resource ×6) |
| 2 | Startup | `#startup` | `pages/Startup.tsx` | 자체 `refresh()` |
| 3 | Codex 인증 | `#codex-auth` | `pages/CodexAuth.tsx` | `loadMode()` + `useCodexAccountPool` |
| 4 | Providers | `#providers` | `pages/Providers.tsx` | `useProvidersFetch` + `useCodexAccountPool` |
| 5 | Models | `#models` | `pages/Models.tsx` | 자체 `load()` |
| 6 | Combos | `#combos` | `pages/Combos.tsx` | 자체 `fetchAll()` |
| 7 | Subagents | `#subagents` | `pages/Subagents.tsx` | 자체 `load()` |
| 8 | Logs | `#logs` | `pages/Logs.tsx` | 자체 `fetchLogs()` |
| 9 | Logs → Debug | `#logs/debug` | `pages/Debug.tsx` | keyed resource + 자체 로그 페치 |
| 10 | Usage | `#usage` | `pages/Usage.tsx` | 자체 `fetchUsage()` |
| 11 | Storage | `#storage` | `pages/Storage.tsx` | 리포트 + 정책 + 격리 3계통 |
| 12 | API | `#api` | `pages/ApiKeys.tsx` | 키 + 모델 2계통 |
| 13 | Claude → Code | `#claude` | `pages/ClaudeCode.tsx` | 자체 페치 |
| 14 | Claude → Desktop | `#claude` | `pages/ClaudeDesktop.tsx` | 자체 페치 + 5초 상태 폴 |
| 15 | Grok | `#grok` | `pages/Grok.tsx` | 자체 `load()` |

Dashboard의 해시 하위 뷰(`#dashboard/...`)는 같은 컨트롤러를 공유하므로 별도 표면으로
세지 않는다. WP3은 이 15행을 체크리스트로 쓰고, 각 행마다 커밋 1개 + 스크린샷 1장을 남긴다.

## 선행 결정 사항 (WP2 이전에 확정)

1. **서빙본 문제를 먼저 인정한다.** 사용자 화면은 `v2.7.43`이다. 어떤 수정도
   릴리스되지 않으면 사용자에게 도달하지 않는다. 각 WP의 검증은 로컬 `bun run build:gui`
   후 재기동한 서비스에서 수행하고, 릴리스 타이밍은 사용자 결정으로 남긴다.
2. **`client-resource.ts`를 버리지 않는다.** 실제 export는 `useClientResource`와
   `useKeyedClientResource`다. 타입 자체는
   `ResourceSnapshot<T> = { data: T | undefined; error: unknown; loading: boolean }`이고,
   두 훅의 **반환 타입**이 `ResourceSnapshot<T> & { refresh(opts?: { forceLoading?: boolean }): void }`다 —
   [client-resource.ts:3](/Users/jun/Developer/new/700_projects/opencodex/gui/src/client-resource.ts:3).
   `refresh`는 타입에 포함되지 않으므로 어댑터는 훅 반환값을 감싼다.
   WP2는 **새 리소스 계층을 만들지 않는다.** `useKeyedClientResource`를 그대로 쓰고,
   그 위에 로딩 UI 판정만 얹는 얇은 어댑터를 둔다. 어댑터 이름은 WP2의 P에서 확정하되,
   병행 추상화로 오해되지 않도록 `useKeyedClientResource`를 감싼다는 사실을 문서에 명시한다.
3. **0ms 타이머 마운트 페치를 폐기한다.** 15개 화면 중 13개가
   `setTimeout(() => void load(), 0)` 패턴이고, 마운트 직후 언마운트되면 요청이
   사라진다 — `000_research.md` §8. WP2의 진입점은 동기 구독으로 시작한다.
4. **빈 성공 응답을 hydrated로 취급하지 않는다.** `dev`의 현재 동작은 빈 목록을
   `ready`로 굳혀 이후 실패를 감춘다 — `000_research.md` §3. 계약은 "성공 1회 이상"과
   "마지막 시도 성공"을 분리해 추적한다.

## 각 WP의 검증 방식

| WP | 검증자 | 통과 기준 |
|----|--------|-----------|
| WP1 | 문서 + `gh issue view <번호> --json url,state,title` | 이슈 번호를 이 문서 §WP1 결과에 기록하고 그 번호로 조회해 `state=OPEN` 확인 |
| WP2 | `bun run typecheck`, `bun run test`, 신규 계약 테스트 | 계약 테스트 green |
| WP3 | 표면별 렌더 테스트 + 브라우저 스크린샷 15장 (매니페스트 15행 전부) | 각 표면 첫 로드에 로딩 표시 관측 |
| WP4 | CDP 요청 카운트 재측정 (아래 요청 원장 기준) | 원장의 콜드/웜/수동 목표를 각각 충족하고 보존 트리거 6종이 모두 발화 |
| WP5 | `/accounts` 콜드/웜 지연 재측정 | 웜 경로 10ms 이하 유지, 콜드 팬아웃 상한 문서화 |
| WP6 | 스크린샷 대조 (카드 패딩·스위치 중심선) | 중심선 오차 0px |
| WP7 | 수용 매니페스트 + `bun run test` + docs-site 갱신 | 제거 대상 컨트롤마다 CLI/API 대체가 실제 실행 확인되고 문서화됨 |

측정은 전부 `001_live_evidence.md`와 동일한 방법(CDP `Network` + DOM 샘플링)으로
재현해 전후를 비교한다. 스크린샷은 C4 단계에서 devlog에 보존한다.

### WP4 요청 원장 (A 감사 블로커 2 대응)

`38 → 15`는 근거 없는 목표였다. 8중복 제거는 7개만 줄여 31이 남는다. 시나리오별로
분리한 원장을 목표로 삼는다. 각 칸의 현재 값은 WP4의 P에서 재측정해 채운다.

| 시나리오 | 현재(측정 예정) | 목표 | 허용된 감축 수단 |
|---|---|---|---|
| `#providers` 콜드 마운트 (캐시 없음) | 38 (E3 실측) | ≤ 25 | `/api/provider-quotas` 인플라이트 공유(8→1, −7), `&quota=1` 계정 재조회 6건을 기본 계정 조회에 통합(−6) |
| `#providers` 웜 재방문 (세션 캐시 유효) | 미측정 | ≤ 8 | 캐시 시드 후 배경 재검증 1회 |
| 명시적 새로고침 버튼 | 미측정 | 변경 없음 | 감축 금지 — 강제 경로는 항상 원본 수를 보낸다 |
| OAuth 계정 전환 후 | 미측정 | 변경 없음 | 감축 금지 |
| 로그인/로그아웃 후 | 미측정 | 변경 없음 | 감축 금지 |
| config 저장 후 | 미측정 | 변경 없음 | 감축 금지 |

콜드 목표 산술 (E3의 38 기준):

```
38
 −7   /api/provider-quotas 8회 → 1회 (인플라이트 공유)
 −6   /api/oauth/accounts?provider=…&quota=1  6건을 기본 조회에 통합
 ────
 25
```

`≤ 25`가 이 두 수단으로 도달 가능한 하한이다. 목표를 더 내리려면 **E3 목록의 다른 요청을
구체적으로 지목하고**, 그 요청이 담당하는 표시·갱신이 보존됨을 증명해야 한다.
E3에는 위 두 그룹 외에도 `/api/oauth/status` 7건, `/api/providers/keys` 3건,
`/api/usage?range=30d`, `/api/selected-models`, 그리고 `/api/codex-auth/accounts` ·
`/api/codex-auth/active` 중복 각 1건이 있다. 어느 것이 안전하게 줄일 수 있는지는
아직 증명되지 않았다 — 예를 들어 `/api/oauth/status`를 지연하면 프로바이더 상태 표시가
늦어지고, `/api/providers/keys`를 통합하면 키 존재 표시가 늦어진다. 이들은 후보 예시일
뿐이며 배타적 목록이 아니다. WP4의 P에서 대상 요청과 보존 테스트를 명명한 뒤에만
목표를 내린다.

감축은 **콜드·웜 마운트 경로에만** 적용한다. 아래 6개 보존 트리거는 요청 수를 줄이지
않으며, WP4의 C에서 각각 발화 증거를 남긴다.

| 보존 트리거 | 발화 방법 | 관측 증거 |
|---|---|---|
| 계정 전환 후 쿼터 갱신 | 프로바이더 계정 전환 | 전환 후 `/api/provider-quotas` 1회 발생 기록 |
| 계정 추가/삭제 후 갱신 | 계정 mutation | mutation 응답 후 재조회 발생 |
| 수동 새로고침 | 새로고침 버튼 | `?refresh=1` 도달 확인 |
| 캐시 무효화 후 | `sessionStorage` 해당 키 삭제 | 다음 마운트에서 콜드 경로 진입 |
| 동시 마운트 | 두 표면이 같은 키를 동시 구독 | 요청 1회 + 팔로워가 같은 결과 수신 |
| 인플라이트 팔로워 | 진행 중 요청에 두 번째 구독자 합류 | 네트워크 요청 수 증가 없음 + 양쪽 데이터 도착 |

`quotaRefreshKey`가 프로바이더별 응답마다 바뀌어 이펙트를 재실행하는 구조가 8중복의
원인이다 — [Providers.tsx:129](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:129),
[ProviderWorkspaceShell.tsx:242](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx:242).
키를 안정화하면 위 보존 트리거 중 "계정 전환 후 갱신"이 함께 죽을 위험이 있다.
그래서 키 안정화와 명시적 무효화 호출을 **같은 커밋에서** 짝지어야 한다.

### WP7 수용 매니페스트

컨트롤 제거 전에 각 항목의 CLI/API 대체를 실제로 실행해 확인하고 그 출력을 기록한다.
A 감사에서 존재가 확인된 대체 경로: 노출 토글, 프로바이더 일괄 on/off, selected-models,
커스텀 모델 CRUD, 컨텍스트 캡. 확인 전에는 어떤 컨트롤도 제거하지 않는다.
제거 목록은 사용자 확인을 받은 뒤에 확정한다 (기능 축소는 사용자 결정 사항).

## 조건부 경로 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

계획이 추가하는 분기마다 C에서 어떻게 발화시키고 무엇으로 확인하는지 미리 적는다.

| 분기 | 발화 방법 | 관측 증거 |
|------|-----------|-----------|
| 콜드 마운트 로딩 표시 | `sessionStorage.clear()` + 모듈 캐시 없는 첫 마운트 | 로딩 노드 존재 스냅샷 |
| 배경 재검증 중 stale 유지 | 두 번째 마운트에서 응답 지연 주입 | 기존 행 유지 + `aria-busy` |
| 성공 후 실패 (에러 표시) | 두 번째 요청만 500 반환 | 에러 + 재시도 버튼 렌더 |
| 빈 성공 응답 | 빈 배열 응답 | 빈 상태 문구, 로딩 아님 |
| 세션 만료 401 → 재부트스트랩 | 세션 무효화 후 요청 | 재시도 성공, 프롬프트 없음 |
| 탭 전환 중 언마운트 | 마운트 즉시 라우트 변경 | 요청 발생 기록 (0ms 타이머 폐기 증명) |

WP4가 추가하는 분기는 위 §WP4 요청 원장의 "보존 트리거" 표 6행이 담당한다.
WP5가 추가하는 분기:

| 분기 | 발화 방법 | 관측 증거 |
|------|-----------|-----------|
| `/accounts` 동시 요청 병합 | 두 요청을 동시에 발사 | 상류 WHAM 호출 1세트만 발생 |
| stale-while-revalidate | 캐시 만료 직후 요청 | 즉시 캐시 응답 + 배경 갱신 로그 |
| 상류 실패 시 캐시 폴백 | WHAM 실패 주입 | 목록은 200, 쿼터는 캐시값 |

"모든 테스트 통과"는 이 표의 증거를 대체하지 못한다.

## 리스크

- **WP3 광범위 이관**: 15개 화면을 건드리므로 회귀 표면이 넓다. 화면 단위로 커밋하고
  각 커밋마다 해당 페이지 테스트를 돌린다.
- **WP4가 요청을 과도하게 줄일 위험**: 중복 제거가 실제로 필요한 갱신까지 죽이면
  "데이터가 안 갱신된다"는 반대 증상이 생긴다. 재검증 정책은 명시적 트리거 목록으로
  적고, 각 트리거에 테스트를 붙인다.
- **WP7 기능 제거**: 사용자가 GUI에서 쓰던 컨트롤이 사라진다. 제거 전에 CLI 대체
  명령을 docs-site에 먼저 문서화하고, 제거 목록을 사용자에게 확인받는다.

## WP1 결과

등록된 이슈: **#753** — https://github.com/lidge-jun/opencodex/issues/753
제목: `GUI tabs show no loading state on switch; providers tab issues 38 requests per switch`

검증:

```
$ gh issue view 753 --repo lidge-jun/opencodex --json url,state,title,number
{"number":753,"state":"OPEN","title":"GUI tabs show no loading state on switch; providers tab issues 38 requests per switch","url":"https://github.com/lidge-jun/opencodex/issues/753"}
```

A 감사 이력 (동일 리뷰어 3라운드, gpt-5.6-terra / priority):

| 라운드 | 판정 | 접어 넣은 내용 |
|--------|------|----------------|
| R1 | FAIL (6 블로커) | 폴링 인과 과장 철회, 38→15 근거 부재, WP4 활성화 증거 누락, 효과 기반 순서, WP1 종료 불가, 표면 정의 부재 + 팬텀 `useDataResource` |
| R2 | FAIL (3 블로커) | E6 문단의 폴링 주장 재발, ≤24 산술 오류(정답 25), `ResourceSnapshot` 타입 서술 부정확 |
| R3 | GO-WITH-FIXES (2 Medium) | E9의 실패·세션만료 언급 제거, 콜드 목표 하한 주장을 예시 목록으로 완화 |

R3의 2건은 B 단계에서 모두 반영했다. 리뷰어가 릴리스본 코드로 확인해 준 사실:
실패한 로드는 `setAccounts`를 호출하지 않으므로 채워진 행이 유지되고 에러 배너가
그 위에 붙는다. E3에는 `/api/provider-quotas` 정확히 8건, `&quota=1` 정확히 6건이 있다.

## 현재 상태

WP1 완료 (문서 3건 + 이슈 #753). WP2~WP7의 decade 문서는 `010`~`060`으로 작성한다
(DIFFLEVEL-ROADMAP-01). 각 구현 WP는 자신의 P에서 해당 decade 문서를 현재 트리와
대조해 stale 여부를 확인하고 수정한 뒤 실행한다.

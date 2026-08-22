# 구현 진행 기록

유닛 `260730_gui_hydration_loading_unify`. 이슈 #753.
각 WP는 완전한 PABCD 사이클 하나이며, 종료 시 로컬 커밋 하나를 남긴다.

## 사용자 정정 (2026-07-30)

최초 리서치는 탭 전환 시 82ms 빈 창에 초점을 맞췄다. 사용자가 정정했다.

> "지금 불러와지는건 정상이고 그 전역설치본도 지금 그게 너무느리게 로딩된다고
> 그래서 스피너를 도입하자는거고"

즉 기능 결함이 아니라 **느린 대기 구간이 보이지 않는 것**이 문제다. 실측
`?refresh=1` 908ms, 서버 콜드 경로 `8s × ceil(계정수/4)`. 이 정정이 WP2의 범위를
바꿨다 — 어댑터·프리미티브만으로는 계정 목록에 아무 변화가 없기 때문에
`useCodexAccountPool`까지 WP2에 포함됐다.

## WP2 — 로딩 계약 기반 (완료)

커밋 `ba3a29d32`. A 감사 5라운드(FAIL 4회 → PASS).

감사가 잡아낸 설계 결함과 반영:

| # | 결함 | 반영 |
|---|------|------|
| 1 | 어댑터만 추가하면 계정 목록에 변화 없음 (다른 훅이 소유) | `useCodexAccountPool`을 WP2 범위에 포함 |
| 2 | `loading-with-stale-data`가 죽은 코드 — 스토어가 데이터 있으면 `loading`을 안 올림 | 스토어에 `refreshing` 추가 |
| 3 | `enabled: false`가 영구 스켈레톤 | `disabled` 상태 추가 |
| 4 | `throw undefined` 판별 불가 | 스토어 경계에서 정규화 |
| 5 | `attemptsRef`를 렌더에서 읽음 | 메커니즘 폐기, `hasSucceeded`/`lastAttemptOk`를 스냅샷으로 |
| 6 | 라이브 리전 이중 알림 | `live` prop + 오류 배너 소유권 규칙 |
| 7 | 콜드 재시도가 정지 화면 | `retrying-cold` 추가, 인플라이트를 실패보다 우선 평가 |
| 8 | 계정 풀 `refreshing`이 겹친 요청에서 조기 해제 | 인플라이트 카운터 |
| 9 | `try/finally`가 `beginActiveRead()` throw 미포함 | `try`를 카운터 증가 직후로 |
| 10 | 점진 페인트 회귀 (`accountsOk && activeOk`로 바꿨던 것) | 원형 분기 보존 |

### 변경 파일

- `gui/src/client-resource.ts` — `refreshing` / `hasSucceeded` / `lastAttemptOk`.
  `loading`의 기존 의미("콘텐츠를 대체해도 됨")는 불변.
- `gui/src/data-surface.ts` (신규) — 8상태 분류 + `useDataSurface` 순수 어댑터.
- `gui/src/components/data-surface.tsx` (신규) — 스켈레톤·상태줄 프리미티브.
- `gui/src/styles.css` — 규칙 3개. `.spin`과 기존 shimmer 재사용, 신규 토큰 0개.
- `gui/src/hooks/useCodexAccountPool.ts` — 인플라이트 카운터 + `firstAttemptSettled`,
  컨트롤러에 `refreshing` / `initialLoading` 노출.
- `gui/src/components/CodexAccountPool.tsx` — 재검증 중 상태줄.
- 테스트 3파일 (신규 9건 + 추가 2건 + 계약 목록 2필드).

### 검증

```
bun run typecheck                 exit 0
(cd gui && bun run build)         tsc -b && vite build 성공
(cd gui && bun test tests)        410 pass / 0 fail / 1847 expect / 84 files
bun run lint:gui                  무경고
bun run privacy:scan              passed
```

활성화 증거 (도그푸딩 인스턴스, 포트 10199, 로컬 dev 빌드):

| 경로 | 관측 |
|------|------|
| 강제 새로고침 클릭 | 139–669ms 동안 `.data-surface-status` + `.spin` + `aria-busy=true`, 계정 행 유지, 800ms 해제 |
| 조용한 30초 폴링 (클릭 없음) | 지연 에뮬레이션(1200ms) 하에 18293ms 시점 `status=true spin=true busy=true`, 행 유지 |
| 겹친 요청 | 일반 load가 먼저 해제돼도 `refreshing` 유지, 강제 해제 후 false |
| 콜드 실패 | `initialLoading=false`, `loadState=error` — 무한 스켈레톤 없음 |

스크린샷: `.tmp/dogfood/shots/refresh-spinner.png` (추적 안 되는 스크래치 경로).

### 도그푸딩 셋업

처음에는 사용자의 상시 프록시(포트 10100)를 건드리지 않고 별도 인스턴스로 검증했다.

```bash
OPENCODEX_HOME=<repo>/.tmp/dogfood bun run src/cli/index.ts start --port 10199
```

`findGuiDist()`가 소스 위치 기준으로 dist를 찾으므로 이 인스턴스는 방금 빌드한
`gui/dist`를 서빙한다.

**이후 사용자 요청으로 전역 `ocx`를 로컬 트리 symlink로 전환했다.** 이제 포트 10100의
상시 서비스도 로컬 코드를 실행한다.

```bash
# 기존 npm 설치본을 보존
mv ~/.bun/install/global/node_modules/@bitkyc08/opencodex \
   ~/.bun/install/global/node_modules/@bitkyc08/opencodex.npm-2.7.43.bak

# 로컬 트리로 링크
ln -s /Users/jun/Developer/new/700_projects/opencodex \
      ~/.bun/install/global/node_modules/@bitkyc08/opencodex

ocx service stop && ocx service start
```

`~/.bun/bin/ocx`는 원래부터 그 패키지 경로를 가리키는 symlink이고 launchd plist도
`<pkg>/src/cli/index.ts`를 실행하므로, 패키지 디렉터리 하나만 바꾸면 CLI·서비스·GUI가
모두 로컬 소스를 쓴다. 되돌리려면 링크를 지우고 `.npm-2.7.43.bak`을 제자리로 옮긴다.

검증: `readlink -f ~/.bun/bin/ocx` → 로컬 `bin/ocx.mjs`,
`curl -s http://127.0.0.1:10100/ | rg -o 'assets/[^"]+'`가 로컬 `gui/dist` 해시와 일치,
서빙 중인 CSS에 `.data-surface-status` 규칙 존재.

## WP3 — 15표면 이관 (진행 중, 12/15)

`020_page_migration.md` 소비. 커밋 3개.

| 커밋 | 표면 |
|------|------|
| `a9903875d` | Grok (기준 구현) + `page-loading-contract.test.tsx` 신설 |
| `1b6dae373` | Subagents, Combos, Usage, Startup, Logs, Debug, Claude Code/Desktop |
| `8759e34de` | Storage, API, Models + 0ms 타이머 6곳 제거 |

계약 테스트가 12표면을 고정한다. 남은 3개는 Dashboard, Providers, Codex 인증인데,
세 곳 모두 이미 공용 리소스 계층이나 전용 컨트롤러를 쓰고 스켈레톤도 갖고 있어
어댑터로 감싸는 이득이 작다. Providers와 Codex 인증은 이번 커밋에서 0ms 타이머만
제거했다. 남은 판단은 WP3의 마지막 사이클에서 한다.

### 이번 사이클에서 드러난 것

- **0ms 타이머가 lint 규칙의 회피책이었다.** `react-hooks/set-state-in-effect`가 이펙트
  본문의 동기 setState를 막으므로 원저자가 타이머로 미뤘고, 그 타이머가 cleanup에서
  취소되면서 요청이 사라졌다. 마이크로태스크가 양쪽을 만족한다.
- **키가 바뀌는 재구독이 요청을 두 번 보냈다.** 새 키 구독의 콜드 페치와 deps 변경의
  강제 재검증이 겹쳤다. `useKeyedClientResource`에서 키가 함께 바뀐 경우를 건너뛰게 했다.
  WP4의 요청 감축에 그대로 기여한다.
- **모듈 캐시가 테스트 격리를 깬다.** 리소스 캐시가 모듈 레벨이라 앞선 케이스의 응답이
  다음 케이스의 콜드 마운트를 만족시켰다. 6개 테스트 파일에
  `clearClientResourceStoresForTests()`를 넣었다.

### 감사에서 걸린 것 (4건, 전부 수정됨)

소스 문자열을 검사하는 계약 테스트는 표면이 어댑터를 쓰는지까지만 본다. 마운트해서
돌려보면 런타임 결함이 따로 나왔다.

| 심각도 | 결함 | 원인 | 수정 |
|--------|------|------|------|
| High | Grok의 저장이 방금 켠 스위치를 되돌렸다 | draft를 비우면 이전 스냅샷으로 폴백 | 확정된 선택을 `setClientResourceData`로 먼저 발행한 뒤 draft 해제 |
| High | 로그가 지속 장애를 영구히 숨겼다 | 한 번 성공하면 이후 실패를 침묵 처리 | 연속 3회 실패 시 상시 notice + 재시도, 성공하면 해제 |
| Medium | API 키 화면에 live region이 두 개 | 키·모델이 동시에 재검증 | 키가 말하는 동안 모델 상태가 양보 |
| Medium | StrictMode에서 요청이 두 번 | 마이크로태스크는 취소되지 않는다 | 4곳에 identity 가드 |

회귀 테스트 4개를 붙였다: 저장만 했을 때 스위치가 유지되는지, 3회 실패 후 stale 고지가
뜨고 성공하면 사라지는지, stale 프로브가 빠른 재조회를 요청하는지(단위 + 계약).

### 원래 증상의 진짜 원인

"할당량 새로고침을 눌러야 로딩된다"의 기전을 B 단계에서 찾았다. `/api/startup-health`는
30초 캐시에서 즉시 답하고 실제 프로브는 백그라운드에서 푼다. 그래서 콜드 응답은 보수적인
임시값인데, 대시보드는 status만 꺼내 쓰고 "아직 확정 전"이라는 사실을 버렸다. 다음 30초
틱까지 임시값이 그대로 남았고, 그 사이 칩을 리마운트시키는 아무 동작(새로고침 클릭, 탭
이동)이 진짜 값을 불러오는 것처럼 보였다.

프로브가 `stale`을 함께 실어 보내고, 대시보드는 서버가 아직 작업 중이라고 말하는 동안
약 2초 뒤 다시 묻는다. stale 응답은 확정값처럼 캐시하지 않는다. 하드 에러는 일반 폴에
맡긴다 — 2초 안에 스스로 낫지 않으니 빠른 재조회는 죽은 엔드포인트를 두드리는 셈이다.

### 카탈로그 enum 사고 (#759)

WP3 중에 로컬 symlink 본이 `~/.codex/opencodex-catalog.json`을 쓰면서 zenmux 모델에
`input_modalities: [..., "video"]`를 넣었다. Codex는 이 필드를 `text|image|audio` 닫힌
enum으로 파싱하므로 **카탈로그 전체**를 거부했고, Codex 앱은 플러그인·앱·MCP가 0개인
"Unable to load apps" 상태가 됐다. 모델 하나의 메타데이터가 전부를 내린 것이다.

프로바이더 필터에서 `"video"`를 빼고, 모든 엔트리가 지나는 단일 지점
(`ensureStrictCatalogFields`)에서 enum으로 정규화한다. 남는 게 없으면 `["text"]`로
떨어뜨린다 — modality가 아예 없는 엔트리는 text-only보다 나쁘다. 사용자 카탈로그는
제자리 복구했다(백업 `~/.codex/opencodex-catalog.json.bak-video-repair`).

내부적으로 `"video"`는 정당하다: xAI 비디오 브리지(`images.videoBridgeEnabled`)와
vision-sidecar modality 배관이 비디오를 다룬다. 결함은 그 값이 Codex가 읽는 카탈로그
파일로 새어 나가는 것뿐이라, `catalog-vision-sidecar-modalities.test.ts`의 내부 비디오
추론은 그대로 둔다(12 pass).

### 게이트 (커밋된 트리 기준)

`bun run typecheck` clean, `gui lint` 0 error, `privacy:scan` passed,
`gui build` clean, GUI 스위트 418 pass.

GUI 스위트의 1 fail은 이 작업이 아니다. 다른 세션이 워크트리에서
`dash.syncCodexSubagentDefaultsHint` 문구를 고쳤고 단정문이 옛 문구를 기대한다.
`HEAD:gui/src/i18n/en.ts`에는 단정된 문구가 그대로 있다.

루트 `bun run test`는 완주 시간을 못 재고 남겼다. 다른 세션들의 루트 스위트가 동시에
네 개 돌고 있었고, `scripts/test.ts`가 바로 이 경합을 문서화한다(약 210초 런이 26분).
이번 사이클의 `src/` 변경은 `catalog-input-modality-enum.test.ts`(5 pass)와
`catalog-vision-sidecar-modalities.test.ts`(12 pass)를 직접 돌려 덮었다.

### 병행 세션과의 파일 공유

`gui/src/pages/use-dashboard-data.ts`가 두 세션의 변경을 동시에 담게 됐다. 스테이징을
파일 단위로 쪼개(내 hunk만 blob으로 만들어 `update-index`) 커밋 후보 트리가 단독으로
`tsc -b`를 통과하는지 확인했다. 그 사이 다른 세션이 PR 5건을 머지하면서 내 워크트리
변경까지 `91fc79c93`에 함께 커밋했다. 결과물은 HEAD에 온전히 들어갔고 게이트도
초록이라, 커밋 경계만 의도와 다르다.

## WP4 — 재검증/폴링 (진행 중)

`030_revalidation_policy.md` 소비. 감사에서 FAIL 4건이 나와 계획을 고쳐 쓴 내용은 그
문서의 "감사 반영" 절에 있다. 요약: `-6` (`&quota=1` 통합)은 **취소**했고, `38→25`
수치는 CDP 재측정 전까지 목표에서 뺐다.

### 착지한 것: hidden 탭 폴링 중단 (`e694c92c0`)

공용 리소스 store가 `document.visibilityState === "hidden"`이면 tick을 건너뛰고, 탭이
돌아올 때 한 번 조용히 재검증한다. 남은 간격을 기다리지 않고 놓친 tick을 만회한다.

옵션은 **subscriber 단위**다. 고정 key는 여러 consumer가 공유할 수 있고, 나중에 구독한
일시정지 consumer 때문에 다른 쪽의 opt-out이 사라지면 안 된다. hidden tick에서는
opt-out한 subscriber가 하나라도 있으면 실행하고, 없으면 건너뛴다.

이 옵션이 필요한 이유가 재시작 재접속 폴이다. 그것 자체가 `pollMs: 1500` 키드 리소스이고
([use-dashboard-data.ts](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/use-dashboard-data.ts)),
사용자가 다른 곳을 보는 동안 서버가 돌아오는 것을 알아채는 게 존재 이유다. hidden에서
멈추면 유일한 사용 사례가 깨지므로 `pauseWhenHidden: false`를 준다.

`visibilitychange` 리스너는 polling store마다 하나만 달고 폴이 멈추거나 store가 evict될
때 떼어낸다(evict된 key마다 핸들러가 새는 것 방지). 재검증은 `replaceInflight: false`라
visible 복귀 직후 마운트가 시작한 요청을 취소하지 않는다.

테스트 3건: hidden에서 멈추고 복귀 시 1회, opt-out은 hidden에서도 계속, 공유 key에서
opt-out 하나가 store의 hidden tick을 살린다.

## 탭 레이아웃 되돌리기 (사용자 요청, `c63d1336b` + `5a40dde28`)

WP4와 별개로 들어온 요청. 세 탭이 고정 높이 2분할 워크스페이스로 재구성되어 있었고,
분할된 pane이 스크롤을 소유했다. Usage는 선택된 섹션만 렌더해서 스크롤로 리포트를 읽는
것이 **아예** 불가능했다 — 휠이 `overscroll-behavior: contain`인 내부 컨테이너에 갇혀
아래 페이지가 움직이지 않았다.

| 탭 | 전 | 후 |
|----|----|----|
| Usage | 좌측 rail + 선택된 섹션 하나만 렌더 | 전 섹션이 문서에 남고, 고정된 밑줄 탭이 해당 위치로 스크롤 |
| Storage | 고정 높이 2분할 + pane마다 내부 스크롤러 | 페이지 스크롤. 버킷 목록만 sticky + 자체 짧은 스크롤 |
| Storage 정리 카드 | policy \| manual 좌우 분할, segmented pill 탭 | 전체 너비, 공용 밑줄 탭으로 전환 |
| Subagents | rail + main. 추천 목록이 **두 번** 렌더 | v1 형태로 복귀: 추천(순서변경+저장) → 피커 |

Usage의 활성 탭은 `IntersectionObserver`로 스크롤 위치를 따라간다. 마지막으로 클릭한
곳이 아니라 지금 읽고 있는 곳을 가리킨다. `scroll-margin-top`으로 착지한 제목이 고정
스트립에 가리지 않게 한다.

Subagents의 중복은 실제 결함이었다. rail이 추천 모델을 한 번, main pane이 같은 목록을
순서변경 컨트롤과 함께 또 한 번 그렸다. 두 개의 뷰라기보다 렌더링 버그로 읽혔고, 모델별
상세 pane은 행이 이미 보여주는 것 외의 정보가 없었다.

검증(로컬 symlink 본, 재빌드·재기동 후 CDP): Usage 5495px 스크롤·탭 4개·앵커 4개,
Providers 탭 클릭 시 4330으로 스크롤하며 스트립은 top 0에 고정되고 제목은 56에 착지,
Storage 1609px 스크롤·버킷 7개·rail이 top −2에 고정. 게이트 4종 green, GUI 422 pass.

사용량 테이블의 높이 제한(`.usage-scroll`, 360px)도 같이 걷어냈다(`a6aa981fa`). 모델 82행이
카드 안 스크롤바 뒤에 숨어 있었다. 대신 sticky 테이블 헤더를 넣으려다 뺐는데, `.tbl-wrap`이
넓은 테이블 때문에 `overflow-x: auto`를 유지해야 하고 그러면 그 wrap이 sticky `th`의
컨테이닝 블록이 되어 offset과 무관하게 wrap 자기 top에 붙는다(실측 −882로 밀려남).

### WP4 실측: 파생 키가 quota를 6번 읽고 있었다 (`a149b8fb2`)

계획의 인과 설명은 틀렸지만(감사 B1) **중복 자체는 실재했다**. 재측정으로 기전을 특정했다.

CDP 초기자 추적 결과 cold `#providers`에서 `/api/provider-quotas`가 15ms 안에 6번,
전부 같은 호출 지점에서 나갔다. 타임라인이 원인을 그대로 보여준다.

```
+ 0ms  oauth/accounts?provider=anthropic … kiro (6개 동시)
+ 1ms  provider-quotas          ← 최초 1회
+10ms  accounts?…&quota=1 (3개)
+11ms  provider-quotas          ← 응답 도착마다 재실행
+13ms  provider-quotas
+15ms  provider-quotas, provider-quotas
```

`quotaRefreshKey`는 `provider:activeAccountId`를 정렬해 이어붙인 문자열이라 안정적으로
보이지만, cold load에서는 provider별 응답이 **각자 자기 활성 id를 채우기 때문에** 그
문자열이 provider 수만큼 바뀐다. 셸의 quota effect가 그 값을 의존성으로 두고 있었다.

monotonic revision(`{epoch, force}`)으로 교체했다. 카운터는 실제로 quota를 무효화하는
일이 있을 때만 움직이므로 계정 도착은 조용하고, 기존 `fetchProviderQuotas(true)` 12곳은
그대로 동작한다(이제 fetch 대신 revision을 올린다). 부수 효과로 mutation이 셸의 자체
fetch와 같은 데이터를 두고 경쟁하지 않는다.

**강제 갱신이 이제 실제로 와이어에 도달한다.** 기존 effect는 항상 캐시된 뷰를 읽어서
`fetchProviderQuotas(true)`를 불러도 서버 TTL이 들고 있던 값을 받았다. force bump일 때
`?refresh=1`을 붙인다.

| 지표 | 전 (3회 median) | 후 (3회) |
|------|------|------|
| cold `#providers` 총 요청 | 36 (33/36/37로 흔들림) | **31** (31/31/31) |
| cold `/api/provider-quotas` | 6 | **1** |
| warm revisit | 32 | 31 |

감축 목표를 다시 쓴다. 원안의 `38 → 25`는 근거가 틀렸으므로 폐기하고, 실측 기준
**36 → 31**을 기록한다. 남은 30개는 `/oauth/status` 7, `oauth/accounts` 6 + `&quota=1` 6,
`providers/keys` 3, usage 2, codex-auth 2, config·presets·selected-models 각 1이다.
`&quota=1` 6개는 점진 페인트를 지키기 위해 의도적으로 남겼다(감사 B2) — 서버측 감축은 WP5다.

테스트는 소스 문자열이 아니라 행동을 고정한다. 회귀를 실제로 잡는지 확인하려고 파생 churn을
임시 prop으로 되살려봤고, cold-read 케이스가 1 기대에 2로 **실패**했다. 값싼 계정 read가
quota enrichment보다 먼저 나가는 것도 함께 고정한다(취소한 `&quota=1` 통합이 없앴을 동작).

## WP6 — 설정 카드/스위치 정렬 (`c66aea6f9`)

사용자 스크린샷의 두 지적을 처리했다. 둘 다 겉모습이 아니라 구조 문제였다.

### 스위치는 높이가 틀린 게 아니었다

행이 20px 토글과 ~35.5px 숫자 compound를 **bottom 정렬**하고 있었다. 그래서 중심선이 6px
어긋났고, 그게 "높이가 안 맞는다"로 보였다. 토글을 필드 높이에 맞춘 slot에 넣어 해결했다.
컨테이너를 center로 뒤집지 않은 이유는 모바일 breakpoint가 bottom 정렬을 의도적으로 유지하고,
center로 바꾸면 label과 feedback 텍스트까지 같이 끌려가기 때문이다.

측정을 세 번 갈아가며 확인했다.

| 시도 | 중심선 차이 |
|------|------------|
| 원래 (직접 bottom 정렬) | 6px |
| 32px slot | −1.77px |
| `align-self: stretch` | **+11px** (더 나빠짐) |
| 필드 높이에 맞춘 36px slot | **0.23px** |

`stretch`가 악화된 이유가 핵심이다. 임계값은 label이 필드 위에 쌓인 구조라서 slot이 열 전체로
늘어나면 토글이 **label까지 포함한 중심**에 맞는다. 리뷰어가 경고한 함정이 정확히 이거였다.
slot은 `{enabled}` 바깥에 렌더해서 임계값 필드가 사라져도 토글이 튀지 않는다.

### 로테이션 전략은 이름 없는 선택기였다

카드 제목 → 설명 → sr-only label이 붙은 전폭 select 순서였다. 화면에는 이름 없는 picker만
남았다. canonical setting row로 바꿨다: 필드 이름과 설명이 왼쪽, 컨트롤이 오른쪽.

**두 설명을 모두 유지한 것이 이 WP의 blocker였다.** 원안은 `.desc` 하나만 두고 "다르면 하나를
고르라"고 했는데, `strategyDesc`("새 세션이 계정을 고르는 방식")와 `strategyHint`("기존 스레드는
어피니티 유지")는 서로 다른 질문에 답한다. 하나를 버리면 "지금 열린 스레드도 바뀌나?"에 화면이
답하지 못한다. 사용자 스크린샷에도 두 줄이 같이 있었다.

공용 컴포넌트를 한 번만 바꿨으므로 Codex와 Anthropic 카드가 다시 갈라지지 않는다. Anthropic
쪽은 풀이 비활성이면 컨트롤 자체가 렌더되지 않아 라이브로 볼 수 없다 — 그래서 마운트 테스트로
두 desc 줄을 단정한다(리뷰어 요구사항).

### 범위를 좁힌 이유

`.setting-row`는 JSX 사용처가 8곳이고 전부 Claude 설정 페이지다. 좋은 기준 구현이지만 앱 전역
전환의 근거는 아니라, 원안의 광범위 전환 표를 취소하고 account-pool + auto-switch로 한정했다.
나머지 설정 페이지는 그대로 둔다.

### 패딩 지적에 대해

카드가 테두리에 붙어 보인 건 **릴리스 지연**이다. 사용자는 npm 전역 v2.7.43을 보고 있고 그
서빙 CSS에는 `.account-pool-strategy-card` 규칙이 없다. dev에는 이미 inset이 있어서
([styles.css:1385](/Users/jun/Developer/new/700_projects/opencodex/gui/src/styles.css:1385))
소스 패치로는 그 화면이 바뀌지 않는다. 릴리스가 나가야 한다.

게이트 4종 green, GUI 427 pass (86 파일).

## WP8 — 카탈로그 enum 경계 (#759, `dc76c0ffe`)

`070_catalog_enum_hardening.md` 소비. 감사에서 blocker 3건이 나왔고 **그중 하나는 내 주장이
틀린 것이었다.** 문서에 전부 기록했다.

### 내가 틀렸던 것

"백업 복원 명령이 오염된 값을 다시 쓴다"고 썼는데 거짓이다. `writePristineCatalogBackup`은
**routed 엔트리가 있는 카탈로그를 백업하지 않는다**
([parsing.ts:428](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/parsing.ts:428)).
`zenmux/...`는 routed라서 오염된 행이 애초에 백업에 못 들어간다. 복구 경로 서사를 폐기했다.

### 범위를 좁힌 이유

원안은 "Codex가 enum으로 읽는 다른 필드 전수 확인"과 "읽기 시 제자리 복구"를 포함했다. 둘 다 뺐다.

읽기 복구는 위험하다. `readCatalog`가 pristine 백업과 `models_cache.json`도 읽으므로, 거기에 쓰기를
넣으면 **들여다보기만 해도 복구 증거와 사용자 파일이 변형된다.** 게다가 opencodex 명령이 돌기
전까지 Codex 앱을 고쳐주지도 못한다. `ocx sync`가 명시적 복구 경로다.

전수 sanitizer는 잘못 만들면 정당한 값을 깨뜨린다. 놓친 닫힌 enum이 실제로 더 있었지만
(`visibility`, `shell_type`, `web_search_tool_type`), 결정적인 건 `truncation_policy.mode`가
업스트림 스냅샷에 **`bytes`와 `tokens` 둘 다** 정당하게 있다는 점이다. `"tokens"`로 하드코딩하는
sanitizer는 유효한 엔트리를 손상시킨다. 그 네 필드는 프로바이더 데이터가 도달하지 않으므로
(쓰기 지점이 `parsing.ts` 밖에 없고 값은 하드코딩) 실제 위험이 아니다.

### 실질 산출물

착지한 두 수정은 **엔트리 생성**을 봉합한다. 빠진 계약은 **이미 디스크에 있는 오염된 행**이다.
프로바이더가 없으면 sync가 stale routed 행을 의도적으로 보존하므로, 그 행이 다시 읽히고 병합되어
다시 쓰인다 — 나가는 길에 고쳐지지 않으면 같은 거부가 반복된다.

테스트가 단정하는 것은 **모델이 살아남는 것**이다. "출력에 video가 없다"만 보면 미래의 sync가
오염된 행을 정규화 대신 **버려도** 통과한다. 프로바이더 모델이 조용히 사라지는 걸 성공으로 읽는
셈이다. 그래서 슬러그 존재 + modalities가 정확히 `["text","image"]`를 단정한다.

회귀 감지력을 가정하지 않고 확인했다: enum 필터를 임시로 지우면 **실패**하고, 되돌리면 통과한다.

검증: 카탈로그 스위트 142 pass (5파일), typecheck·privacy green. 사용자 실제 카탈로그도 재확인 —
31개 모델, enum 밖 값 0개, 사고를 낸 `zenmux/meta-muse-spark-1.1`이 지금
`['text','image','audio']`로 정상.

### 남긴 후속 항목

발견성이 약하다. Codex의 파싱 오류가 `ocx sync`를 알려주지 않으므로 사용자는 복구 방법을 모른다.
CLI/문서 진단 결정이라 이 유닛에서 숨은 변형으로 풀지 않고 남긴다.

## WP7 — 멀티모델 CLI 이관 (PARTIAL, `cb43b957a` `369df5972` `3abe62023` `951e96713`)

`060_multimodel_demotion.md` 소비. **PARTIAL로 닫는다** — CLI/API 동등성은 문서화하고 강제까지
했지만, 계획의 GUI 컨트롤 제거는 사용자 승인 대기로 남긴다.

### GUI 제거를 하지 않은 이유

계획 자체가 GUI 제거를 명시적 사용자 승인 gate 뒤에 둔다. 게다가 이번 세션에서 사용량·저장소·
서브에이전트 세 탭의 레이아웃을 **되돌리는** 작업을 이미 했다. 사용자가 이전 dense-workspace
리팩터를 싫어했다는 뜻이므로, 큰 관리 표면을 묻지 않고 삭제하는 것은 가장 거부당할 확률이 높은
선택이다.

### 문서 작업이 실제 결함을 찾아냈다

계획의 전제는 "모델 단위 GUI 조작마다 CLI/API 대응이 있다"는 것이다. 표를 믿지 않고 shipped
USAGE 문자열과 실제 프록시에 대고 12개 하위 명령을 전부 확인했다. 읽기 경로는 실행, 쓰기 경로는
왕복으로 검증했다(`zenmux/qwen-qwen3.7-flash` disable → `disabled: true` 확인 → enable →
원래 상태와 행 수 일치). 사용자 설정은 그대로 되돌려 놨다.

**그런데 감사에서 실제 구멍이 나왔다.** `/api/custom-models`가 POST·PUT 양쪽에서 아무 문자열이나
받았다. 즉 `ocx models edit <id> --modalities video`가 저장됐다. 카탈로그 writer가 나가는 길에
걸러주므로 Codex는 살아 있었지만, **저장된 값이 GUI와 CLI에 진짜인 것처럼 되돌아왔다.** 오프라인
`ocx models add`는 이미 거절하고 있었으니 세 경로의 계약이 서로 달랐던 것이다. 공용 allowlist로
400을 돌려주게 고쳤다.

2라운드에서 같은 버그의 미묘한 버전이 또 나왔다. 내 validator가 비문자열을 **걸러내고** 검사해서,
`["text", 42]` POST가 201로 `["text"]`를 저장하고 `[42]` PUT은 200을 주면서 저장된 modality를
조용히 **지웠다**. 400을 약속하는 validator가 할 수 있는 가장 나쁜 동작이다. 첫 비문자열에서
거절하도록 고쳤고, 빈 배열은 `--modalities -`의 clear 경로이므로 유효하게 유지했다.

### 내 문서가 틀렸던 세 곳

| 잘못 쓴 것 | 실제 |
|---|---|
| `remove ... --json` | `--yes`만 받는다(`REMOVE_USAGE`) |
| "네이티브 모델은 `--native`가 필요" | 슬래시가 없으면 **이미** 네이티브. `--native`는 강제용 |
| "CLI가 잘못된 modality를 거절한다" | 당시 `add`만 거절. `edit`/API는 통과 (그래서 고쳤다) |

ja·ru는 단순 미번역이 아니라 **영문과 모순**이었다. 둘 다 "`ocx models`는 실시간 카탈로그를
못 읽으니 `ocx sync`나 대시보드를 쓰라"고 적혀 있었는데 `ocx models live`가 이를 반증한다. 두
locale의 해당 절만 고쳤다. 전체 locale 동기화는 이미 영문보다 100줄 이상 밀려 있어 별도 유닛이다.

### 회귀 감지력

두 번 다 가정하지 않고 확인했다. validation을 지우면 POST·PUT 케이스가 실패하고, 되돌리면 통과한다.
clear 경로 테스트도 fixture에 modality가 없어서 no-op에도 통과할 수 있다는 지적을 받아
`["text","image"]`로 심고, clear 분기를 무력화해 실제로 실패하는지 확인했다.

검증: 해당 파일 10 pass, 관련 3 스위트 36 pass, typecheck·privacy green, docs-site 146 페이지 빌드.

## 긴 목록 재캡 (`b6d9f4c57`)

되돌린 뒤 두 탭은 읽히긴 하는데 길었다. Usage 5495px, Subagents 피커는 카탈로그 길이만큼
자랐다. 협업자 요구는 "첫 화면에 되도록 다 보이되, 10 스크롤짜리 페이지와 접히는 목록은
금지"다. 접기는 애초에 없으니(`<details>`·`aria-expanded` 토글 0개) 남은 건 길이였다.

고정 높이 pane으로 되돌아가지 않고, **정말 무한한 두 영역만** 캡했다. Usage의 모델·프로바이더
테이블과 Subagents 피커다. 나머지 섹션은 문서에 그대로 있고 페이지 스크롤로 읽는다.

되돌리기 전 버전과 갈리는 지점은 `overscroll-behavior`다. 그쪽은 `contain`이라 포인터가
목록 위에 있는 동안 휠이 갇혔고 그래서 아래가 도달 불가능했다. 이번 둘은 `auto`이므로 목록
양 끝에서 제스처가 페이지로 넘어간다.

Subagents 캡은 행 그리드에 맞춰 내림한다. 행 42px에 gap 4px이므로 깔끔한 높이는 `n*46-4`이고,
맨 `vh` 캡은 행 중간에서 끊겨 스크롤 가능이 아니라 잘린 것처럼 보인다. `round(down, ...)`을
쓰고, 미지원 엔진에는 10행 픽셀 폴백을 둔다. 좁은 브레이크포인트 2곳도 같은 방식.

### 지난번 뺐던 sticky 헤더가 이번엔 붙는다

`a6aa981fa` 때는 `.tbl-wrap`이 `overflow-x: auto`를 유지해야 해서 그 wrap이 sticky `th`의
컨테이닝 블록이 되고, offset과 무관하게 wrap 자기 top에 붙어버렸다(실측 −882). 이번엔 wrap
자체가 세로 스크롤러가 됐으므로 `th`가 그 안에서 정상적으로 고정된다. wrap의 top padding이
콘텐츠와 함께 흐르므로 `top: calc(-1 * var(--space-3))`으로 붙이고, 그 띠를 그림자로 다시
칠한다 — sticky 셀은 테이블이 정지해 있을 때만 자기 border를 유지하기 때문이다.

### 검증 (커밋된 트리, 재빌드·재기동 후 CDP, 1440×900)

| 관측 | 값 |
|------|-----|
| Usage 페이지 높이 | **5495px → 2369px** |
| Usage 테이블 캡 | `max-height 522px`, client 520 / scroll 3357·749, 81·17행 |
| sticky `th` 오프셋 | 스크롤 전 13 → 900 스크롤 후 **1** (이전 시도 −882) |
| 휠 인계 | 안쪽 소진(2837/2837) 후 페이지가 652 → 1469(바닥)까지 이어서 이동 |
| Subagents 피커 | `max-height 456px`, client 456 = 정확히 10행, scroll 1192, 26행 |
| Subagents 페이지 높이 | 1073px (뷰포트 900) |
| overscroll | 두 영역 모두 `auto` |

게이트: GUI 427 pass / 0 fail, `lint:gui` 무경고, `gui build` clean.
스크린샷은 `.tmp/dogfood/shots/`(추적 안 되는 스크래치).

### 캐시 실측 (같은 인스턴스, 포트 10100)

협업자가 "캐시된 건 이제 훨씬 빠르지 않냐"고 물어 확인했다. 관리 API는 토큰이 필요하므로
토큰 없이 잰 0.5ms는 401 응답 시간이지 캐시 히트가 아니다 — 그 함정을 먼저 걷어냈다.

| 경로 | 시간 |
|------|------|
| `/api/provider-quotas` 캐시 히트 | 0.7–1.3ms |
| `/api/provider-quotas?refresh=1` | **7.8s** |
| `/api/startup-health` 캐시 | 0.4–0.7ms |
| `/api/providers` 캐시 | 0.4–0.7ms |

비싼 건 강제 새로고침 하나뿐이다. 다만 체감 개선의 큰 몫은 서버 캐시가 아니라 `a149b8fb2`의
요청 감축(콜드 로드당 quota 6회 → 1회)이었다.

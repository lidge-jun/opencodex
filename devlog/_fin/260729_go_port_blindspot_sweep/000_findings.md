# 000 — 관리 API 사각지대 실측: 파리티 테스트가 보지 않는 곳에 결함이 산다

브랜치 `dev2-go`, 기준 커밋 `8a5175f52`, 측정 2026-07-29.
측정 대상은 그 시점에 실제로 떠 있던 Go 런타임(`~/.opencodex/dogfood/ocx-go-dev`, `:10100`)이다.

## 왜 이 문서가 필요한가

오늘 하루에만 관리 API에서 서로 무관해 보이는 결함이 여러 개 나왔다. `/api/models`가 배열
대신 객체를 반환해 대시보드 전체가 `h is not iterable`로 죽었고, `/api/diagnostics/project-config`는
아예 다른 기능(OCX 설정 검증)을 수행하고 있었으며, `/api/sync`의 힌트 문자열은 오라클과 바이트가
달랐다. 각각을 개별 버그로 고치면 다음 것이 또 나온다.

그래서 "왜 이것들만 살아남았는가"를 물었고, 답은 재현 가능한 한 문장이었다.

**오늘 확인된 관리 API 발산은 예외 없이 차등 파리티 테스트가 한 번도 건드리지 않는 경로에 있었다.**

파리티 스위트는 통과하고 있었다. 통과했기 때문이 아니라 **보지 않았기 때문에** 통과한 것이다.
그러니 다음 결함을 찾는 가장 빠른 방법은 코드를 더 읽는 것이 아니라, 테스트가 보지 않는 경로
목록을 뽑아 그 안을 직접 때려보는 것이다. 이 문서는 그 목록과, 그 안에서 실제로 나온 것들이다.

## 무엇이 나왔는가

세 종류다. 순서는 사용자에게 닿는 정도 순이다.

**첫째, 조용히 잘린 응답.** 라우트는 200을 반환하는데 오라클이 담는 키 하나가 없다. 에러가 아니라
빈 화면으로 나타나기 때문에 아무도 버그로 신고하지 않는다. `/api/subagent-models`는 `available`이
없어서 서브에이전트 모델 선택기가 영구히 비어 있고, `/api/injection-model`도 같은 이유로 주입 모델
드롭다운이 비어 있다. `/api/settings`는 `startupHealth`와 `codexRuntime`을 통째로 빠뜨려서 Startup
페이지의 런타임 카드와 clamp 경고가 렌더될 수 없다.

**둘째, 등록되지 않은 라우트.** 오라클 라우트 9개가 라이브에서 404다. 그중 7개가 스토리지
클러스터인데, 흥미로운 건 스토리지 **도메인 로직은 이미 대량 이식돼 있다**는 점이다
(`go/internal/storage/`에 cleanup·policy·mutation·restore가 전부 있다). 계획 문서 `080_storage_safety.md`도
`go/internal/management/storage.go` 신규 생성을 명시한다. 즉 로직은 랜딩했고 HTTP 표면만 안 붙었다.
GUI의 Storage 페이지는 그 8개 엔드포인트를 호출하므로 페이지 전체가 죽어 있다.

**셋째, 이식됐지만 아무도 호출하지 않는 모듈.** 이번 세션에서 실제 버그 세 건(`ForceLogin`,
`DeriveStartupHealth`, `BuildToolBridgeMaps`)이 모두 "선언과 사용은 있는데 배선이 없다"는 같은 모양이었다.
그래서 `go/internal` 전체에 같은 스윕을 돌렸고, 사용자 표면에 닿는 후보를 추려 검증했다.
업데이트 알림 기능이 통째로 배선되지 않은 것이 대표적이다 — 오라클은 CLI 진입점에서
`maybeShowUpdatePrompt()`를 부르지만 Go의 캐시 함수들은 호출자가 없다.

## 이 결함들의 공통 원인

셋 다 "구현이 틀렸다"가 아니라 **"구현이 끝까지 연결되지 않았다"**이다. 포팅이 모듈 단위로 진행되는
동안 그 모듈을 부르는 쪽(라우트 등록, 응답 조립, CLI 진입점)이 뒤따르지 않았고, 파리티 테스트가
그 경로를 보지 않으니 아무도 몰랐다. 개별 결함을 고치는 것만으로는 재발한다 — 사각지대 자체가
줄어들지 않기 때문이다.

---

## 1. 파리티 사각지대 지도

측정 방법: 오라클 `src/server/management/**`에서 `url.pathname === "…"`로 등록된 경로를 뽑고,
`go/test/parity/*.go` 전체에서 문자열로 등장하는 경로와 대조했다.

```
오라클 관리 경로: 69
파리티 테스트가 언급하는 경로: 21
어떤 파리티 테스트도 건드리지 않는 경로: 48
```

오늘 확인된 관리 API 발산이 사각지대 안에 있는지 대조:

| 경로 | 오늘 확인된 상태 | 파리티 커버 |
| --- | --- | --- |
| `/api/models` | 객체 vs 배열 (대시보드 크래시) — `13b129bfd`에서 수정 | ❌ 없음 |
| `/api/diagnostics/project-config` | 다른 기능 수행 — `a87195061`에서 수정 | ❌ 없음 |
| `/api/sync` | `staleAppServerHint` 바이트 발산 — `be5f55058`에서 수정 | ❌ 없음 |
| `/api/settings` | `startupHealth`·`codexRuntime` 누락 (미수정) | ❌ 없음 |
| `/api/startup-health` | 페이로드 자체가 다름 (미수정) | ❌ 없음 |
| `/api/subagent-models` | `available` 누락 (미수정) | ❌ 없음 |
| `/api/injection-model` | `available`·`syncCodexSubagentDefaults` 누락 (미수정) | ❌ 없음 |
| `/api/storage/**` | 404 (미수정) | ❌ 없음 |

예외는 없다. 8/8이 사각지대 안이다.

커버되지 않는 48개 전체 목록(재현 스크립트는 §5):

```
/api/claude-code                     /api/oauth/login/code
/api/claude-desktop                  /api/oauth/logout
/api/claude/inbound-debug            /api/oauth/providers
/api/debug/injection-logs            /api/oauth/status
/api/debug/logs                      /api/provider-context-caps
/api/diagnostics/project-config      /api/provider-presets
/api/disabled-models                 /api/provider-quotas
/api/grok                            /api/providers/keys/alias
/api/grok/apply                      /api/providers/test
/api/grok/selection                  /api/settings
/api/injection-model                 /api/startup-action
/api/key-providers                   /api/startup-health
/api/models                          /api/storage/cleanup
/api/oauth/accounts                  /api/storage/cleanup-policy
/api/oauth/accounts/active           /api/storage/cleanup-policy/run
/api/oauth/accounts/alias            /api/storage/cleanup-policy/test-stream
/api/oauth/accounts/clear-cooldown   /api/storage/cleanup/preview
/api/oauth/login                     /api/storage/trash
/api/oauth/login/cancel              /api/storage/trash/restore
                                     /api/storage/trash/restore/test-stream
/api/subagent-model-fallback         /api/sync
/api/subagent-models                 /api/system/restart
/api/update/check                    /api/update/run
/api/update/status                   /api/v2
/api/windows-tray
```

## 2. 조용히 잘린 응답 (라우트는 200)

### 2.1 `/api/subagent-models` — `available` 누락

```
$ curl -s http://127.0.0.1:10100/api/subagent-models
{"chosen":["gpt-5.5","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.4-mini"]}
```

오라클(`src/server/management/agent-settings-routes.ts:335`)은
`jsonResponse({ chosen: config.subagentModels ?? [], available })`를 반환하고, `available`은
네이티브 슬러그 + 비활성 제외 라우팅 모델의 합집합이다(같은 파일 :331).

Go는 `go/internal/management/agents.go:18`에서 `map[string]any{"chosen": models}`만 쓴다.

**사용자 영향**: `gui/src/pages/Subagents.tsx:26-28`이 `r.available ?? []`를 읽는다. 즉 선택기가
항상 빈 목록이라 서브에이전트 모델을 GUI에서 **고를 수 없다**. 이미 고른 값은 표시되므로
"목록이 비었다"가 아니라 "왜 아무것도 안 뜨지"로 보인다.

### 2.2 `/api/injection-model` — `available`·`syncCodexSubagentDefaults` 누락

```
$ curl -s http://127.0.0.1:10100/api/injection-model
{"effort":"high","efforts":[...],"model":"gpt-5.6-sol","multiAgentGuidanceEnabled":true,"prompt":null}
```

오라클(`agent-settings-routes.ts:192-199`)은 `multiAgentGuidanceEnabled`,
`syncCodexSubagentDefaults`, `model`, `effort`, `prompt`, `efforts`, `available`을 담는다.
`available`은 `{provider, model, namespaced}` 배열이다(:186, :188).

**사용자 영향**: `gui/src/pages/dashboard-overview-sections.tsx:105`가
`injectionAvailable.map(...)`으로 드롭다운을 만든다 → 주입 모델을 GUI에서 바꿀 수 없다.
`syncCodexSubagentDefaults` 토글도 항상 꺼진 것으로 보인다.

### 2.3 `/api/settings` — `startupHealth`·`codexRuntime` 누락

```
$ curl -s http://127.0.0.1:10100/api/settings
{"codexAutoStart":false,"hostname":"127.0.0.1","port":10100,"streamMode":"auto"}
```

오라클(`src/server/management/config-routes.ts:112-134`)은 위 4개에 더해
`startupHealth: await getCachedStartupHealth(config)`와 `codexRuntime: {path, version, source,
newerAvailable, catalogClamp:{active,removedEfforts,runtimeVersion}, warning}`을 담는다.

**사용자 영향**: `gui/src/pages/Startup.tsx:49-66`이 `settings.codexRuntime`을 읽어 런타임 버전,
"더 새 Codex가 있음" 경고, effort clamp 안내를 렌더한다. Go에서는 이 카드가 **절대 뜨지 않는다**.
`startupHealth` 누락은 대시보드 시작 배지의 seed 경로도 함께 끊는다.

### 2.4 `/api/startup-health` — 페이로드가 다른 것을 측정한다

```
$ curl -s http://127.0.0.1:10100/api/startup-health
{"codexAutoStart":false,"healthy":true,"pid":55469,"port":10100,"stale":true}
```

오라클은 `{status, routingKind, routingInjected, localRoutingDependency, autostartEnabled,
rebootSafe, protection, service*, shim*, shimCoverage, platform, diagnosticStale,
recommendedCommand, commands{...}}`를 반환한다.

Go에는 충실한 이식본 `codex.DeriveStartupHealth`(`go/internal/codex/autostart_health.go:55`)가
**있지만 프로덕션 호출자가 없다**. 대신 `(*cliRuntimeControl).StartupHealth`
(`go/internal/cli/runtime_management.go:626`)가 프록시 liveness ping으로 위 5키를 만들어낸다.

**사용자 영향**: `gui/src/startup-health-ui.ts:52-59`의 `mapStartupHealthProbe`가 `status`를
검사하고 없으면 `null` → 대시보드가 시작 상태를 항상 `error`로 표시한다.

빠진 조각: `collectStartupHealth`, `getCodexRoutingKind` 파일 리더,
크로스플랫폼 `diagnoseService`, `markStartupHealthDiagnosticStale`, 보수적 fallback,
GOOS→node platform 매핑(`windows`→`win32`).

## 3. 등록되지 않은 라우트 (라이브 404)

`POST`는 `{}` 본문, 8초 타임아웃으로 측정.

| 라우트 | Go 응답 |
| --- | --- |
| `GET /api/storage/cleanup-policy` | 404 |
| `GET /api/storage/cleanup-policy/test-stream` | 404 |
| `PUT /api/storage/cleanup-policy` | 404 |
| `POST /api/storage/cleanup-policy/run` | 404 |
| `POST /api/storage/cleanup` | 404 |
| `POST /api/storage/cleanup/preview` | 404 |
| `GET /api/storage/trash` | 404 |
| `POST /api/storage/trash/restore` | 404 |
| `GET /api/storage/trash/restore/test-stream` | 404 |
| `POST /api/oauth/accounts/clear-cooldown` | 404 |
| `POST /api/system/restart` | 404 |

본문은 전부 `{"error":{"message":"Unknown endpoint: …","type":"not_found"}}`.
(`GET /api/storage`는 등록돼 있고 501 + `{"error":"Codex storage home is not configured"}`를 반환한다.)

**스토리지가 특히 중요한 이유**: 도메인 로직은 이미 있다.

```
$ ls go/internal/storage/
cleanup.go  cleanup_execute_types.go  mutation.go  policy.go  policy_due.go
policy_input.go  policy_run.go  dbprobe.go  jsonnum.go  ...
$ grep -n "^func [A-Z]" go/internal/storage/cleanup.go | head -3
133:func ListArchivedCandidates(codexHome string) []ArchivedCandidate
380:func PreviewArchivedCleanup(codexHome string, percent float64) (CleanupPreview, error)
405:func PreviewExactArchivedCleanup(...)
```

계획 문서도 라우트 등록을 명시한다(`080_storage_safety.md:44`, `:100`). 즉 **미이식이 아니라
미배선**이다. `gui/src/pages/Storage.tsx`는 이 8개 엔드포인트를 호출하므로 Storage 페이지 전체가
동작하지 않는다.

`POST /api/system/restart` 부재는 `100_management_and_registry.md:5,29`에 이미 기록돼 있다.
`clear-cooldown`은 GUI 소비자가 없어 API 전용 탈출구이지만, `260726_cooldown_lockout_hardening`
유닛이 만든 그 탈출구가 Go에서는 존재하지 않는다.

## 4. 이식됐지만 배선되지 않은 모듈

`go/internal` 전체(이미 감사된 `internal/claude` 제외)에서 **exported 함수 933개** 중
**비테스트 참조가 자기 선언뿐인 것 112개**를 찾았다. 대부분은 테스트 훅이거나 얇은 래퍼로 무해하다.
사용자 표면에 닿는 것만 검증했다.

### 4.1 업데이트 알림이 통째로 배선되지 않음 (신규)

```
$ grep -rn "ReadVersionCache|UpgradeVersion|DismissVersion" go/internal go/cmd | grep -v notify.go
(없음)
```

오라클은 CLI 진입점에서 부른다:

```
src/cli/index.ts:42   import { maybeShowUpdatePrompt } from "../update/notify";
src/cli/index.ts:183  await maybeShowUpdatePrompt();   // 포트 바인딩 전에 실행 (주석: 업데이트 시 자기 바이너리를 덮어씀)
src/cli/index.ts:926  const { refreshVersionCache } = await import("../update/notify");
```

Go의 `internal/update/notify.go`는 `ReadVersionCache`/`WriteVersionCache`/`CacheStale`/
`UpgradeVersion`/`DismissVersion`을 전부 갖고 있으나 호출자가 하나도 없다.
`ocx update` 명령 자체는 있으므로 "업데이트할 수 없다"가 아니라 **"새 버전이 나왔다고 알려주지 않는다"**이다.
`260629_update-notify-prompt` 유닛이 만든 기능이 Go에서 조용히 사라진 상태.

### 4.2 이미 후보로 기록됐으나 아직 미해소인 것들

`go/internal/claude/DEAD_EXPORT_AUDIT.md:46`이 "likely CLI lifecycle omissions"로 묶어둔 클러스터가
이번 스윕에서도 그대로 나왔다. 이 문서는 그것을 **재측정으로 확인**한다:

- `ResolveAndPersistCodexRuntime`, `FormatRuntimeLogLine`, `FormatClampLogLines`,
  `LoadLastEffortClamp`, `PersistEffortClamp` — 오라클은 `src/codex/catalog/effort.ts:308,320`에서
  런타임을 해석·기록하고 그 결과를 stderr 로그와 `/api/settings`의 `codexRuntime`에 흘린다.
  §2.3의 누락과 **같은 뿌리**다.
- `ClassifyCodexRouting` — §2.4의 `getCodexRoutingKind` 파일 리더가 없어서 순수 분류기만 떠 있다.
- `DedupeRelatedProjectConfigWarnings`, `FormatProjectConfigWarningsForConsole` — 오라클은
  `src/codex/sync.ts`에서 sync 도중 프로젝트 설정 경고를 콘솔에 출력한다. Go의 `ocx sync`는
  출력하지 않는다.
- `GetAgentsMaxThreads`, `GetMaxConcurrentThreads`, `MarkJournalInjectedState`, `BuildUnixShim`.

### 4.3 오탐으로 확인된 것 (기록해 둠)

브리지 SSE 이벤트 커버리지를 정적으로 비교하면 Go가 `response.completed`/`failed`/`incomplete`를
누락한 것처럼 보인다. 실제로는 `go/internal/bridge/bridge.go:569`가
`eventType := "response." + status`로 이름을 조립하므로 세 이벤트 모두 정상 방출된다.
**문자열 grep 기반 이벤트 비교는 이 패턴에 대해 신뢰할 수 없다.**

## 5. 재현 방법

사각지대 지도:

```bash
cd /path/to/opencodex
grep -rhoE '"(/api/[a-z0-9/_-]+)"' go/test/parity/*.go | sort -u > /tmp/covered.txt
python3 - <<'PY'
import os,re
covered=set(l.strip().strip('"') for l in open('/tmp/covered.txt'))
ts=set()
for f in os.listdir('src/server/management'):
    if f.endswith('.ts'):
        for m in re.finditer(r'url\.pathname === "([^"]+)"', open('src/server/management/'+f).read()):
            ts.add(m.group(1))
print(len(ts), len(ts&covered), sorted(p for p in ts if p not in covered), sep="\n")
PY
```

라이브 404 확인:

```bash
for r in "GET /api/storage/trash" "POST /api/storage/cleanup/preview" "POST /api/system/restart"; do
  m=${r%% *}; p=${r#* }
  printf "%-40s %s\n" "$r" "$(curl -s -o /dev/null -w '%{http_code}' -X $m \
    -H 'content-type: application/json' -d '{}' "http://127.0.0.1:10100$p")"
done
```

배선되지 않은 exported 함수 스윕: `§4` 본문의 방법(선언 수집 → 비테스트 참조 카운트)을
`go/internal`에 적용. 결과가 곧바로 결함은 아니며, **오라클에 프로덕션 호출자가 있는지**를
대조해야 판정된다.

## 6. 다음 work-phase 후보 (의존성 순)

| # | 유닛 | 근거 | 비고 |
| --- | --- | --- | --- |
| 1 | `/api/subagent-models`·`/api/injection-model`에 `available` 추가 | §2.1, §2.2 | 작다. `/api/models` 배열 이식(`13b129bfd`)이 만든 카탈로그 행을 그대로 재사용 가능 |
| 2 | 스토리지 관리 라우트 등록 | §3 | 로직은 이미 있음. `080_storage_safety.md`의 미완 단계 |
| 3 | startup-health 수집 경로 + `/api/settings` 확장 | §2.3, §2.4, §4.2 | 가장 크다. `diagnoseService` 크로스플랫폼 이식이 선행 |
| 4 | 업데이트 알림 배선 | §4.1 | CLI 진입점 한 곳 + 캐시 경로 |
| 5 | 사각지대 축소: 차등 매트릭스에 관리 라우트 추가 | §1 | **이것을 먼저 하지 않으면 1~4를 고쳐도 재발한다** |

5번을 마지막이 아니라 병행으로 두는 이유는 §1의 8/8 대응 때문이다. 커버리지가 늘지 않으면
다음 결함도 같은 방식으로 조용히 살아남는다.

## 7. 이 문서가 주장하지 않는 것

- 커버되지 않는 48개 경로가 전부 발산한다는 주장이 아니다. 실측한 것은 §2·§3에 적은 것들뿐이다.
- `GET /api/update/check`가 `{"error":"Update check failed"}`를 반환하는 것은 네트워크·레이트리밋일
  수 있어 결함으로 판정하지 않았다.
- `260729_go-port-hardening` 유닛이 다루는 세 건(삭제 404, RSS, 런타임 라벨)과
  `ForceLogin`은 여기서 중복 기록하지 않는다. 이미 그 유닛과 `abb4dbc32`에 있다.

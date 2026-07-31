# 060 — WP3: WinSW `--native` 옵트인 backend

## 목표

`ocx service install --native`가 WinSW 2.12.0으로 진짜 SCM 서비스를 **사용자 계정**
으로 등록한다. 옵트인 전용 — 기본값 승격은 범위 밖. LocalSystem 금지.

## 설계 결정 (sol 검토 반영)

- **바이너리 조달**: npm 패키지에 바이너리를 커밋하지 않는다(레포 정책상 실바이너리
  커밋 회피). 대신 `ocx service install --native`가 최초 실행 시 GitHub 릴리스에서
  `WinSW.NET461.exe`(v2.12.0)를 `~/.opencodex/winsw/`에 다운로드하고 **핀 고정
  SHA-256 검증 후에만** 사용(불일치 시 fail-closed, 파일 삭제). 오프라인/프록시
  환경은 실패 메시지에 수동 배치 경로 안내. npm 동봉 전환은 후속 결정.
- **계정 (감사 blocker 3 반영)**: WinSW **v2.12 스키마**는 `<serviceaccount>` 안에
  `<domain>`/`<user>`/`<password>`/`<allowservicelogon>` 형식(v3의 `<username>` 아님).
  비밀번호를 XML에 저장하지 않으므로 자격증명 프롬프트는 `winsw install **/p**`로
  요청해야 한다 — 그리고 `/p`는 콘솔 stdin 프롬프트이므로 기존 `runFile`(stdin
  "ignore", :250)로는 불가. native install만 **`stdio: "inherit"` 동기 실행 helper
  `runFileInteractive()`** 를 새로 써서 사용자가 직접 프롬프트에 응답하게 한다.
  WinSW의 UAC 자가승격에 의존함을 명시하고, 사용자가 UAC를 거부하면 명확한 에러로
  중단(조용한 scheduler 폴백 금지). 설치 후 **검증 단계**: `sc.exe qc
  opencodex-proxy-native` 출력의 `SERVICE_START_NAME`이 의도한 사용자와 일치하는지
  확인하고, LocalSystem이면 즉시 `winsw uninstall` 롤백 + 에러 (WinSW 기본값이
  LocalSystem이므로 XML 미적용 사고를 구조적으로 차단). 재설치("service already
  exists" 실패) 경로: 서비스가 이미 존재하면 install을 건너뛰고 자산 재기록 +
  `winsw stop`(무시 가능) + `winsw start`로 자격증명 재프롬프트 없이 갱신.
  passwordless MS 계정 실패는 명확한 에러로 표면화(실측 매트릭스).
- **graceful stop**: WinSW `<stoptimeout>` + Ctrl+C 우선 동작에 위임하되, 프록시가
  시그널로 죽는 경로와 무관하게 `ocx service stop`은 기존 drain
  (`stopTrackedProxyForServiceCommand`)을 계속 수행. WinSW가 먼저 자식을 죽이는
  경우의 이중 안전.
- **토큰**: 래퍼 배치를 쓰지 않으므로 앱이 직접 읽는다 — `OCX_API_TOKEN_FILE`
  환경변수를 앱 차원에서 소비(아래 diff). 시크릿을 WinSW XML에 넣지 않는다.

## Diff-level 변경

1. **NEW** `src/lib/winsw.ts`:
   - `WINSW_VERSION = "2.12.0"`, `WINSW_URL`(GitHub release NET461 asset),
     `WINSW_SHA256`(핀; 구현 시 실제 릴리스 자산에서 채움 — B 단계에서
     `curl | shasum -a 256`으로 확정, 문서에 기록)
   - `winswDir()` = `join(getConfigDir(), "winsw")`, `winswExePath()`,
     `winswXmlPath()` (= `winswDir()/opencodex-proxy.xml`; WinSW는 exe와 동명
     XML을 요구하므로 exe를 `opencodex-proxy.exe`로 저장)
   - `buildWinswXml(entry): string` — `<service>` id `opencodex-proxy-native`,
     `<executable>`=bun, `<arguments>`=cli start, `<env name="OCX_SERVICE" value="1"/>`,
     `<env name="OCX_API_TOKEN_FILE" .../>`, CODEX_HOME/OPENCODEX_HOME 절대경로,
     **`<env name="PATH" value="<현재 PATH, XML 이스케이프>"/>`** (감사 WARN 7 —
     Scheduler/launchd/systemd 전부 PATH를 bake하는 기존 계약과 동일; SCM 서비스
     환경에는 사용자 대화형 PATH가 없어 provider 실행파일이 깨질 수 있음),
     `<logpath>`=getConfigDir(), `<log mode="roll-by-size">`, `<onfailure action="restart" delay="5 sec"/>`,
     `<stoptimeout>20 sec</stoptimeout>`, `<serviceaccount>`(v2 스키마:
     domain/user/allowservicelogon, password 요소 없음).
     XML 이스케이프는 기존 `taskXmlString` 패턴 재사용(공유 helper로 승격).
   - `ensureWinswBinary(): Promise<string>` — 존재+해시 일치 시 재사용; 아니면
     다운로드→해시 검증→불일치 시 unlink+throw.
   - `installWinsw()` — `runFileInteractive(winswExePath(), ["install", "/p"])  # v2.12은 args[1]===/p 만 인식; XML은 exe 옆 동명 파일로 자동 발견`
     (stdin inherit) → `sc.exe qc` StartName 검증/롤백 → `winsw start`.
     `startWinsw()/stopWinsw()/uninstallWinsw()` — `runFile(...)`.
   - `statusWinsw()` — WinSW v2 `status`의 정확한 출력(`Started`/`Stopped`/
     `NonExistent`)을 파싱(감사 WARN 8): `NonExistent`→미설치, exe/xml 존재 여부와
     SCM 존재를 혼동하지 않는다. exe가 지워졌는데 SCM 서비스가 남은 경우는 status
     진단에 "stale native service — run `ocx service uninstall`" 힌트.
2. **MODIFY** `src/service.ts`:
   - `ServiceOps` 선택이 backend 인자를 받도록: `platformOps(backend?: "scheduler"|"native")`.
     win32에서 `backend==="native"`면 winsw ops 반환. 기본은 scheduler.
   - `serviceCommand(sub, flags)` 시그니처 확장: `--native`/`--scheduler` 플래그를
     install에만 허용(다른 서브커맨드는 state에서 backend를 읽음 — 영속화는 본 WP3에서 v2로 도입;
     **감사 WARN 9 반영 — 스키마 계약을 쪼개지 않는다**: state **v2 스키마와 exported
     accessor(`readServiceBackend()`)를 WP3에서 함께 도입**하고, 070은 update 전파와
     고아/충돌 탐지에 집중하도록 재배치).
   - **backend 전환 트랜잭션(감사 blocker 5)**: `install --native`는 기존 scheduler
     설치가 있으면 **먼저 stopWindows()+uninstallWindows()로 제거**한 뒤 native를
     설치(역방향 `install --scheduler`도 동일). native 설치 실패 시 scheduler를
     자동 재설치하지 않고 "no service installed" 상태로 명확히 보고(조용한 폴백
     금지). `stopServiceIfInstalled`/`serviceStatusSummary`는 state와 무관하게
     **양쪽 backend를 모두 질의**해 충돌(둘 다 설치됨)을 감지·보고한다.
   - install(native) 흐름: `await ensureWinswBinary()` → XML 기록 → `winsw install`
     → `winsw start` → `writeServiceInstallState()`(backend 포함).
   - stop/uninstall/status: state의 backend를 읽어 해당 ops 사용. legacy(필드 없음)는
     scheduler로 간주. uninstall(native)은 `winsw uninstall` 후 exe/xml 잔존 허용
     (재설치 대비; `--purge`는 범위 밖).
3. **MODIFY** `src/cli/index.ts` (:552-554) — `case "service"`가 `args.slice(1)`을
   전달하고 `serviceCommand`가 `[sub, ...flags]`를 파싱. `normalizeServiceSubcommand`
   는 플래그가 아닌 첫 토큰을 sub로 취급.
4. **MODIFY** `src/cli/index.ts` `handleStart()` 초입(:106, `startServer()` 호출
   전) — **감사 blocker 6 확정 지점**: `OPENCODEX_API_AUTH_TOKEN`이 비어 있고
   `OCX_API_TOKEN_FILE`이 설정돼 있으면 파일에서 읽어 `process.env.
   OPENCODEX_API_AUTH_TOKEN`에 주입(서버 인증은 src/server/index.ts:145에서 env를
   읽으므로 이 시점 주입으로 충분). 구현은 `src/lib/service-secrets.ts`의 순수 함수
   `loadServiceTokenFromFile(env: Record<string,string|undefined>): string | null`
   (파일 읽기 성공 시 트림된 토큰 반환, 그 외 null — **env를 직접 변형하지 않고
   호출부가 대입**)로 하고 단위테스트.
5. **주의 계약**: `%USERPROFILE%` 간접화는 WinSW XML에 쓰지 않는다(Unicode XML이라
   불필요, sol 지적). 절대경로 bake.

## 테스트 (tests/service.test.ts + NEW tests/winsw.test.ts)

- `buildWinswXml`: serviceaccount/allowservicelogon 존재, LocalSystem 부재,
  OCX_SERVICE=1 env, **PATH env 존재+이스케이프**, stoptimeout, onfailure restart,
  XML 이스케이프(경로에 `&`), 시크릿(토큰 값) 미포함, **v2 스키마 형식
  (domain/user, username 요소 부재)**.
- `ensureWinswBinary` 해시 불일치 fail-closed(mock fetch/fs).
- `statusWinsw` 파싱: `Started`/`Stopped`/`NonExistent` 3분기.
- backend 전환: `install --native`가 scheduler 제거를 선행하는 소스 계약,
  실패 시 폴백 없음.
- CLI 인자: `service install --native`가 native ops로 분기(모듈 mock 또는 파싱
  함수 단위 테스트 — `parseServiceArgs(["install","--native"])`).
- `loadServiceTokenFromFile`: 파일 존재/부재/공백 트림.

## 실측 매트릭스 (Windows)

UAC/자격증명 프롬프트 흐름, passwordless MS 계정 실패 메시지, SCM stop graceful
drain(Bun이 Ctrl+C 수신하는지), 부팅 시작, ACL hardened 토큰 파일 읽기.

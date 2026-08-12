# 000 — dev head 4da468ce6 기준 이슈 트리아지 매트릭스

기준: `origin/dev = 4da468ce6`, `main = d1f544bbc (v2.7.43)`, `preview = b04b8729e`.
열린 PR 14개(전부 dev 타깃, 5개 DRAFT), 열린 이슈 40+개.

Sol 서브에이전트 2개를 병렬 파견해 각 이슈를 **실제 dev 코드와 git 이력에 대조**했다.
같은 파일을 건드린 커밋이 있다는 것만으로는 수정 근거로 인정하지 않았고, 보고된 실패
모드를 실제로 해소하는지까지 확인했다.

## 결과 요약

21건을 검증해 **닫을 수 있는 것은 1건**이다. 나머지는 정당하게 열려 있다.

| 이슈 | 판정 | 근거 |
|---|---|---|
| #655 Kiro Login이 깨진 브라우저 OAuth를 띄움 | **FIXED-ON-DEV** | `cec8c1a9c` + `998ebada1` 둘 다 ON-DEV 확인 |
| #733 tray host가 이전 포트를 계속 점유 | 열림 | `src/tray/windows.ts:417,446` — 핸들 격리 없음 |
| #722 schtasks 로컬라이즈 출력을 UTF-8로 디코딩 | 열림 | `src/service.ts:358,1267,1758` — 여전히 `encoding: "utf8"` |
| #721 npm launcher가 OPENCODEX_BUN_PATH 무시 | 열림 | `bin/ocx.mjs:319,356` — 자체 `resolveBun()`이 번들만 탐색 |
| #720 GUI 업데이트가 조기 실패 보고 | 열림 | `src/update/job.ts:534-553` — 15초 상한, 최종 재확인 없음 |
| #719 Kiro 대형 MCP 카탈로그 CONTENT_FILTERED | 열림 | 설명만 절단, **카탈로그 총량은 무제한** (`kiro-tools.ts:138-160`) |
| #716 Kiro CLI 설치 안내가 Unix 전용 | 열림 | `src/oauth/kiro.ts:347`이 `curl \| bash` 안내, `install.ps1` 0건 |
| #696 Windows autostart Run 항목 260자 초과 | 열림 | `src/tray/windows.ts:482-553` — VBS launcher 미등록 |
| #726 대시보드 로그 200건 상한 | 열림 | `src/server/request-log.ts:129` — 페이지네이션 없음 |
| #725 로그 타임스탬프가 브라우저 로컬 시간 | **NEEDS-DECISION** | `gui/src/pages/Logs.tsx:276-281` — 제품 판단 필요 |
| #724 quota refresh가 stale plan 유지 | 열림 | `src/codex/auth-api.ts:541-550` — `freshPlan` 미반영 |
| #723 Antigravity GET /models 탐색 실패 | 열림 | `registry.ts:799` — `liveModels:false` 누락 |
| #702 Codex App resume가 1시간 후 컨텍스트 유실 | 열림 | `src/responses/state.ts:319-322` — TTL 그대로 |
| #701 Bun dotenv가 Claude 구독 인증을 덮어씀 | 열림 | `bin/ocx.mjs:356-364` — `--no-env-file` 없음 |
| #688 DeepSeek V4 web-search가 reasoning_raw_delta 유실 | 열림 | `src/web-search/loop.ts:107-116` |
| #658 AgentRouter 스트림이 terminal SSE 없이 종료 | 열림 | `src/adapters/anthropic.ts:833-848` |
| #606 codex --version 프로브가 3초 예산 초과 | 열림 | PR #610이 해결하겠지만 **아직 머지 안 됨** |
| #553 Copilot 502 + TLS hostname mismatch | 열림 (라벨 정정) | `fff8c369f`는 **진단만** 개선, 요청은 여전히 실패 |
| #417 한국어 음성 전사 U+FFFD | 열림 (upstream tracker) | 업스트림 `openai/codex#35161` 여전히 OPEN |
| #241 라우팅 모델이 Desktop picker에 없음 | 열림 (upstream tracker) | Desktop `26.721.81911`이 여전히 allowlist 적용 |

## 닫는 것: #655

`cec8c1a9c fix(oauth): resolve Kiro login flow before blocking on manual paste`가
CLI credential이 없을 때 **빈 URL로 로그인 플로우를 먼저 해소**해 브라우저 OAuth를
띄우지 않게 만들었다(`src/oauth/kiro.ts:341` 부근, 직접 확인).
`998ebada1`이 kiro-cli 설치·로그인 안내를 추가했다. 두 커밋 모두 ON-DEV 확인.

## 라벨 정정: #553

`needs-info`가 붙어 있는데 **사실과 어긋난다.** 코멘트 5개 중 마지막이 owner 본인의
상태 업데이트이고, 신고자는 요청받은 증거(Shadowrocket/VPN Fake-IP가 무관한 인증서를
제공)를 이미 제출했다. 정보를 기다리는 상태가 아니다.

`fff8c369f`(#575)는 TLS 인증서 불일치와 unreachable provider를 구분해주지만 요청이
성공하게 만들지는 않는다. 그래서 **닫지 않고 라벨만 정정**한다. 남은 확정 artifact는
TUN/VPN을 끈 청정 네트워크에서의 재현이다.

## 실행 결과

- **#655 CLOSED** (completed) — 근거 코멘트 게시:
  `issuecomment-5126432621`. 두 커밋을 명시하고, 이 이슈가 드러낸 별개 문제(Unix 전용
  설치 안내)는 #716으로 연결해 남겼다.
- **#553** — `needs-info` 제거, `bug` 유지. 열린 상태 그대로.
- 확인 결과 남은 `needs-info` 이슈는 **0건**이고, #723의 `provider-compatibility`
  라벨도 정확하다. 추가 라벨 정정 불필요.
- PR 머지·`main` 승격·`preview` 변경은 **하지 않았다** (goal 경계).

## 오탐을 피한 지점

- **#716 vs #710**: `c7fe9e808`(=`14d58ec1d`와 동일 patch-id, ON-DEV)은 Windows
  **토큰 저장소 탐색**만 추가한다. #716은 **설치 안내 문구**가 Unix 전용이라는
  별개 표면이다. 실제로 #655를 고친 그 코드조차 `curl -fsSL … | bash`를 안내한다.
  같은 Kiro/Windows 영역이라 묶어 닫기 쉬웠지만 근거가 없다.
- **#719**: 도구 설명 절단(`kiro-tools.ts:138`)과 `MAX_KIRO_INJECTED_INSTRUCTION_CHARS`가
  있어 이미 해결됐다고 볼 여지가 있었다. 그러나 후자는 **프록시가 주입하는 지시문만**
  제한하고 도구 개수·스키마·카탈로그 총 바이트는 제한하지 않는다.
- **#725 vs #726**: 둘 다 대시보드 로그지만 타임존 표현과 보존/페이지네이션으로
  서로 다른 문제다. 중복으로 닫지 않는다.
- **#606 vs PR #610**: #610의 head(`1310dd20b`, `056aa2d6e`)는 **NOT-ON-DEV**다.
  머지되지 않은 PR로 이슈를 닫으면 안 된다.
- **#417 / #241**: upstream-tracking은 오래됐다는 이유로 닫지 않는다. 추적 목적이
  살아 있고 업스트림이 미해결이다.

## dev ↔ main 상태 (승격 판단 근거)

`dev`는 `main`보다 29 커밋 앞서 있고, 참조 이슈는 #575 #646 #652 #710 #711 #717 #718 #732.

그런데 **역방향에도 격차가 있다.** merge-base(`d4b3c8132`) 이후 `main`이 추가한 것을
diff하면 `package.json` 한 줄뿐이다:

```
dev  package.json: "version": "2.7.41"
main package.json: "version": "2.7.43"
```

즉 dev가 릴리스 버전보다 **뒤처져** 있다. 과거 관행은 반영해왔다 — dev에서
`release: v2.7.39`, `v2.7.40`, `v2.7.41` 커밋이 모두 도달 가능하다. v2.7.42/43의
bump만 dev로 돌아오지 않았다.

이건 릴리스 트레인 결정이므로 **자동으로 처리하지 않는다.** 다음 릴리스에서
`scripts/release.ts`가 버전을 올릴 때 2.7.41 기준으로 계산하면 이미 배포된 태그와
충돌할 수 있어, owner가 알고 있어야 하는 사실이다.

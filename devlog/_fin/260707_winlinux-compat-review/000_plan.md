# Windows/Linux 호환성 검토 (260707)

Goal: preview 브랜치 전체를 대상으로 플랫폼 의존 가정 전수 스캔, 실결함 패치. Session 019f34f2-3c06-7250-a2ee-dd3707f8130d.

## 스캔 범위 및 통과 확인 항목

`process.platform`/darwin/win32 분기, 경로 구성, 셸 호출, 시그널, chmod 전수 grep:

- service.ts: launchd/systemd/schtasks 3-플랫폼, `sh()` 셸 문자열은 darwin/linux 섹션 전용, win32는 execFileSync+배치 이스케이프(`windowsBatchValue`), XDG_RUNTIME_DIR SSH 폴백.
- open-url.ts: open/rundll32/xdg-open + ENOENT async error 가드.
- process-control.ts: win32 taskkill /T /F 래더, POSIX SIGTERM→SIGKILL.
- catalog.ts/history-provider.ts: win32 대소문자 무시 경로 비교, .cmd/.bat 처리, .ps1 제외.
- shim.ts: win32 다중 래퍼(.cmd 등), gui-static.ts: 백슬래시 정규화 + traversal 차단.
- codex/home.ts: WSL 감지(WSL_DISTRO_NAME/proc/version) + /mnt/c/Users 프로필 매칭.
- server/responses.ts: win32 네이티브 릴레이 유지(Bun#32111).
- config.ts expandUserPath: `~/`와 `~\` 둘 다 처리. bin/ocx.mjs: npm.cmd, 경로 split `[\\/]`.
- chmod 계열 전부 try/catch best-effort (Windows no-op 안전).

## 실결함 2건 (패치 완료)

1. **Claude Code 토큰 자동감지 darwin 전용** — local-token-detect.ts:44가 keychain 실패 시 즉시 null. Linux/Windows의 Claude Code는 `~/.claude/.credentials.json`(또는 `CLAUDE_CONFIG_DIR`)에 동일 `claudeAiOauth` 페이로드를 기록함.
   - 수정: darwin keychain 우선 → 크로스플랫폼 파일 폴백. `parseClaudeOauthPayload`/`readClaudeCredentialsFile` 추출(테스트 표면). anthropic.ts "macOS-only" 에러 문구 교체.
2. **gcloud user ADC 경로 하드코딩** — gcp-adc.ts:69가 `~/.config/gcloud` 고정. gcloud SDK 규칙은 `CLOUDSDK_CONFIG` > win32 `%APPDATA%\gcloud` > `~/.config/gcloud`.
   - 수정: `gcloudConfigDir()` 해석 순서 구현.

## 검증

- `bun test ./tests/` 1613 pass / 0 fail, `bun x tsc --noEmit` clean.
- 신규 tests/local-token-detect.test.ts (3 케이스) + gcp-adc.test.ts CLOUDSDK_CONFIG authorized_user 케이스(호스트 GOOGLE_APPLICATION_CREDENTIALS 오염 차단 포함).
- 독립 리뷰어(gpt-5.5, James) 감사: **PASS, blocking_issues 없음.** 자체 재검증(대상 테스트 16 pass, tsc clean, git diff --check clean) 포함. 논블로킹 지적 1건(darwin not-found 메시지가 Keychain만 언급) → 즉시 반영 후 전체 스위트 재확인(1613 pass).

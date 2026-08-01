# 10 — 충돌 해소 기록

머지 커밋: `b57cee0` (Merge origin/dev into claudecode) + 후속 `ac2e7f7` (의미 충돌 해소)

## 텍스트 충돌 (2파일, 플랜 방침대로)

### src/server/management-api.ts (1훙크)

- 인접 라우트 블록 충돌: claudecode `/api/claude/inbound-debug` vs dev `/api/debug/injection-logs`.
- 해소: **두 블록 모두 유지** (claude 블록 먼저, injection 블록 다음). 제어 흐름 변경 없음.

### gui/src/pages/Debug.tsx (3훙크)

- 아키텍처 충돌: dev(#103)는 `entries: DebugLogEntry[]` + `formatLogTime` 렌더, claudecode는 `lines: string[]` + `useVirtualizer`.
- 해소: dev의 `entries` 상태를 채택하고 (auto-merge가 이미 fetch 경로를 entries로 전환), claudecode의 가상화를 entries 기준으로 재적용:
  - `count: entries.length`, scrollToIndex도 entries 기준
  - 가상 행 렌더를 `formatLogTime(entry.at) + entry.line`으로 → dev의 타임스탬프 표시 의도 보존
  - dev의 `logRef` `<pre>` 렌더는 채택 안 함 (선언 자체가 claudecode에서 제거됨; 가상화가 상위 호환)
- Claude inbound 패널(`claudeEntries`)은 auto-merge로 무손실 유지. injection 스트림 토글 + claude 디버그 플래그 공존 확인.

## 의미 충돌 (테스트/린트로 발견, ac2e7f7)

1. **SSRF 정책 (#96) vs claude 테스트 픽스처** — 전체 스위트 14 fail (베이스라인 47cae4df는 통과, 워크트리로 검증). dev의 `destination-policy`가 localhost baseUrl 프로바이더를 거부 → 픽스처 config가 default로 폴백 → 401/403 어긋남. 해소: 5개 픽스처에 `allowPrivateNetwork: true` (dev 자체 테스트와 동일 패턴).
   - tests/claude-messages-endpoint.test.ts (mock + native upstream)
   - tests/claude-models-discovery.test.ts, claude-native-passthrough.test.ts, claude-management-api.test.ts
2. **lint 강화 (#99) vs ClaudeCode.tsx** — `react-hooks/set-state-in-effect` 에러 1건. 해소: Models/Usage와 동일한 `setTimeout(0)` 지연 로드 패턴.

## 검증 게이트 결과 (전부 로컬 통과)

| 게이트 | 결과 |
|--------|------|
| bun x tsc --noEmit | exit 0 |
| bun test --isolate | 2344 pass / 0 fail (222 files) |
| bun run privacy:scan | passed |
| GUI lint | 0 errors / 3 warnings (기존 virtualizer·exhaustive-deps 패턴과 동일) |
| GUI build | ✓ built |
| release.ts bun build | ✓ 9.24 KB |
| CLI smoke `bun run src/cli/index.ts help` | ok |
| npm pack + 격리 prefix 글로벌 설치 + ocx help | ok (gui/dist 45파일 포함) |

글로벌 설치 스모크는 사용자의 실제 글로벌 ocx를 건드리지 않도록 `--prefix /tmp/ocx-smoke`로 격리 실행.

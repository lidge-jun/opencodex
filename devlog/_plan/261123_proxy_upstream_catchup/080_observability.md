# 080 — 관측성: Claude Code statusline, 운영 알림, 네이티브 세션 사용량, 읽기 전용 관리 MCP

**Gaps:** G-029, G-030, G-032, G-033
**Depends on:** 070
**Size:** L

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

Claude Code 사용자가 statusline에서 현재 세션의 실제 대상과 quota를 본다. 운영자는 실패·지연·429 임계치 알림을 켤 수 있고, proxy를 거치지 않은 네이티브 Codex/Claude 세션 사용량도 출처 표시와 함께 본다. 관리 권한이 있는 에이전트는 읽기 전용 MCP로 health·usage·키 metadata를 조회한다.

## Why

- **G-029** — magpie는 Claude Code statusline에 route와 quota/cache를 보여 준다 (`006` L6-2). OpenCodex에는 quota와 usage 읽기가 있으나(`ocx:src/server/hub-usage.ts:10`) statusline 연결이 없다.
- **G-030** — sub2api는 규칙·이벤트·silence를 갖는다 (`005` L5-3). OpenCodex는 metrics export만 있다(`ocx:src/server/request-metrics.ts:15`).
- **G-032** — cc-switch는 proxy 밖 세션 파일에서 비용을 집계한다 (`003` L3-5).
- **G-033** — sub2api는 관리 MCP를 제공한다(`s2a:backend/internal/server/routes/mcp.go:28`) (`005` L5-5). OpenCodex는 CLI와 `skills/ocx/`로 같은 정보를 준다(`ocx:skills/ocx/SKILL.md:174`).
- **G-031**은 CLOSED다: `/api/request-history`와 `/api/logs`가 cursor 조회를 이미 제공한다 (감사 r1 #2).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/server/statusline-route.ts` | NEW | 인증된 키로 `{route:{provider, model}, quota:{window, remainingPct}}`. 기존 snapshot만 읽고 vendor probe 없음 |
| `src/providers/quota-snapshot-read.ts` | NEW | snapshot 읽기 helper. `src/providers/quota.ts`는 캡 558줄에 닿아 있어 수정하지 않는다 |
| `src/cli/claude-statusline.ts` | NEW | `ocx claude statusline install\|uninstall`, 기존 statusline 보존·복원 |
| `src/cli/claude.ts` | MODIFY | 970줄. 하위 명령 등록 한 줄 (명령 진입 `cmdClaude` `ocx:src/cli/claude.ts:849`) |
| `src/server/ops-alerts.ts` | NEW | metrics window 임계치, 소음 억제, 회복 상태. 기본 off. 외부 webhook은 명시 설정 |
| `src/server/request-metrics.ts` | MODIFY | 프로토콜·결과 분류(`ocx:src/server/request-metrics.ts:15`)를 ops-alerts가 구독하도록 listener 노출 |
| `src/usage/native-session-import.ts` | NEW | 사용자가 지정한 세션 디렉터리를 metadata만 읽음. 요청 경로 밖, 중복 식별, 추정치 표시 |
| `src/server/management/mcp-readonly.ts` | NEW | health·usage·키 metadata 3개 tool. 관리 권한 필요, inference 키 거부, 070 감사 기록 |
| `skills/ocx/SKILL.md` | MODIFY | 새 CLI 표면 (`ocx:skills/ocx/SKILL.md:174` 섹션) 문서와 `bun run skill:surface` |

### Before / After

`ocx:src/cli/claude.ts:849` — `ocx claude`는 하위 명령 없이 바로 실행 경로로 간다.

```ts
// before
export async function cmdClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  const clientState = readClientConnectionState();
  /* preflight → native 또는 proxy 실행 */
```

```ts
// after (sketch)
export async function cmdClaude(args: string[]): Promise<number> {
  if (args[0] === "statusline") return cmdClaudeStatusline(args.slice(1)); // install | uninstall, claude-statusline.ts
  const config = loadConfig();
  /* 기존 그대로 */
```

## Dependencies

070. statusline 데이터 범위는 키 정책을 따르고, 관리 MCP 호출은 070 감사 이벤트를 남긴다.

## Acceptance

- statusline 설치 뒤 Claude Code 하단에 현재 route와 quota가 보이고, uninstall하면 이전 statusline 설정이 복원된다. 출력에 email·credential이 없다.
- 알림 fixture: 429 비율이 임계치를 넘는 metrics 시퀀스에서 알림이 한 번 발생하고, 정상 시퀀스가 이어지면 회복 이벤트가 한 번 발생한다. 알림을 켜지 않으면 타이머와 외부 전송이 없다.
- 네이티브 세션 사용량은 "proxy 밖" 출처로 따로 표시되고 proxy usage와 이중 집계되지 않는다.
- 관리 키로 MCP의 세 tool을 읽을 수 있고, inference 전용 키는 거부된다. 쓰기 tool은 없다.

## Verification

- 신규 `tests/server/statusline-route.test.ts`, `tests/cli/claude-statusline.test.ts`, `tests/server/ops-alerts.test.ts`, `tests/usage/native-session-import.test.ts`, `tests/server/mcp-readonly.test.ts`
- `tests/ci-workflows/skill-ocx.test.ts` (`bun run skill:surface:check`)
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `src/providers/quota.ts`는 캡 558줄에 닿아 있어 한 줄도 늘릴 수 없다. `usage/log.ts` 1965줄.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다. 관리 MCP 모듈은 `management-api.ts`가 namespace별로 지연 로드해야 한다. 알림 타이머는 opt-in 활성화 때만 시작한다.
- **Privacy:** 네이티브 세션 import는 본문을 읽지 않는다.

## Non-goals

- 범용 세션 매니저 (G-055 비채택), 관리 쓰기 MCP, 새 usage export API (G-031 CLOSED).

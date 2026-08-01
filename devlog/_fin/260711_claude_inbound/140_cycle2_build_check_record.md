# 140 — 사이클 2 B/C 기록: 컨텍스트/effort 레버 구현

## 구현 델타 (B, Pro 답변 138 반영 포함)

| 항목 | 파일 | 내용 |
|------|------|------|
| B5 config | `src/claude/desktop-3p.ts` | 3값 모드(static 기본/hybrid/discovery), `supports1m`(authoritative contextWindow>=1M만), routed DTO `{provider,id,contextWindow?}`, `parseDesktop3pModeArgs`(상호배타+미지 플래그 거부) |
| B5 CLI | `src/cli/index.ts` | `ocx claude desktop [--static|--hybrid|--discovery-only]`, 1M 행 안내 문구, contextWindow 전달(호출자 3곳) |
| B6 launcher | `src/cli/claude.ts` | opt-in `alwaysEnableEffort`→ALWAYS_ENABLE_EFFORT=1, `maxContextTokens`→MAX_CONTEXT_TOKENS+`DISABLE_COMPACT=1` 쌍(공식 변수명), user-wins |
| B6 systemEnv | `src/server/system-env.ts` | 레버 키 user-wins 스킵+실주입만 추적, shell 파일 조건부 export(`${VAR+x}`) |
| B6 API/GUI | `management-api.ts`, `ClaudeCode.tsx`, i18n×4 | maxContextTokens(양의 정수/null clear 검증)·alwaysEnableEffort 왕복, 쉬운 어휘 + compaction 경고 |
| 안전판 | `src/server/claude-messages.ts` | supportedLadderFor===[]일 때만 reasoning 제거(unknown 통과) |
| [1m] 방어 | `inbound.ts`, `claude-messages.ts` | 모델 id 잔류 `[1m]` 스트립(messages/count_tokens/resolve) |
| 캡처 확장 | `inbound-debug.ts`, `Debug.tsx` | `anthropic-beta` 헤더 기록+표 컬럼(1M/effort beta 실측용) |

## 검증 (C)
- `bun x tsc --noEmit` 클린, `bun test` **2213 pass / 0 fail** (9384 expect), gui build 성공.
- 활성화 증거: desktop-3p(모드 4분기+supports1m 경계+파서 5분기), claude-cli(레버 4분기),
  system-env(주입/user-wins/조건부 export 3케이스), management-api(검증 5케이스+왕복),
  claude-messages(ladder [] 제거 / unknown 보존 / [1m] 스트립 3테스트), inbound-debug(beta 캡처).

## 사용자 적용 절차 (Pro 검증 매트릭스, 138 §6)
1. `ocx stop && ocx start` → `ocx claude desktop` (이제 정적 목록 + supports1m 기본)
2. Claude Desktop 완전 종료 후 재시작 (3P 설정은 실행 시 1회 로드)
3. 피커에서 별칭 모델 선택 → effort를 **low로** 바꿔 메시지 1개, **max로** 바꿔 1개
   (high는 기본값=필드 생략이라 판정 불가) → GUI Debug의 Claude 인바운드 표에서
   `output_config.effort` 도달 확인
4. 1M: 피커에서 [1M] 붙은 별도 행을 직접 선택 → 캡처 표 beta 컬럼에
   `context-1m-2025-08-07` 확인 + /context ≈ 1M 확인
5. 새 세션에서 1M 유지되는지 확인 (미유지면 알려진 Desktop 결함 — 프록시로 못 고침)

## 잔여/미확정
- Desktop이 별칭에 effort UI를 여는 정확한 조건은 여전히 비공개(빌드 의존). 정적 목록 전환 후에도
  안 뜨면: (a) exact `claude-opus-4-8` bare id 별칭 실험(라우팅은 프로필로 구분), (b) effort별
  정적 항목(…-low/-high/-max) fallback — 둘 다 다음 사이클 후보.
- Desktop 프로세스의 CLAUDE_CODE_* env 소비는 비보장(진단: launchctl setenv 후 open -a Claude).

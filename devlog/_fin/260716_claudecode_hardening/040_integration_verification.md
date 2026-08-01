# 040 — 통합 검증

## 목표

010–030이 합쳐진 상태에서 회귀 없음과 조건 경로 발화를 증명하고, 라이브 반영
절차를 사용자 결정 항목으로 정리한다.

## 작업 (NEW 코드 없음 — 검증/문서/커밋만)

1. **전체 스위트**: `bun test --isolate ./tests/` exit 0 (cr4). 출력 tail을 attest에.
2. **activation 재확인**: 010/020/030 각 테스트가 실제 조건 경로를 발화시키는지
   테스트 본문 기준으로 점검 (mock 5xx 주입 → 재시도 카운트 / 529 봉투 / jsonl 필드).
3. **격리 홈 + 임시 포트 스모크** (cr5, 감사 blocker #4 + WP4-P 수정): 라이브
   ocx(10100, 이 세션 자신이 경유 중)는 건드리지 않는다. `ocx start`는
   pid/runtime-port 덮어쓰기(cli/index.ts:136-139)에 **더해 Codex 설정 인젝션 등
   공유 상태 부작용**이 있으므로 스모크에 사용하지 않는다. 대신 e2e 테스트와 동일한
   `startServer()` 직접 부팅:
   - `OPENCODEX_HOME=$(mktemp -d)` **+ `CODEX_HOME=$(mktemp -d)`(선-생성 필수 —
     paths.ts:26이 모듈 로드 시 1회 해석하고 부재 시 throw)** 격리: startServer()는
     index.ts:185에서 `invalidateCodexModelsCache()`를 불러 `$CODEX_HOME/models_cache.json`
     을 재작성하므로(재감사 blocker) CODEX_HOME 미격리 시 라이브 `~/.codex` 오염.
     빈 CODEX_HOME이면 catalog 부재로 early-return.
   - mock upstream(Bun.serve, 502→200 시나리오) + `startServer(0)`(EADDRINUSE 재시도
     없음 — 고정 포트 대신 0으로 바인드 후 server.url 사용, e2e 테스트 선례)
   - 설정 형태는 tests/claude-529-mapping.test.ts의 nativeConfig+saveConfig 선례 재사용
  - `curl -s localhost:10199/healthz` → ok, `/v1/messages` 1회 → 529 재분류 또는
    200 정상 응답 확인 (cr1/cr2 e2e 재확인 겸함)
   - 종료(프로세스 kill) + tmpdir 삭제. 라이브 10100의 runtime-port.json/ocx.pid
     **및 `~/.codex/models_cache.json` mtime**이 변하지 않았음을 종료 후 확인.
4. **커밋 정리**: WP별 로컬 커밋이 쌓였는지 확인(commit-as-you-go), push 없음.
5. **NEEDS_HUMAN 보고 항목** (wp4-t3): 라이브 프록시(10100) 재시작은 이 세션의
   전송로를 끊으므로 자동 수행 금지. 최종 보고에 "다음 유휴 시점에 `ocx` 재시작
   필요 — 그 전까지 라이브 트래픽은 구버전 동작" 명시.

## Accept criteria

- cr4: 전체 스위트 exit 0 출력 tail 캡처.
- cr5: 스모크 커맨드 + 응답 요약 캡처 (또는 BLOCKED 사유).
- goalplan cr1~cr3의 capturedEvidence가 모두 채워져 있음을 교차 확인.
- D 클로즈에 LOOP-PESSIMIST-01: 안 된 것(미검증 잔여 — Claude Code의 mid-stream
  overloaded 재시도 여부, 라이브 미반영)을 명시.

# 135 — 조사: CCR/LiteLLM의 Desktop effort·1M 처리 (Bohr/Dirac, sol high + cxc-search)

증상(사용자 실측): discovery 모드 전환 후에도 Desktop에서 effort UI는 opus 계열 id에만 뜨고,
컨텍스트는 200k로 고정.

## 확정 사실 (Tier 2)

### 클라이언트가 뭘 읽는가
- **Claude Code 공식 게이트웨이 프로토콜 명세**: `/v1/models`에서 **`id`와 `display_name`만
  읽는다** — capabilities/max_input_tokens는 무시. (code.claude.com/docs/en/llm-gateway-protocol)
  → 우리 B4b(ModelInfo capabilities 광고)는 CLI에 무효, Desktop에도 증거 없음.
- effort는 모델 id의 내장 패턴 매칭. custom id에 effort를 강제하는 공식 env:
  **`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`** (+ `CLAUDE_CODE_EFFORT_LEVEL`, settings `effortLevel`).
- 컨텍스트 공식 env: **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** (custom id는 이걸로 직접 override,
  인식된 claude id는 `CLAUDE_CODE_DISABLE_COMPACT=1`도 필요). 1M variant는 `[1m]` suffix +
  `anthropic-beta: context-1m-2025-08-07` (Claude Code가 suffix를 벗기고 beta 헤더로 전송).
- Desktop 200k 고정 독립 재현: anthropics/claude-code#55504 (`claude-opus-4-7[1m]`인데 /context 200K).

### CCR (musistudio/claude-code-router @9cd0aab)
- 비-Claude 모델 id를 `claude-ccr-h{hex}` 형태로 위장 (우리 opus-4-8-{code}와 동일 발상).
- **Desktop 주입 경로는 configLibrary 직접 기록**: `inferenceModels: [{name, labelOverride,
  supports1m?}]` **그리고 동시에** `modelDiscoveryEnabled: true`. capabilities가 아니라
  **`supports1m`이 1M 신호**.
- `[1m]` suffix 인식/제거 로직 존재. context-1m beta 헤더는 합성하지 않고 통과만.
- ModelInfo형 /v1/models 빌더(createClaudeCodeModelsResponse)는 존재하나 지정 커밋에서 dead code로 보임.

### LiteLLM (@a4199d3)
- 루트 /v1/models는 OpenAI형 목록(참고 부적합). Anthropic ModelInfo 완전형은 SDK가 기준.
- `reasoning_effort` ↔ adaptive `thinking`+`output_config.effort` 양방향 변환 구현
  (max→xhigh→high 강등 테이블, legacy budget 버킷 low1024/med2048/high4096/xhigh8192/max16384).
- `[1m]`은 클라이언트(Claude Code)가 벗겨서 beta 헤더로 보낸다고 문서화.
- CC Switch(cc-switch)도 Desktop 목록에 `supports1m`을 직접 기록.

## 진단 (수렴)
- Desktop의 effort UI/컨텍스트는 **id 내장 카탈로그 매칭**이 지배. `/v1/models` capabilities를
  읽는다는 증거는 어디에도 없음 (CLI는 공식 반증). → B4b는 무해하지만 무효.
- 1M의 공식 제어점은 **정적 `inferenceModels[].supports1m`** — discovery 목록으로는 전달 불가.
  CCR처럼 **정적 목록 + modelDiscoveryEnabled:true 병기**가 실전 패턴.
- CLI 쪽 effort/컨텍스트는 env로 직접 제어 가능:
  `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.

## 남은 미확정 (Pro 질의 대상)
- Desktop이 discovery(자동 발견) 항목에도 supports1m 상당을 적용할 방법이 있는가.
- Desktop 200k 고정(#55504)이 supports1m로 실제 뚫리는가, 표시만 바뀌는가.
- Desktop에서 [1m] 선택 시 wire에 뭐가 실리는가 (suffix vs beta 헤더).

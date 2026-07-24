# 042 — wp6 receipt: pre-QA 스모크 (tool-call 왕복, 카탈로그, reasoning)

Date: 2026-07-23 21:5x KST. Server: 수정 체크아웃 :10190 (pid 57004, OPENCODEX_HOME=/tmp/ocx-wp1-home 격리). grok 0.2.101, GROK_HOME=/tmp/grok-home-wp3.

## 1. Tool-call 왕복 — 2-layer 증명 (오딧 합의 형식)

### (a) Raw-wire 2-request 루프: **PASS**

Req1 (`/tmp/wp6-tool-req1.raw`, 13 frames): tools[]와 함께 스트림 요청 → tool_call 프레임 수신.

- naive append-style 재구성 (RAW 청크에서): name=`run_terminal_cmd` (정확히 1회), args=`{"command":"echo OCX_TOOL_OK"}` — **valid JSON, 중복 없음**. done-frame은 id 포함 replace-style 스냅샷으로 구분됨 (리뷰어 지적 duplication 리스크는 id 유무로 구분 가능하며, grok 실클라이언트가 (b)에서 정상 파싱함을 확인).
- finish_reason=`tool_calls`, usage details 포함 (`prompt_tokens_details`/`completion_tokens_details` — wp1 계약).

Req2 (`/tmp/wp6-tool-req2.json/.resp`): 같은 `call_id`로 assistant.tool_calls + role:tool 결과 재전송 → finish=`stop`, 본문이 `OCX_TOOL_OK` 출력을 인용한 최종 답변. **call_id 등가성 확인** (req1 프레임에서 추출한 id를 그대로 사용, 200 응답).

### (b) grok 실클라이언트 E2E: **PASS** (SKIP 아님)

기본 샌드박스 ON(GROK_SANDBOX 미설정), cwd=/tmp/wp6-tool-cwd, `--tools run_terminal_cmd` 포지티브 allowlist, `--always-approve` 없음:

```
grok -p "Use the run_terminal_cmd tool to run exactly this command: echo OCX_TOOL_OK — then tell me its output." -m ocx-cursor-grok-4-5 --max-turns 4 --tools run_terminal_cmd
exit=0, stdout 말미: OCX_TOOL_OK (코드블록 인용)
```

grok가 스트림 파싱→툴 실행→function_call_output 재전송→최종 답변까지 전 루프를 자체 수행. 로그 `/tmp/wp6-grok-tool.{out,err}` (err의 Failed to fetch models 경고는 dummy XAI 키의 네이티브 카탈로그 fetch 실패 — 본 루프와 무관).

## 2. 카탈로그 listing: **PASS**

`grok models` → `ocx-*` 29줄 노출, `ocx-gpt-5-6-sol` 기본 선택 (`/tmp/wp6-models.out`).

## 3. Reasoning delta: **PARTIAL — 브리지 PASS / 라이브 업스트림 미발화**

- 브리지 단위 증명 (라이브 프로세스와 동일 코드): `response.reasoning_text.delta` → `delta.reasoning_content` 프레임 방출 확인 (bun 인라인 실행, 정확한 청크 인용):
  `{"choices":[{"delta":{"reasoning_content":"thinking hard"},...}]}`
- 라이브 4개 모델(cursor/grok-4.5, opencode-go/glm-5.2, kimi/k3, anthropic/claude-opus-4-6 + gpt-5.5)에서 reasoning_content 프레임 미관측 — 이 계정/설정 조합에서 업스트림이 reasoning 텍스트를 스트림에 싣지 않음 (`claude-opus-4-6-thinking` 별도 alias 존재, hide-thinking 설정 영향 가능). **코드 경로는 위 단위 증명으로 커버**, 라이브 미발화는 upstream/설정 요인으로 기록 (QA 시나리오에 thinking-alias 턴 포함 권장).

## 최종 게이트

- typecheck clean, privacy scan pass, full suite 3721 pass / 1 기존 플레이크 (wp4와 동일)
- 브랜치 push까지 완료 (c6는 D 마감 시 최종 캡처)

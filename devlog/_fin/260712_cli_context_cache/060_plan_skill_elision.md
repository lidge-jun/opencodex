# 060 — diff-level 플랜: 라우팅 모델용 번들 스킬 본문 프록시 차단 (blockedSkills)

## Loop-spec (C1-C2, 단일 work-phase, HITL)
- Trigger: 사용자 — "permissions deny 상당을 프로바이더 단에서 막아봐, 타사 모델은
  학습이 안 된 것 같으니까". 근거: claude-api 번들 스킬 719k자(~136k tok) 주입 실측
  (33.7k→170k) + GitHub #74473/#63566/#69164/#43816(not planned) — 클라이언트단 수정 없음.
- Goal: 라우팅(비-Anthropic) 모델로 가는 요청에서 차단 목록 스킬의 tool_result 본문을
  짧은 스텁으로 치환. Anthropic 네이티브 패스스루는 번역 미경유 → 자동 무영향.
- Non-goals: 클라이언트 settings.json 수정, 스킬 tool_use 자체 제거(페어링 파괴 금지),
  tools 스키마 필터링.

## 설계
- `claudeCode.blockedSkills?: string[]` — 기본 `["claude-api"]`, `[]`는 명시적 off.
- 판정: assistant 메시지의 `tool_use(name==="Skill")` 중 input JSON(소문자)에 차단명이
  포함되면 해당 call_id 수집 → 대응 tool_result의 output을 스텁 문자열로 치환.
  function_call_output 항목 자체는 유지(페어링 보존).
- count_tokens 추정은 원문 기준 유지(과대 추정 = 이른 컴팩션 = 안전 방향, 기록).
- 캐시: system/tools 불변이라 코호트 키 무영향, 프리픽스는 매 턴 일관 치환.

## Diff
1. types.ts blockedSkills + doc / 2. inbound.ts 수집·치환 / 3. management-api GET/PUT
   (문자열 배열 검증, null→기본 복귀) / 4. 테스트(기본 차단·비대상 보존·[] off·API 왕복) /
   5. docs 3로케일.

## 게이트
tsc / bun test / (GUI 무변경) / 라이브: claude-api 로드된 세션에서 ctx 급감 확인은 HOTL 사용자.

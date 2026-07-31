# 071 — 감사 합성: 에이전트 주입 (Kant/sol, VERDICT FAIL → 전건 수용)

| # | 심각도 | 지적 | 처분 |
|---|---|---|---|
| 1 | High(블로킹) | self를 claudeCode.model에서 유도하면 실제 세션 모델과 어긋남 (--model/ANTHROPIC_MODEL 우선) | 수용(설계 교체) — Kant 실측: frontmatter `model:`은 `inherit` 허용. ocx-self는 항상 `model: "inherit"`로 생성 → 진짜 자기복제, dedup 자체가 불필요 (#4 동시 해소) |
| 2 | High(블로킹) | 접두만으로는 소유 증명 불가 (사용자 동명 파일/심링크 덮어쓰기 위험) | 수용 — 본문에 generated-by 마커, 덮기/제거 전 lstat(심링크 스킵)+마커 검증, tmp+rename 원자 교체, 마커 없는 ocx-* 파일은 불가침(해당 def 스킵) |
| 3 | High(블로킹) | OFF 전환/비활성화 시 잔존 정의가 계속 로드됨 | 수용 — injectAgents=false 또는 claudeCode.enabled=false면 소유 검증된 파일 prune(빈 defs sync). 프록시 stop은 보존(무해, docs 명시) |
| 4 | Med | self dedup에 canonical route 동일성 필요 | #1의 inherit 전환으로 소멸 (roster 내부 dedup은 동형 별칭 비교로 충분) |
| 5 | Med | systemEnv가 윈도우 맵 재획득(+3s) | 수용 — computeEffectiveModelEnv → {modelEnv, windows} 반환으로 리팩터, 재사용 |
| 6 | Med | 구버전 config 첫 실행에서 기본 로스터 누락 | 수용 — builder에서 undefined → DEFAULT_SUBAGENT_MODELS, 명시적 []는 존중 |
| 7 | Med | false-green 테스트 | 수용 — 마커 소유/심링크 스킵/disabled prune/inherit self/기본 시딩/frontmatter 파스 검증 추가 |

Kant 실측 보너스: name·description 필수, tools 선택, model은 풀 id 또는 `inherit`,
name 선두 `-`만 거부, `[1m]` 포함 비인용 스칼라도 파스됨(그래도 전 스칼라 JSON-quote 유지).

# 40 — 프로덕션 하드닝 + 히어로 + 문서 플랜 (골 2)

골플랜: `.codexclaw/goalplans/claudecode-docs-site-codex-claude-claude-code-3/`
병렬 파견: Goodall(sol high, src/claude 프로덕션 갭 감사) / Parfit(sol high, 문서 그라운딩 추출)

## wp1 — 히어로 원통 회전 Design Read (cxc-dev-uiux-design)

```yaml
---
name: opencodex docs-site landing
colors:
  primary: "#0d0d0d / #f4f4f4 (테마 반전)"
  accent: "#D97757 (Claude terracotta, 회전 면 전용 틴트)"
  background: "photographic hero field (기존 유지)"
typography:
  heading: { fontFamily: 기존 grotesk 상속, fontSize: "clamp(2.25rem, 5.5vw, 4rem)" }
---
```

Reading this as: 개발자 도구 프록시의 문서 사이트 랜딩, Codex/Claude Code 파워유저 대상,
이미 확립된 Liquid Editorial(type-led hero + scene stack) 언어. 이번 추가는 "제품 단어
자체가 회전하는 드럼" — 프록시가 Codex와 Claude 둘 다를 서빙한다는 사실을 히어로 첫 문장이
직접 수행(perform)하게 만든다.

Do's: H1 문장 안의 제품명 슬롯만 회전. 고정 슬롯 폭(inline-grid 스택)으로 CLS 0.
Don'ts: 히어로 전체 3D 기울임, 새 그라데이션, 회전 속도 과다(어지러움).

```
DESIGN_VARIANCE: 7 (기존 랜딩 유지)
MOTION_INTENSITY: 6 (기존 scene-stack 유지, 드럼이 signature moment로 편입 — 총량 불변)
Product density profile: D2
Reasoning: 이미 스크럽 캔버스/키네틱 타이포가 있는 마케팅 랜딩. 드럼은 기존 signature 예산 안에서
히어로로 이동하는 것이지 모션 추가가 아님.
```

### 구현 스펙

- 마크업: `<span class="lp-drum">` (inline-grid, 모든 face가 grid-area 1/1 → 슬롯 폭 = 최장 단어 "Claude")
  안에 4-face 드럼 `<span class="lp-drum-spin">`: Codex / Claude / Codex / Claude.
  faces는 rotateX(0/-90/-180/-270) translateZ(r). r ≈ 0.62em.
- 애니메이션: 12s 무한. 홀드-회전-홀드 키프레임(각 스텝 -90°, easing cubic). GPU 전용
  속성(transform)만 사용, will-change 없음(상시 애니메이션이라 불필요).
- Claude face 틴트: 라이트/다크 대비 검증한 terracotta 계열. Codex face는 상속색.
- 접근성: 드럼은 aria-hidden, 슬롯에 시각적 숨김 텍스트 "Codex and Claude" 제공.
  `prefers-reduced-motion: reduce` → 애니메이션 제거 + 정적 "Codex · Claude" 표기.
- 3로케일 문장: en "Run [drum] on any LLM." / ko "[drum]를 어떤 LLM 위에서든." /
  zh "让 [drum] 跑在任意 LLM 上。" (드럼 단어는 3로케일 공통 라틴)
- 부수 카피: 서브카피에 Claude Code 언급 추가, 벤토에 Claude Code 셀 추가,
  docsMap Guides에 Claude Code 링크 추가.
- 검증: astro build + 스크린샷(데스크톱 1440/모바일 390, en/ko, 라이트/다크 중 대표) +
  reduced-motion 에뮬레이션 스크린샷.

## wp2 — 문서 (Parfit 그라운딩 수령 후)

guides/claude-code.md를 인바운드 변환 계약 / 별칭·해시 / auto-context / 로스터 에이전트 /
스킬 엘리전 / 캐시·사용량 / 디버그 / systemEnv 라이프사이클 / 트러블슈팅 축으로 확장.
en 확장 → ko/zh 동기화 → sol 불일치 감사.

## wp3 — 하드닝 (Goodall 리포트 수령 후)

BLOCKER/MAJOR 전부 수리 + 항목별 테스트. 이후 전체 게이트 + 푸시 + CI.

# 011 — wp2 조사 결과 (6레인 병렬, 2026-09-13)

## zai / GLM — verified (docs.z.ai/guides/overview/pricing, USD/1M)

| model | in | out | cacheRead | 비고 |
|---|---|---|---|---|
| glm-4.5 | 0.60 | 2.20 | 0.11 | 등재 불요(노출 표면 없음) |
| glm-4.5-air | 0.20 | 1.10 | 0.03 | 상동 |
| glm-4.5-flash | Free | | | zero 행은 inert — 미등재 |
| glm-4.5v | 0.60 | 1.80 | 0.11 | 미등재(노출 표면 없음) |
| glm-4.6 | 0.60 | 2.20 | 0.11 | 등재 |
| glm-4.6v | 0.30 | 0.90 | 0.05 | 등재 |
| glm-4.7 | 0.60 | 2.20 | 0.11 | 등재 |
| glm-4.7-flash | Free | | | 미등재 |
| glm-5 | 1.00 | 3.20 | 0.20 | 등재 |
| glm-5-turbo | ¥5 | ¥22 | ¥1.2 | bigmodel.cn CNY 전용 → hold (xiaomi 선례) |
| glm-5.1 | 1.40 | 4.40 | 0.26 | 등재 |
| glm-5.2 | 1.40 | 4.40 | 0.26 | 등재 |
| glm-5.3 | 1.40 | 4.40 | 0.26 | 등재 |
| glm-5v-turbo | ¥5 | ¥22 | ¥1.2 | CNY 전용 → hold |
| glm-5.3-flash | 0.15 | 0.50 | 0.03 | 등재 |

등재: 4 provider 표면(zai, zhipu-bigmodel, zhipu-bigmodel-coding,
zhipu-bigmodel-responses) × 노출 모델 = 25행, 전부 verified-derived
(구독/CNY 표면에 z.ai 정가를 estimate로 표시). cacheWrite=0 — 양쪽 공식 모두 cache-write 단가 미공개(cache storage는 limited-time free
오픈베타 프로모션). 2026-09-13 스냅샷이며 종료/변경 가능 — 장기 의존 전 재확인 필요.

## google gemma — not-published 전원

ai.google.dev/gemini-api/docs/pricing: Gemma 4 표는 Free Tier "Free of charge" /
Paid Tier "Not available". gemma-4-31b-it, gemma-4-26b-a4b-it만 API 서빙 목록에 있고
나머지 6종은 미서빙. 등재 없음.

## cerebras — not-published (deprecated)

qwen-3-coder-480b(2025-11-05), zai-glm-4.6(2026-01-20) 모두 공식 deprecation,
public models API 404. cerebras.ai/pricing은 gpt-oss-120b/qwen-3.8-27b만 게재.

## mistral — not-published

labs-devstral-small-2512 = Devstral Small 2, 공식 id는 실재하나 모든 가격표에 없음.
deprecated(2026-02-27, 후속 Mistral Medium 3.5).

## xai — not-published (재확인)

grok-composer-2.5-fast: docs.x.ai pricing 16개 모델 카탈로그에 없음.
x.ai/news/composer-2-5 "free to try" 유지.

## openrouter — free 외 전원 not-published

openrouter/free만 $0 verified(API pricing 0/0) — zero 행은 inert라 미등재.
auto는 routed-model pass-through(-1 sentinel), alpha 5종은 endpoint:null/종료.

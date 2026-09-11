# 002 — 출현 지점 집계

`rg` 기준, 2026-09-11 브랜치 `codex/260911-opencode-go-free-stabilization`.

| id | 파일 수 | 히트 수 |
| --- | --- | --- |
| `deepseek-v4-pro` | 62 | 293 |
| `deepseek-v4-flash` | 99 | 585 |

## `DEEPSEEK_THINKING_MODELS` 소비처 (감사 정정)

이 상수(`registry.ts:619`)는 Zen 3종만 먹이는 게 아니다. **6개 프리셋 21곳**이 소비하며, 그중에는 `deepseek` 1st-party 프리셋의 `models:` 배열 자체가 포함된다.

| 프리셋 | 앵커 |
| --- | --- |
| `opencode-go` | 1760, 1768, 1776, 1803, 1813 |
| `deepseek` 1st-party | **2045 (`models:` spread)**, 2114-2121 |
| `alibaba-token-plan` | 2813-2818 |
| `opencode-zen` | 3047-3064 |
| `opencode-free` | 3108 |

이것 때문에 "공유 상수에 V4.1을 추가" 설계는 성립하지 않는다. 020이 상수 분리로 다시 설계됐다.

## v4-pro를 선언하는 프로바이더 (registry.ts)

| 프로바이더 | 성격 | 앵커 |
| --- | --- | --- |
| `deepseek` (1st-party) | **DeepSeek 직접** | 2038-2078 (`modelContextWindows`, `modelWireDefaults`, `modelResponsesTerminalRepair`) |
| `opencode-go` / `opencode-zen` / `opencode-free` | Zen 게이트웨이가 DeepSeek을 되팜 | 619 `DEEPSEEK_THINKING_MODELS`, 1793 |
| `command-code` (OAuth + API key) | 게이트웨이 | 631, 1180-1190, 2305 |
| `alibaba-token-plan` / `-intl` | 벤더 호스팅 | 736, 749, 758, 2832, 2857-2913 |
| `volcengine` ark / coding / agent | 벤더 호스팅, **날짜 스냅샷** `deepseek-v4-pro-260425` | 791, 807, 816, 838, 850, 2785, 2791 |
| `ollama` cloud | 벤더 호스팅 | 2951, 2963 |
| `nvidia-nim` | 벤더 호스팅 | 969 |
| `baseten` | 벤더 호스팅 (`deepseek-ai/DeepSeek-V4-Pro`) | 1010-1059 |
| `cline-pass` | 게이트웨이 | 1144, 1199 |
| `orcarouter` | 게이트웨이 | 1180-1190 |
| `codebuddy` / `qoder` | 게이트웨이 | `codebuddy-models.ts`, `qoder-models.ts` |

## 손대지 않는 영역과 이유

| 영역 | 이유 |
| --- | --- |
| `scripts/model-metadata.source.json` (47건), `src/generated/model-metadata.ts` (3건) | 벤더 스냅샷에서 **생성되는** 파일이다. 손으로 지우면 다음 생성에서 되돌아온다. 게다가 `src/usage/cost.ts`가 과거 요청 비용을 이 표로 계산하므로, 행을 지우면 이미 기록된 사용량의 원가가 깨진다 |
| 임의 fixture id로 v4-pro를 쓰는 테스트 | 레지스트리 멤버십을 주장하지 않는 테스트는 모델 id를 문자열로만 쓴다. 깨지는 것만 고친다 |

## 테스트 영향 예상

감사 정정: 영향 파일은 5개가 아니라 **24개**다. 위 다섯 외에 `tests/routing/router.test.ts:450`(정확 목록), `tests/providers/orcarouter-provider.test.ts:139`, `tests/gui/alibaba-intl-token-plan.test.ts:31`, `tests/routing/fastwire-policy.test.ts`, `tests/codex-integration/slug-codec.test.ts`, `tests/server/adapter-resolve.test.ts` 등이 포함된다.

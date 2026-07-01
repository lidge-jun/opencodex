# parity 분석 인덱스 (3 upstream)

opencodex 프록시 레이어가 따라잡는 세 upstream의 parity 스냅샷. 각 문서는
분석 시점의 upstream HEAD를 박아둔다. 재분석 시 HEAD를 갱신하고 delta만 본다.

## 분석 baseline HEAD (2026-07-01 분석)

| slug | repo | 분석 HEAD | 날짜 | 문서 |
|---|---|---|---|---|
| jawcode (gjc) | `lidge-jun/jawcode` | `27311f6` | 2026-07-01 04:35 | `10_jawcode.md` |
| cli-proxy-api (cca) | `router-for-me/CLIProxyAPI` | `00114be` | 2026-06-29 18:59 | `20_cli-proxy-api.md` |
| litellm | `BerriAI/litellm` | `be4d0d8` | 2026-06-30 12:25 | `30_litellm.md` |

> jawcode 로컬 HEAD는 분석 직후 `a06f814`(docs-only, `docs(chase): close 10.062 → _fin`)로
> 한 커밋 앞섰다. 코드 변경 없음 — 분석 baseline은 마지막 코드 커밋 `27311f6`이 정확하다.

opencodex baseline (분석 시): registry provider **48개**, adapter 종류 6
(`openai-chat`×37, `anthropic`×4, `google`×3, `openai-responses`×2, `kiro`×1, `azure-openai`×1).

## 세 upstream의 성격이 다르다 (parity 축도 다름)

| upstream | 성격 | opencodex와의 관계 | parity 축 |
|---|---|---|---|
| jawcode | TS 멀티-프로바이더 AI 패키지 (47 provider 모듈) | **직접 포팅 출처** (1차 SOT) | provider-by-provider wire/auth 1:1 대조 |
| cli-proxy-api | Go OAuth IDE 프록시 (antigravity/codex/claude/kimi/vertex/xai) | wire/auth/quirks **외부 교차검증** (2차) | executor/translator/signature 동작 대조 |
| litellm | Python 범용 SDK (130 provider 폴더, 모델가격 맵) | 모델 카탈로그/커버리지 폭 **참조** (3차) | provider·model 커버리지 폭, 컨텍스트 윈도우 |

## 분석 방법

- jawcode: 로컬 `/Users/jun/Developer/new/700_projects/jawcode` (clone 불필요)
- cca: `devlog/_chase/_cca/` (shallow clone, gitignored)
- litellm: `devlog/_chase/_litellm/` (shallow clone, gitignored)

클론 디렉터리는 `devlog/` 통째 gitignore로 자동 무시. 노트(`*.md`)만 `git add -f`.

세부는 각 문서 참조.

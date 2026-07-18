# _chase: upstream 따라잡기 노트

opencodex 프록시 레이어가 따라잡는 두 upstream의 추적 노트. 코드를 통째로
vendoring하지 않는다. 실제로 따라잡을 표면은 좁다: API 변환(translator/wire)과
모델명/카탈로그 컨텍스트 두 갈래뿐이라, 무거운 클론 대신 노트 + on-demand 대조로 간다.

## 두 upstream

| slug | repo | 역할 | 로컬 |
|---|---|---|---|
| `gjc` (jawcode) | `lidge-jun/jawcode` (`packages/ai/src/providers/*.ts`) | opencodex 어댑터의 직접 포팅 출처 (1차 SOT) | `/Users/jun/Developer/new/700_projects/jawcode` 에 이미 존재 |
| `cca` | `router-for-me/CLIProxyAPI` (Go) | wire/auth/quirks 외부 교차검증 SOT (2차) | 없음. 필요 시 `_cca/`로 shallow clone |

주의: jawcode는 gajae-code(에이전트)가 아니다. 프록시 프로바이더 레이어는
jawcode에 있고, gajae-code는 별개 코딩 에이전트다.

## Layout

```text
devlog/_chase/
  README.md            # 이 문서 (tracked)
  00_parity-index.md   # 3 upstream parity 인덱스 + 분석 HEAD 기록 (tracked)
  01_overview.md       # chase 정의 · 갭 4종(G1-G4) · 우선순위 (tracked)
  02_gap_inventory.md  # 축별 앞섬/뒤처짐 + 항목별 G-tag·상태 (tracked)
  03_follow_index.md   # 실행 우선순위 Tier 1/2/3 (tracked)
  10_jawcode.md        # gjc parity: provider/wire/model 1:1 대조 (tracked)
  20_cli-proxy-api.md  # cca parity: executor/auth/translator 교차검증 (tracked)
  30_litellm.md        # litellm parity: 카탈로그/커버리지 폭 참조 (tracked)
  _model/              # 모델/provider 현재 구조·변경 절차·upstream delta (tracked docs)
  _gjc/                # (옵션) jawcode 로컬 클론/심볼릭: gitignored
  _cca/                # (옵션) CLIProxyAPI 로컬 클론: gitignored
  _litellm/            # (옵션) litellm 로컬 클론: gitignored
```

## form vs action (jawcode struct_har ↔ chase와 동형)

jawcode는 `struct_har/`(형태 스냅샷, 자동생성)와 `struct_har/chase/`(행동, 수동)를 나눈다.
opencodex는 이미 `structure/`(patched SoT)와 `src/`(코드 정본)가 form 역할을 하므로,
chase는 **행동 레이어만** 둔다.

| form (스냅샷) | action (행동) |
|---|---|
| `10_/20_/30_` dossier + repo `structure/`·`src/` | `01_overview` · `02_gap_inventory` · `03_follow_index` |
| upstream 규모·HEAD·wire 정본 | 갭·다음 경로·완료 기준·우선순위 |

`devlog/` 전체가 root `.gitignore`에서 무시된다. 노트(`*.md`)는 의도적으로
force-add(`git add -f`)해서 추적하고, 클론 디렉터리(`_gjc/`, `_cca/`)는 그대로
무시된 채 둔다.

## 따라잡는 방식 (vendoring 안 함)

두 repo 모두 공개라 `cxc-search` 사다리로 원본을 열어 대조한다. clone은 옵션이다.

1. discover: Tier 1 hosted `web_search`로 해당 영역의 upstream 최신 커밋/파일을 찾는다.
2. prove: 후보 URL(또는 raw 파일)을 열어 실제 wire/모델 목록을 확인한다. 스니펫만으로 확정하지 않는다.
3. diff: opencodex 해당 지점(아래 표)과 동작을 대조하고, 차이를 해당 phase devlog(`_plan/`·`_fin/`)에 file:line 근거로 기록한다.

GitHub raw로 바로 여는 예:

```bash
# CLIProxyAPI translator 한 파일 열기 (clone 없이)
curl -fsSL https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/translator/antigravity/gemini/antigravity_gemini_request.go
```

## (옵션) 로컬 클론

대량 grep이나 file:line 인용이 잦아지면 그때만 shallow clone 한다. 자동으로 무시된다.

```bash
# cca: 로컬에 없으므로 필요 시
git clone --depth 1 https://github.com/router-for-me/CLIProxyAPI devlog/_chase/_cca

# gjc: 이미 워크스페이스에 있어 보통 심볼릭이면 충분
ln -s /Users/jun/Developer/new/700_projects/jawcode devlog/_chase/_gjc
```

착수/대조 전 최신화:

```bash
git -C devlog/_chase/_cca fetch origin && git -C devlog/_chase/_cca log -1 --oneline
git -C /Users/jun/Developer/new/700_projects/jawcode fetch origin && \
  git -C /Users/jun/Developer/new/700_projects/jawcode log -1 --oneline
```

## opencodex 대조 표면 (따라잡을 지점)

| 표면 | opencodex | gjc(jawcode) | cca(CLIProxyAPI) |
|---|---|---|---|
| API 변환 (Google/Antigravity) | `src/adapters/google.ts`, `google-antigravity-wire.ts`, `google-antigravity-replay.ts` | `packages/ai/src/providers/*.ts` | `internal/translator/antigravity/**`, `internal/runtime/executor/antigravity_executor.go` |
| API 변환 (Kiro) | `src/adapters/kiro*.ts` | `packages/ai/src/providers/amazon-bedrock.ts` 등 | (없음) |
| auth/refresh | `src/oauth/*`, `src/lib/gcp-adc.ts` | jawcode oauth utils | `internal/auth/**` |
| 모델/카탈로그 | `src/providers/antigravity-models.ts`, `kiro-models.ts`, `src/codex/catalog.ts` | jawcode `models.json` + static lists | `cmd/fetch_antigravity_models/main.go` |

모델/provider 변경 전에는 `_model/README.md`를 먼저 읽는다. upstream 비교의 상세
file:line은 `10_jawcode.md`(gjc), `20_cli-proxy-api.md`(cca) 참고.

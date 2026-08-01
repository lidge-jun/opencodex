# Phase 4: 하드닝 — 팝업 확대 + CLI 커스텀 모델 커맨드 + --help 갱신

## 1. gui/src/styles.css — 팝업 확대

`.model-tip` 블록 교체:

| 속성 | 기존 | 신규 |
|------|------|------|
| min-width | 220px | 320px |
| max-width | 320px | 480px |
| max-height | 280px | 360px |
| padding | 8px 12px | 12px 16px |
| font-size | var(--text-label) (12px) | var(--text-control) (13px) |
| border-radius | var(--radius-sm) (8px) | var(--radius) (12px) |

`.model-tip-id`: font-size var(--text-body) (14px) 추가
`.model-tip-val`: font-size var(--text-label) (12px)로 상향 (기존 text-caption 11px)
`.model-tip-grid`: gap 4px 16px (기존 2px 12px)
`.model-tip-actions`: margin-top 8px, padding-top 8px

## 2. gui/src/pages/Models.tsx — flip-up 상수 동기화

`tipTop + 280 > window.innerHeight` → `tipTop + 360 > window.innerHeight`

## 3. src/cli/models.ts — 커스텀 모델 서브커맨드

### 3.1 서브커맨드 디스패치

`handleModels(args)` 진입 시 첫 인자로 분기:
- `add` → handleCustomAdd(rest)
- `remove` → handleCustomRemove(rest)
- `list-custom` → handleCustomList(rest)
- 그 외 → 기존 list 로직 (호환 유지)

### 3.2 ocx models add

```
ocx models add <provider> <modelId> [--display-name <name>] [--context-window <tokens>] [--modalities text,image,audio]
```

검증:
- provider: isValidProviderName + hasOwnProvider(config.providers) — 실패 시 exit 1
- modelId: 비어있지 않음, 슬래시 불가 — 실패 시 exit 1
- displayName: 슬래시 불가
- contextWindow: 양의 정수
- modalities: 쉼표 분리, text|image|audio만 허용
- 중복: routedSlug(provider, modelId) 기준 기존 customModels와 비교 — 중복 시 exit 1

동작: randomUUID()로 id 생성 → config.customModels에 push → saveConfig → 프록시 생존 시 syncModelsToCodex(live.port) (best-effort, 실패핸들러 경고만) → 성공 메시지 출력

### 3.3 ocx models remove

```
ocx models remove <customId|provider/modelId> [--yes]
```

- 인자가 UUID 형식이면 id 매치, 슬래시 포함이면 routedSlug 매치
- 매치 없으면 exit 1 "not found"
- TTY이고 --yes 없으면 확인 프롬프트 (readline)
- 비TTY + --yes 없음 → exit 1 "re-run with --yes"
- 삭제 후 saveConfig + syncModelsToCodex best-effort

### 3.4 ocx models list-custom

```
ocx models list-custom [--json]
```

- 기본: 프로바이더별 그룹 표로 출력 (id 단축 8자, modelId, displayName, contextWindow k, modalities)
- --json: 전체 배열 JSON 출력

### 3.5 공통

- `import { randomUUID } from "node:crypto"`
- `import { routedSlug } from "../providers/slug-codec"`
- `import { isValidProviderName, hasOwnProvider, loadConfig, saveConfig } from "../config"`
- `import { syncModelsToCodex } from "../codex/sync"`
- `import { findLiveProxy } from "../server/proxy-liveness"`

## 4. src/cli/help.ts — 하드닝

### 4.1 models 항목 갱신

```
models: {
  usage: "ocx models [list] [--provider <name>] [--json] | add <provider> <modelId> [opts] | remove <id|provider/modelId> [--yes] | list-custom [--json]",
  summary: "List models and manage custom (manually registered) models.",
  details: [
    "With no subcommand, lists statically configured models (liveModels may add more at runtime).",
    "add: register a model the provider catalog does not advertise yet.",
    "  --display-name <name>     Human label (no slashes).",
    "  --context-window <tokens> e.g. 200000.",
    "  --modalities text,image   Comma-separated (text|image|audio).",
    "remove: delete a custom model by UUID or <provider>/<modelId>.",
    "list-custom: show all custom models.",
    "Changes apply immediately to a running proxy (catalog sync).",
  ],
},
```

### 4.2 누락 커맨드 추가: v2

helpEntries와 printUsage 모두에 추가:

```
v2: {
  usage: "ocx v2 <status|on|off>",
  summary: "Toggle the Codex multi_agent_v2 feature (multi-agent surface).",
  details: ["Preserves the active thread limit while moving between v1/v2 modes."],
},
```

printUsage() 라인:
```
  ocx v2 <status|on|off>      Toggle Codex multi_agent_v2 (multi-agent surface)
```

### 4.3 printUsage() models 라인 갱신

기존: `ocx models [--json]         List available models from configured providers`
신규: `ocx models <sub>            List models; manage custom models (add|remove|list-custom)`

## 5. 검증

- `bunx tsc --noEmit`
- `bun test --isolate tests`
- `cd gui && npx vite build`
- `ocx help models` 출력 확인
- `ocx --help` 출력에 v2 + models 갱신 확인
- `ocx models add alibaba-token-plan-intl test-model --context-window 200000` → 성공
- `ocx models list-custom` → 방금 추가한 항목 표시
- `ocx models remove alibaba-token-plan-intl/test-model --yes` → 삭제

## 6. 리뷰어 Plato FAIL 수정

### 6.1 list alias 구현 (§3.1 수정)

dispatch에 `list` 추가:
- `list` → 나머지 인자를 기존 list 로직으로 전달 (no-op alias, 사용성 일관성)

```
if (sub === "add") return handleCustomAdd(rest);
if (sub === "remove") return handleCustomRemove(rest);
if (sub === "list-custom") return handleCustomList(rest);
if (sub === "list") rest = rest; // alias — 기존 로직으로 fall-through
// 그 외: 기존 list 로직 (인자 전체)
```

### 6.2 remove 확인 프롬프트 패턴 명시 (§3.3 수정)

- TTY 확인 프롬프트: `src/cli/star-prompt.ts:47` 패턴 재사용 —
  `node:readline/promises`의 `createInterface({ input: process.stdin, output: process.stdout })`
  + `try { const answer = await rl.question(...) } finally { rl.close(); }`
- 비TTY 강제 --yes: `src/cli/account-extended.ts:210` 선례 —
  `process.stdout.isTTY` 체크, 비TTY에서 --yes 없으면
  `console.error("remove requires --yes in non-interactive mode"); process.exit(1);`

# 131.10 — Verification: OpenCode Go Metadata Drift Retry

## Scope

Phase 131 retry replaces the closed GJC PR #914 assumptions with the current official
OpenCode Go web contract.

Source-of-truth split:

- `https://opencode.ai/docs/go/#endpoints`: OpenCode Go endpoint/API SDK routing.
- `https://opencode.ai/docs/go/#usage-limits`: current Go product prices for rows present
  in the usage table.
- `https://opencode.ai/data/...`: context window, output limit, and modality facts.
- `https://opencode.ai/zen/go/v1/models`: existence-only; the endpoint does not expose
  context/output/pricing metadata.

## Official Routing Contract

Routes encoded in GJC and jawcode:

- `openai-completions` on `https://opencode.ai/zen/go/v1`: `deepseek-v4-flash`,
  `deepseek-v4-pro`, `glm-5.1`, `glm-5.2`, `kimi-k2.6`, `kimi-k2.7-code`, `mimo-v2.5`,
  `mimo-v2.5-pro`.
- `anthropic-messages` on `https://opencode.ai/zen/go`: `minimax-m2.5`, `minimax-m2.7`,
  `minimax-m3`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`.

Rows present in the data catalog but absent from the current Go endpoint table retain data-page
metadata and are not used to infer undocumented endpoint overrides.

## GJC

Repository:

- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc`

Branch:

- `codex/opencode-go-contract`, based on `origin/dev`.

Modified:

- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc/packages/ai/src/provider-models/openai-compat.ts`
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc/packages/ai/test/issue-887-repro.test.ts`
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc/packages/ai/src/models.json`

Verification:

- `bun test packages/ai/test/issue-887-repro.test.ts` passed: 17 tests, 0 failures,
  32 assertions.
- `bun --cwd=packages/ai run generate-models` produced `opencode-go: 20 models`.
- Generated contract check passed: `checked=8 bad=0` for routing, base URL, context,
  output, and price samples.
- `bun --cwd=packages/ai run check` passed.

## jawcode

Repository:

- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_worktrees/opencode-go-contract`

Branch:

- `codex/opencode-go-contract`, based on `origin/dev` in a separate worktree to preserve
  unrelated dirty files in `/Users/jun/Developer/new/700_projects/jawcode`.

Modified:

- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_worktrees/opencode-go-contract/packages/ai/src/provider-models/openai-compat.ts`
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_worktrees/opencode-go-contract/packages/ai/test/issue-887-repro.test.ts`
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_worktrees/opencode-go-contract/packages/ai/src/models.json`

Verification:

- `bun test packages/ai/test/issue-887-repro.test.ts` passed: 17 tests, 0 failures,
  32 assertions.
- `bun --cwd=packages/ai run generate-models` produced `opencode-go: 20 models`.
- Generated contract check passed: `checked=8 bad=0` for routing, base URL, context,
  output, and price samples.
- `bun --cwd=packages/ai run check` passed after temporarily linking the existing parent
  repo `node_modules` into the worktree for type resolution; the symlink was removed and not
  staged.

Existing dirty files preserved outside the worktree:

- `/Users/jun/Developer/new/700_projects/jawcode/AGENTS.md`
- `/Users/jun/Developer/new/700_projects/jawcode/.agents/`
- `/Users/jun/Developer/new/700_projects/jawcode/.claude/`

## opencodex

Repository:

- `/Users/jun/Developer/new/700_projects/opencodex`

Branch:

- `codex/opencode-go-contract`

Implementation result:

- `JAWCODE_MODELS_JSON=/Users/jun/Developer/new/700_projects/jawcode/devlog/_worktrees/opencode-go-contract/packages/ai/src/models.json bun run generate:jawcode-metadata`
  was executed and verified. It introduced no `opencode-go` metadata delta because opencodex
  stores context/output/modalities only; endpoint and price changes live in GJC/jawcode.
- The generated-file diff was intentionally reduced back to zero to avoid unrelated dynamic
  `openrouter` metadata churn from the jawcode worktree.
- The no-code-runtime rationale is recorded in `20_opencodex-integration.md`.

Verification:

- `bun test tests/codex-catalog.test.ts` passed: 13 tests, 0 failures, 98 assertions.
- `bun test tests/provider-registry-parity.test.ts` passed: 8 tests, 0 failures,
  23 assertions.
- OpenCode Go generated metadata sample check passed: `metadata_checked=5 bad=0`.
- `bun test tests` passed: 88 tests, 0 failures, 287 assertions.
- `bun x tsc --noEmit` passed.
- local `ocx` catalog smoke passed and the proxy was stopped afterward.

Runtime `ocx` smoke:

- `ocx start` started the proxy on `http://localhost:10100`.
- `GET http://127.0.0.1:10100/healthz` returned `health ok`.
- `GET http://127.0.0.1:10100/v1/models?client_version=0.141.0` returned Codex catalog
  rows with corrected OpenCode Go limits:
  - `opencode-go/glm-5.2`: `context_window=1000000`,
    `max_context_window=1000000`, `auto_compact_token_limit=900000`,
    `input_modalities=["text"]`.
  - `opencode-go/kimi-k2.7-code`: `context_window=262144`,
    `max_context_window=262144`, `auto_compact_token_limit=235929`,
    `input_modalities=["text","image"]`.
  - `opencode-go/minimax-m3`: `context_window=512000`,
    `max_context_window=512000`, `auto_compact_token_limit=460800`,
    `input_modalities=["text","image"]`.
  - `opencode-go/qwen3.7-plus`: `context_window=1000000`,
    `max_context_window=1000000`, `auto_compact_token_limit=900000`,
    `input_modalities=["text","image"]`.
- Final state confirmed with `ocx stop`: no running proxy found and opencodex was removed
  from Codex config.

## PR / CI

Opened PRs:

- GJC upstream: `https://github.com/Yeachan-Heo/gajae-code/pull/915`
- jawcode: `https://github.com/lidge-jun/jawcode/pull/1`
- opencodex: `https://github.com/lidge-jun/opencodex/pull/1`

Initial CI status after PR creation:

- GJC PR #915: checks pending (`Affected path validation / plan`, `gjc-state-gates / integrity`,
  `gjc-state-gates / read`, `gjc-state-gates / runtime`, `gjc-state-gates / static`).
- jawcode PR #1: checks pending (`Affected path validation`, `jwc-state-gates`).
- opencodex PR #1: no checks reported on the branch at creation time.

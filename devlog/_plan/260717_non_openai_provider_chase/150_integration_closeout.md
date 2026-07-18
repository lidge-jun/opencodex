# WP15 — Cross-provider integration and chase closure

## Goal and dependency

Close the program only after every previous work-phase is `DONE`, `NOOP`, or an honestly recorded terminal outcome. Synchronize registry, catalog, management surfaces, docs, chase indexes, and live runtime evidence.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `devlog/_chase/_model/005_upstream_delta_backlog.md` | mixed open/research/reject rows | each scoped row links its implementation receipt and terminal outcome |
| MODIFY | `devlog/_chase/_model/006_jawcode_import_matrix.md` | pre-implementation gates | record actual adapted/noop/rejected outcomes and fresh source fingerprints |
| MODIFY | `devlog/_chase/_model/008_logic_delta.md` | roadmap recommendations | replace with current architecture and remaining evidence-only gaps |
| MODIFY | `devlog/_chase/03_follow_index.md` | stale Cursor/xAI gaps | close or correct rows against current registry/adapters/tests |
| MODIFY | `devlog/_chase/_model/README.md` | no program closure pointer | link this unit and define the current chase source of truth |
| MODIFY | `README.md`, `README.ko.md`, `README.zh-CN.md`, `docs/README.md` | provider list may drift | align only shipped provider ids, auth modes, and setup links |
| MODIFY | `tests/provider-registry-parity.test.ts`, `tests/codex-catalog-golden.test.ts`, `tests/codex-catalog.test.ts` | piecemeal provider assertions | one final expected provider/catalog contract with no duplicate ids or hidden secret fields |
| MOVE | `devlog/_plan/260717_non_openai_provider_chase/` → `devlog/_fin/260717_non_openai_provider_chase/` | active unit | archive only when every work-phase/criterion is terminal and evidence is captured |

## Closure matrix

For each provider record: registry id, adapter, auth mode, base/region rule, static vs live models, effort policy, image/tool/stream support, timeout/retry policy, focused tests, live smoke date, and terminal outcome. A missing live credential is `NEEDS_HUMAN`, not a silent pass.

## Activation scenarios

- `ocx provider list`, `/api/provider-presets`, and GUI show the same shipped provider ids/auth modes.
- `ocx sync` emits routed catalog rows with no duplicate ids and respects disabled models/context caps.
- One local mock E2E per adapter family proves text, tool, terminal error, abort, and secret redaction.
- The running proxy is restarted from the built tree and one safe smoke per available credential confirms runtime—not only tests—uses the intended provider.

## Verification

```bash
bun run typecheck
bun run test
bun run privacy:scan
bun run build:gui
rg -n "Cursor.*unported|xAI.*transport.*missing" devlog/_chase devlog/_plan/260717_non_openai_provider_chase
cxc loop validate --slug opencodex-openai-xai-provider-chase-durable-docs
```

The final `cxc loop validate` must pass only after all work-phases are done and every met criterion carries captured evidence.

## Terminal outcomes

- `DONE`: all phases terminal, full gates pass, runtime smokes are recorded, docs are synchronized, and the folder is archived.
- `BLOCKED`: an external provider/credential prevents a required criterion; keep the unit in `_plan`.
- `UNSAFE`: any remaining auth/storage/signing risk lacks an approved boundary.
- `NEEDS_HUMAN`: a required product or credential decision remains.

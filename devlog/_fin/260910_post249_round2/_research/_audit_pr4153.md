I applied the `cxc-dev` / `cxc-dev-code-reviewer` review path. This is a C2 exporter-contract review of #4153 at `abf35fa94`; I did not run the product suite.

**1. Import and sanitizer — NOTE**  
`sanitizeCodexReasoningEfforts` exists at [src/reasoning-effort.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/reasoning-effort.ts:130). The new import in [src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:4) (`../../reasoning-effort`) is the same path [src/clients/config-export/mcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/mcode.ts:4) already uses, and it resolves to `src/reasoning-effort.ts`.

It keeps only exact `none` / `minimal` plus the Codex set `low|medium|high|xhigh|max|ultra`, drops duplicates, then sorts by that ladder ([src/reasoning-effort.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/reasoning-effort.ts:5), [src/reasoning-effort.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/reasoning-effort.ts:137)). It does not trim or lowercase. `turbo` is rejected there, not in the ZCode filter: it is not a sentinel and not in `CODEX_REASONING_SET`. After sanitize, `["none","high","ultra","turbo"]` is `["none","high","ultra"]`; [src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:78) then drops `none`, which is why the second test expects `["high","ultra"]` ([tests/providers/zcode-client.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/providers/zcode-client.test.ts:129)).

**2. Export model fields vs omp/dsh — NOTE**  
The loop is `for (const model of normalizeExportModels(ctx.models))` ([src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:59)). `normalizeExportModels` returns `ExportModel[]` unchanged except Fast expansion/sort ([src/clients/config-export/model-metadata.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/model-metadata.ts:91)). `ExportModel` has `reasoningEfforts` and `defaultReasoningEffort` ([src/clients/config-export/contracts.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/contracts.ts:69)).

The three exporters all read `model.reasoningEfforts`, but they are not the same schema:

- omp: client vocab without `ultra`/`none`; `reasoning: true` + `thinking.efforts` + optional `defaultLevel` ([src/clients/config-export/omp.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/omp.ts:40))
- dsh: map `low|medium|high|xhigh|max`, with `ultra` as `max: "ultra"`; no default ([src/clients/config-export/dsh.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/dsh.ts:48))
- zcode: same sanitize-then-drop-`none` ladder as mcode, plus omp-style default gating

That is consistent for this client. The issue’s “like omp/dsh” means “read the catalog fields,” not copy those on-disk shapes.

**3. 3.7.7 / 3.8.1 comment vs new `reasoning` — NOTE**  
The 3.7.7 / 3.8.1 JSDoc is the provider-entry observation (`kind`, `apiKeyRequired`, loopback key) sitting above `ZcodeModelEntry` ([src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:8)). It never asserted `levels` or `variants`. Optional `reasoning` does not contradict those provider claims.

This repo already treats on-disk `reasoning` as a ZCode 3.8.1 model key, with `enabled` / `variants`, not `levels`: [src/integrations/ownership-policy.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/integrations/ownership-policy.ts:58) and the writer fixture `{ enabled: true, variants: ["off", "high"] }` ([tests/clients/integrations-writer.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/clients/integrations-writer.test.ts:369)). That agrees with the new field and with the issue’s Expected block. The issue reproduction’s `model.reasoning.levels` is not a disk contract this tree records. `openCodeReasoningToModelReasoning` is contributor evidence, not something this repository proves.

**4. Goldens / snapshots — NOTE**  
The only byte-pinned ZCode export string is the facade golden in [tests/config/client-config-export.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/config/client-config-export.test.ts:123), and the PR updates it. [tests/providers/zcode-client.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/providers/zcode-client.test.ts:52) still exact-equals models that have no `reasoningEfforts`, so they stay reasoning-free. Writer tests use models without ladders ([tests/clients/integrations-writer.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/clients/integrations-writer.test.ts:40)). Docs samples do not pin ZCode model JSON. No other snapshot in this tree now disagrees.

**5. Consumers — NOTE**  
Callers that need the optional field:

- [src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:57) `buildZcodeClientConfig` (writes it)
- [src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:113) `buildZcodeContribution` (whole provider fragment, field flows)
- [src/clients/config-export.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export.ts:49) registry `build` / `buildContribution`
- type re-export [src/clients/config-export.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export.ts:37)
- tests above

`summarizeZcode` only counts `limit` ([src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:108)). Ownership already lists `models.*.reasoning` as refreshable ([src/integrations/ownership-policy.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/integrations/ownership-policy.ts:79)), so ZCode rewriting that key stays stale/refreshable, not a foreign edit. No extra consumer update is required.

**6. `defaultVariant` omission and case — NOTE**  
Omission is correct: `defaultVariant` is spread only when the trimmed/lowercased default is still in the emitted ladder ([src/clients/config-export/zcode.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/zcode.ts:81)). Default `"none"` is filtered out, so the Muse Spark case has no `defaultVariant` ([tests/providers/zcode-client.test.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/tests/providers/zcode-client.test.ts:148)).

Lowercase/trim is safe on the catalog path. Management/CLI store defaults as exact declared tokens (`none|minimal|low|medium|high|xhigh|max|ultra`) with no mixed case ([src/server/management/model-routes.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/server/management/model-routes.ts:63), [src/cli/models.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/cli/models.ts:66)). `toLowerCase()` is idempotent there and matches omp ([src/clients/config-export/omp.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export/omp.ts:74)). Sanitize still requires exact lowercase on the ladder itself; that is also how the catalog is stored.

**7. Maintainer issues**

- **NOTE (preference, not defect):** #4147’s Expected snippet filters `ultra`. Keep `ultra`. ZCode forwards the selected variant as `reasoning_effort`, and `ultra` is a real Codex rung ([src/reasoning-effort.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/reasoning-effort.ts:11)). omp’s no-`ultra` vocab is omp-only.
- **NOTE (preference, not defect):** `minimal` survives, same as mcode and OpenCode V2 ([src/clients/config-export.ts](/Users/jun/.codex/worktrees/ae6a/opencodex/src/clients/config-export.ts:585)). Hide it only if ZCode’s picker must not show that sentinel.
- **NOTE:** Emitting `reasoning` while still marking it refreshable means ZCode can rewrite OpenCodex’s ladder (the writer test uses `off` / `enabled: false`) and refresh puts the catalog block back. That matches existing 3.8.1 policy, not a merge blocker.
- **NOTE:** Docs checklist is ticked with no docs-site change. The integrations guide does not pin this schema; not a correctness fail.
- **NOTE:** Fork CI in `gh pr checks` is hygiene/target/label/resolve-pr/CodeRabbit only. Cross-platform CI still needs maintainer workflow approval before treating remote tests as proof. Touched files are unchanged between PR base `a7509fe00` and current `origin/dev` `4498fb910`, so this slice should merge cleanly.

No correctness, contract, or security defect that should block merge. The loopback placeholder is unchanged.

PASS

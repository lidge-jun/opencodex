# wp1 — Keep discovery pure and make room for complete task documentation

Depends on wp0. Class C3. Layer 1. No management behavior or user-state changes. Outcome: the existing 74 declarations remain compatible while metadata, exact usage and generated chapters can grow without breaking import or file-size boundaries.

## Exact change map

| Kind | Path | Before → after |
| --- | --- | --- |
| NEW | src/cli/capability-types.ts | Move CapabilityRoute, CapabilityFlag, CapabilityJsonMode, Capability and HeadCapability declarations here; add only optional readonly usage?: string. No runtime imports. |
| NEW | src/cli/capabilities-base.ts | Move existing HEAD_CAPABILITIES and CAPABILITIES literal data byte-faithfully; type-only imports from capability-types. No handler/config/Lab dependencies. |
| MODIFY | src/cli/capabilities.ts | Preserve public type/function/array export names and existing order. Aggregate/re-export pure data only. capabilityInvocation remains canonical token joining; exact usage is a separate rendering concern. |
| MODIFY | src/cli/capabilities-command.ts | Its explicit JSON projection currently drops unknown metadata fields. Add usage only when cap.usage is defined; preserve every existing field and no-usage shape. |
| MODIFY | src/cli/help.ts | For a leaf with usage, render its exact Usage line and omit only that leaf's incomplete-operand warning. With no usage, preserve existing Command/partial-grammar output exactly. Matching and aliases stay in help-catalog. |
| MODIFY | scripts/generate-ocx-skill-surface.ts | Export deterministic renderManagementSurfaces() returning a filename→text map; retain renderManagementSurface() as the index renderer for existing callers. Write/check compact 01_management_surface.md plus flat 01_surface_<domain>.md chapters. Canonical capability headings do not change; optional usage appears beneath. |
| MODIFY | tests/cli/cli-capabilities.test.ts | Replace the no-relative-import syntax assertion with a stronger transitive pure-data allowlist boundary; no command/config/Lab import, dynamic import or unexpected dependency. Preserve all rendering/route/debt assertions. |
| NEW | tests/cli/cli-capability-data.test.ts | Exercise graph refusal fixtures, type-only edges, optional usage JSON/rendering compatibility, aliases and default output. Exercise runCapabilities --json itself with an explicit usage fixture; a helper-only rendering check cannot certify serializer propagation. |
| MODIFY | tests/ci-workflows/skill-ocx.test.ts | Compare every generated file to its owner map; index links resolve; every capability appears once across chapters. Scan all shipped references for command/consent rules, not only the old five-file list. |
| NEW | structure/cli-management.md | Move existing CLI help/capability/management-client contracts from runtime into this owner; preserve factual content and links. Describe pure metadata and generated chapter contract after it exists. |
| MODIFY | structure/runtime.md, structure/manifest.json, structure/INDEX.md | Replace moved prose with explicit owner links; add Tier 5 CLI doc with src/cli ownership and regenerate index. Do not raise 600-line cap or describe unbuilt phases as implemented. |
| MODIFY/NEW | skills/ocx/references/01_management_surface.md, 01_surface_<domain>.md, skills/ocx/SKILL.md | Index/domain navigation replaces one growing generated blob. Remove 'safe at any time' blanket claims; distinguish non-config-mutating probes from cost-free observation. |

Chapter domains are stable command-family groups: lifecycle, providers-models, accounts, agents-routing, integrations, observe-system, access-remote, lab. Resolve each root into exactly one group; unknown roots fail generation instead of disappearing. The index includes all canonical invocation links and derived counts. Generated filenames are a closed owner-produced set; check fails for missing/stale content. No arbitrary filesystem cleanup.

## Field chain and safeguards

usage literals → pure typed metadata → additive capabilities JSON → help and generated reference. No persisted deserializer is introduced. Existing omissions serialize as before. Help consumers do not import execution modules. Metadata purity is a test-time static import-graph assertion (E3), not a sandbox: dynamic evaluated code can evade a naive scanner, so disallow dynamic imports/require in these modules and keep literal-data review. Runtime enforcement layer: none; wording is 'checked dependency boundary'.

## Acceptance

- Original capability/HEAD JSON is identical except intentionally absent optional fields; count/order/root aliases unchanged.
- A verified usage leaf renders operands; a legacy leaf retains exact prior help; alias resolution and recovery destinations stay canonical.
- A synthetic data module importing a handler/config/Lab fails the graph guard; legal data/type edges pass.
- Regeneration then --check succeeds; a changed/missing generated chapter fails; counts derive from arrays, never handwritten totals.
- All generated chapters <2000 lines and structure docs ≤600; existing source caps are unchanged.
- Focused commands: baseline four contract files plus new cli-capability-data and existing cli-help-paths/navigation/recovery files. No GUI render/build is needed; real CLI help and machine-output QA remains required.

## Shared completion contract

This phase follows 002_terminal_ux.md and 003_verification_strategy.md. Main owns registry/dispatch integration, layout-map registration, generated output and Git branch state; executor write scopes are disjoint and named before B. Existing method/path/body semantics come from the referenced source inventories, not endpoint-name guessing.

Update the phase's capability domain, generated references, relevant public CLI pages and owning structure contracts in the same layer. Every new test file enters scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json. Existing tests are retained; no baseline cap increases or green-on-retry acceptance.

Planned new test paths below become executable verification only after B creates them. The current baseline gates in 003 have actually run. C invokes the exact focused files, typecheck, structure and skill-surface checks, privacy where data is handled, a source-bound cxc receipt and real isolated CLI QA (stdout/stderr/exit/teardown). A successful function mock is transport proof only; relevant existing server tests or isolated real handlers verify accepted state. No live user proxy, credentials or upstream requests.

Before P>A, revalidate this document against the parent layer and record the prior D conclusion. Consult an architect for actual decision changes; independent A review is separate. C must preserve saved-versus-applied/refused outcomes. D records exact checks and ledger evidence before the next cycle. Publishing is main-owned; this request stops at open PRs.

## wp1 execution refinements (same-architect stale check)

The exact pure-data graph initially contains only capability-types.ts, capabilities-base.ts and the capabilities.ts facade. Types has no imports/runtime initializer; base imports types only; facade imports/re-exports base values and types while retaining the three existing pure helpers. Use an explicit allowlist, not a wildcard that also admits capabilities-command.ts. The test-owned scanner handles imports, side-effect imports, re-exports and type edges, rejects unresolved/bare/outside/cyclic/computed loads, and ignores comment/string lookalikes. Reuse the existing narrow tokenization seam in tests/helpers/warmup-tokens.ts or a proven Bun scanner; do not assume a TypeScript 5 parser exists under this repository's native TS7 tooling. The same predicate must run against real files and bad/good fixtures. It checks dependencies, not arbitrary-code sandboxing.

All shipped capability literals remain byte-faithful in wp1. Exercise a present usage value by adding a temporary property to a real existing leaf only inside an isolated Bun subprocess, then invoke actual runCapabilities JSON/help/generator consumers. A separate unmodified process checks absence compatibility. No production setter, synthetic command or shared-test global mutation.

Closed chapter map for current roots: lifecycle={chatgpt,status,resolve,capabilities,sync}; providers-models={provider,models}; accounts={account}; agents-routing={agent,combo}; integrations={claude,integration}; observe-system={companion,usage,logs,storage,inspect,system}; access-remote={link,remote-workspace,hub,connect,api}; lab is an honestly empty reserved chapter until wp2. Unknown roots fail and wp2 extends the map deliberately. Preserve global invocation order in the index and original per-chapter order. Keep each old canonical index fragment as a short forwarding heading/link, so existing file-plus-fragment references continue to work. Test exact file+anchor reachability and collisions, not only substring presence.

The generator checks the expected map and rejects extra owner-marked 01_surface_*.md files; it does not delete unrelated or stale files automatically. Scan every actually shipped reference Markdown for command/consent safety. SKILL may reach chapters through its index; test transitive navigation rather than require every chapter to be linked at the top level.

Structure extraction is deliberately narrow: move substantive runtime CLI-readiness content and the two detailed head/help/catalog table contracts into cli-management.md. Keep old runtime headings and concise pointers to preserve anchors. Leave executable lifecycle ownership in runtime. Review the other mapped CLI docs; unchanged accurate contracts do not need copied prose. Register the new Tier 5 owner, stage paths before structure:check and regenerate INDEX through its owner script.

Implementation leaves: (1) metadata/types/facade/serializer/help + CLI tests; (2) generator/skill/generated chapters + skill workflow tests. Main owns structure docs, both test-layout maps, integration/commits and all branch operations. Neither leaf edits the other's paths or runs a global typecheck while the other is writing.

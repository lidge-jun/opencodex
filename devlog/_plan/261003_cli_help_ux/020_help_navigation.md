# wp2: Compact root and family navigation

Dependency: wp1 full-reference and path resolver. Delivery: second PR, based on
codex/cli-ux-help-foundation, head codex/cli-ux-navigation.

## File map and before/after

- NEW `src/cli/help-navigation.ts`: static presentation groups referencing existing
  registry command names, verified examples and pure compact-root rendering.
  Data owns ordering/labels only; registry still owns command identity/summary.
- MODIFY `src/cli/help.ts`:

```diff
 export function printUsage(): void {
-  printFullUsage();
+  console.log(renderRootHelp());
 }
```

- MODIFY `src/cli/registry.ts`: replace provider's self-referential detail with
  concrete syntax/examples for list, presets and pointers to declared topics.
  Preserve exact alias entry identity and add canonical-help navigation for stubs.
- MODIFY `src/cli/help-catalog.ts` and renderer as necessary: family help appends
  declared child paths/summaries with a label that coverage is partial. No API
  route strings in ordinary human help. Existing registry usage/details remain.
- MODIFY `tests/cli/cli-registry.test.ts` and `cli-help.test.ts`: coverage checks
  render full reference instead of assuming the root template contains everything;
  move export-count assertion to full view. Keep every public command reachable.
- MODIFY `tests/cli/cli-help-paths.test.ts`: move its 92-line/equivalence checks
  to explicit full-reference forms; treat92as baseline observation, not a
  permanent reference-length assertion. Default root has independent compact
  assertions. Keep all nested/context/safety/JSON cases unchanged.
- NEW `tests/cli/cli-help-navigation.test.ts` plus both layout registrations:
  compact default agreement, public group validity, no hidden names, no self-loop,
  examples resolve and no ANSI/control dependence.
- MODIFY English CLI reference and runtime structure prose in the same PR.

Root text uses Start here, Common tasks, Explore, More help. At most 28 logical
lines, common rows within 80 columns. Include `ocx help --all`,
`ocx help <command>` and `ocx capabilities --json` as conspicuous escapes.
No per-machine customization, width probing, color library, pager or prompts.

## Observable acceptance

Bare ocx/help/-h/--help agree and remain side-effect-free. Full reference retains
all visible registry commands and pre-existing detailed variants. Provider help
no longer instructs the user to rerun itself. The model alias keeps its name and
links canonical model help. Family children are marked declared, not exhaustive.
Examples are statically checked and manually read at 80 and 40 column terminal
widths; no command token is clipped, and redirected NO_COLOR output is complete.

Run focused navigation/path/head/help/registry/capabilities tests, typecheck,
test:changed, structure/skill surface/privacy checks and docs build.

## P revalidation after wp1

Previous D: wp1 explicit/full help is implemented; broader full-suite failure is
recorded, draft readiness remains pending in wp4. This layer retains that behavior.

CLI-UX-02 architect amendments accepted:
- Entry resolution gains transient canonical identity and declared descendants,
  created in help-catalog from existing registry/capability data and consumed only
  in help.ts. No serialization/deserialization: N/A, process-local presentation.
  Preserve exact registry alias usage/details before canonical navigation.
- Curated models-context is a separate topic link, not a fabricated capability row.
- Preserve capability/prefix/context/unavailable resolution and flag-help fallback.
- Full forms remain identical and preserve registry coverage/recovery variants;
  92lines is the observed baseline, not a permanent count that blocks new commands.
  Compact root differs and is <=28lines.
  Update cli-help-paths root/full checks and rename unknown-root test's "full
  banner" wording to "root banner". wp2 retains its old exit1/stdout+stderr
  contract; concise stderr-only recovery remains wp3.
- Compact root references registry names/summaries without silently truncating
  text.28logical lines is hard;80columns is a readability target.

Proposed provider-help owner consolidation for reflection: MODIFY
`src/cli/provider.ts` to remove its duplicated PROVIDER_USAGE string and render
`printSubcommandUsage("provider")` in its existing no-args/help branch. Move the
existing command rows/examples into registry provider.details (one static owner),
retaining general preset/custom guidance and removing the self-loop. No command
handler, validation, credentials or execution grammar changes. Add exact human
output parity coverage for bare provider/help provider/provider --help, plus
existing cli-provider regression coverage. The root no-args provider path still
has its existing preflight; do not falsely claim it has the head-help bypass.

Provider caller completion (architect correction): migrate BOTH consumers of
PROVIDER_USAGE. Successful no-args/help renders registry help to stdout and exits0.
The unknown provider action prints its existing diagnostic, then registry help to
stderr, and exits1. Add an optional transient `write` sink to the existing
printSubcommandUsage options, defaulting to console.log for successful rendering;
the provider error branch supplies console.error. Propagate it on parent fallback.
No persistent or machine schema fields. Add an isolated unknown-provider regression
asserting empty stdout, stderr usage and exit1; do not change command validation.

B output read: initialcompactroot24lines/max80columns. Main requested the
standard Usage header and concrete logs/usage registry summaries (retain alias
meaning) so common-task rows describe outcomes rather than only alias plumbing.
This is presentation copy within the existing metadata scope.

C coverage amendment: changed-import testing found the existing complete-client
help invariant in `tests/gui/integrations-invariants.test.ts` still calls compact
printUsage and expects a full command row. MODIFY that test to call
printFullUsage, retaining every client-id and `ocx integration client` assertion.
This is the same complete-reference coverage migration, not reduced coverage or
new client support. Add this exact file to the focused verification commands.

Hosted C follow-up: PR6500 test2/4 found a subprocess-only help consumer in
`tests/cli/cli-restore-back.test.ts` that import-graph selection did not discover.
MODIFY its help-documents-both-directions case to invoke `help --all` instead of
compact `help`; retain every restore/back assertion. Verify this file explicitly.
This follow-up belongs to the navigation layer and is committed before wp3's
source, with the parent ref advanced to retain a clean dependency chain.

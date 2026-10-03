# wp1: Explicit help paths and complete reference

Dependency: wp0 audited roadmap. Delivery: first PR against dev.

## Exact file map and transformations

- MODIFY `src/cli/root.ts`: retain `helpTarget?: string` for existing consumers;
  add optional `helpPath?: string[]` for multi-token paths and `helpAll?: boolean`.
  Creation is parseCliHead; runCli consumes them. No persistence/serialization.
  Ordinary command args stay byte-for-byte intact. Derive explicit help prefix
  before `--`; bare `help` is recognized only at root or immediately after the root
  command, never as a later value such as `alias set demo help`. Prefer flags --help/-h for nested help.
  Preserve `ocx command help`; exact `--` terminates head help scanning.
- MODIFY `src/cli/help.ts`: rename existing complete template to printFullUsage;
  printUsage continues to call it in this layer. Recognize full-reference request
  through runCli before rendering a target. Keep printSubcommandUsage(string)
  compatible; accept a path through an additional argument or exported renderer.
- NEW `src/cli/help-catalog.ts`: pure resolver importing registry and capabilities
  only. Return a discriminated result for top-level entry, declared capability,
  declared-prefix group, curated context topic or unavailable path. Resolve exact
  registry aliases first, canonicalizing only their nested path. Hidden commands
  remain callable under existing explicit help behavior but never enter discovery.
- NEW `src/cli/help-models-context.ts`: export MODELS_CONTEXT_USAGE with the exact
  existing context grammar and static explanation/examples for status/value/provider/all.
- MODIFY `src/cli/models-runtime.ts`: replace its inline context usage row with
  `${MODELS_CONTEXT_USAGE}` and import the pure constant. Runtime parsing unchanged.
- MODIFY `tests/cli/cli-head.test.ts`: classification and argv-preservation cases.
- NEW `tests/cli/cli-help-paths.test.ts`: nested resolution, alias paths, unsupported
  detail distinction, full-reference forms and capability payload preservation.
- MODIFY `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`: register new test in cli domain.
- MODIFY `structure/runtime.md`: replace stale CLI help contract/count paragraph
  with current pure help owners, early exit and full-reference navigation.
- MODIFY `docs-site/src/content/docs/reference/cli.md`: document full/nested help
  and distinguish declared capability metadata from exhaustive command grammar.

## Interface and before/after sketch

```diff
- helpTarget: args[1]
+ helpTarget: path[0], ...(path.length > 1 ? { helpPath: path } : {})
- if (head.helpTarget) printSubcommandUsage(head.helpTarget)
+ if (head.helpAll) printFullUsage()
+ else if (head.helpTarget) printSubcommandUsage(head.helpTarget, head.helpPath)
```

New help path is transient argv-derived data. No API route/schema changes.
Capabilities with no operand declaration render `Command: ocx ...`, summary,
known flags/details and a parent-help pointer, not a fabricated complete Usage.
For a valid but undeclared deeper topic, print that detailed help is unavailable
and point to the known parent; never say the runtime command is unsupported.
For models context, use the exact shared usage plus read-only status example.

## Activation and proof

- `help --all` and `--help --all`: exit 0, same complete reference, all previous
  recovery variants retained. Root default remains unchanged in this PR.
- `help models context` and `models context --help`: same specific text containing
  status/value/provider/all grammar. `model context --help` resolves the same topic.
- `help account list`: declared flags/details, no API request and no writes.
- `help account main`: shows declared deeper children; incomplete marker explicit.
- Unknown deeper detail: nonzero help resolution with parent pointer, no false
  claim of invalid execution grammar. Ordinary execution bypasses this resolver.
- `alias set demo help`, `config set defaultModel help`: classify as commands;
  `claude -- --help`: remain command argv. Test classification, never launch them.
- Empty existing isolated homes and shim fixtures remain unchanged for all help
  forms; --json capability payload comparison remains identical.

Verification: new focused test plus existing cli-head/help/registry/capabilities
suites and `tests/cli/cli-models-runtime-dispatch.test.ts` (the whitespace-prefixed
context usage row stays byte-identical); typecheck; test:changed; structure and skill surface checks; privacy scan;
English docs build. See wp0 evidence for baseline commands already run.

## B compatibility amendment

Existing cli-help.test.ts:246 requires `service uninstall --help` and
`codex-shim uninstall --help` to exit0 with safe parent usage, without changing
state. The incomplete capability catalog cannot reject these established forms.
For appended flag help (`ocx <command> ... --help|-h`), resolve the full known
path first; when detail is unavailable but a parent is known, render that parent
successfully. Explicit `ocx help <path>` remains a strict topic request and reports
unavailable detail with nonzero status. This preserves prior flag-help safety and
keeps the declared context forms identical. Rendering takes a transient optional
`fallbackToParent` option derived by runCli from original argv/head command; it
is not serialized or persisted and never changes command execution.
Add regressions for flagged service/shim uninstall and explicit unavailable
service install. Public/runtime docs must distinguish these two forms.

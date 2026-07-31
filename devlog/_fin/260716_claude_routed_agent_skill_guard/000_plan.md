# Claude Routed Agent Skill Guard

## Loop spec

- Archetype: repair.
- Trigger: an `ocx-gpt-5-6-sol` Claude Code subagent invoked the built-in `claude-api` skill, received its very large document bundle, and terminated with `Prompt is too long`.
- Goal: generated `ocx-*` agents do not invoke skills configured in `claudeCode.blockedSkills`; proxy-side bundle elision remains the fallback.
- Non-goals: removing `claude-api` globally, blocking the entire Claude Code `Skill` tool, changing native Claude behavior, or changing model routing.
- Verifier: `bun test --isolate ./tests/claude-agents-inject.test.ts ./tests/claude-inbound.test.ts` proves preventive generation plus fallback elision; `bun run typecheck` proves the shared contract; `ocx claude --version` followed by inspection of `~/.claude/agents/ocx-gpt-5-6-sol.md` proves launch-time generation; a direct `ocx-gpt-5-6-sol` Claude Code run plus transcript inspection proves the guard reaches the agent and suppresses `Skill("claude-api")`.
- Stop condition: default/custom blocked-skill names appear in every generated agent instruction (roster and `ocx-self`), an explicit empty list emits no guard, hostile names remain single-line serialized, fallback elision tests stay green, and a live Sol run completes without a blocked Skill tool-use.
- Memory artifact: this file plus the focused regression tests.
- Expected terminal outcomes: DONE after all checks pass; BLOCKED if Claude Code does not include generated agent body instructions; NOOP if existing generation already prevents the Skill call.
- Escalation: main owns implementation; a Sol reviewer checks the plan and diff. If two independent review attempts fail, main reclaims the audit. No lower worker receives write scope during Build.

## Evidence and rejected hypotheses

- The failing Claude transcript shows `Skill` called with `skill: "claude-api"`, then a `Base directory for this skill: .../claude-api` text bundle, then `Prompt is too long`.
- H1, broken proxy elision: rejected. A live `/v1/messages` probe with a 150,000-character bundle completed with 169 input tokens.
- H2, old daemon missing elision: rejected. The running v2.7.17 daemon passed that live probe; the feature has existed since v2.7.9.
- H3, preventive boundary missing: accepted. Generated agent bodies identify the routed model but do not tell it that `blockedSkills` must not be invoked, so the oversized client-side bundle is created before proxy fallback can help.
- C-phase Sol review found one high blocker: the first implementation guarded every `ocx-self`, including unclaimed native Claude passthrough. The repaired boundary applies the instruction only when `resolveInboundModel` changes the marker-stripped agent model; raw native Claude self definitions remain untouched, while aliases and `modelMap` claims remain guarded.
- C-phase Sol re-review found the first repair overgeneralized identity resolution: direct `provider/model` self selectors such as `mock/big` also resolve unchanged but can never use native Anthropic passthrough. The final predicate exempts only identity-resolved `claude|anthropic` prefixes while `nativePassthrough !== false`; all direct provider selectors and passthrough-disabled Claude ids remain guarded.

## Necessity gate

- Do nothing: rejected because the exact Sol subagent failure is captured.
- Delete or disable `claude-api` globally: rejected because native Claude sessions legitimately use it.
- Add a new hook or ban all Skill calls: rejected as broader than the configured policy.
- Reuse: selected. `DEFAULT_BLOCKED_SKILLS` and `claudeCode.blockedSkills` already own the policy. One exported effective-list resolver in `src/claude/inbound.ts` will normalize the policy for both inbound elision and agent generation, avoiding duplicated semantics or a new module.

## Scope

### IN

- MODIFY `src/claude/inbound.ts`: add one exported effective blocked-skill resolver and use it in translation.
- MODIFY `src/claude/agents-inject.ts`: consume the shared effective list and attach it only to definitions whose marker-stripped model resolves to a different routed id. This includes roster aliases and `modelMap`-claimed self models but excludes unclaimed native Claude passthrough. Render a concise do-not-invoke instruction only when the per-definition list is non-empty. Serialize each name as a JSON string, then replace raw backticks, `<`, and `>` with `\u0060`, `\u003c`, and `\u003e`; JSON already escapes quotes and line breaks, so no configured value can introduce a raw Markdown fence or HTML delimiter.
- MODIFY `tests/claude-agents-inject.test.ts`: assert default, custom, explicit-empty, `ocx-self`, and hostile-name behavior through generated files.
- MODIFY `tests/claude-inbound.test.ts`: pass mixed-case, whitespace-padded custom configuration so inbound elision proves it consumes the same shared resolver rather than retaining independent normalization.
- MODIFY `structure/03_catalog-and-subagents.md`: record the preventive agent instruction and proxy-elision fallback contract.

### OUT

- No changes to `~/.claude/skills`, user-authored agents, model aliases, inbound request schemas, or native Anthropic passthrough.
- No new dependency, helper module, API field, GUI control, or release action.

## Acceptance criteria

1. Default activation: `claudeCode.blockedSkills` is unset. Every generated file, including roster entries and `ocx-self`, names `claude-api` and says not to invoke it.
2. Custom activation: `blockedSkills: [" My-Skill "]`. The shared resolver trims and lowercases it once; every generated file names `my-skill`, not the default, and the inbound custom-elision test passes the same padded mixed-case form.
3. Disabled activation: `blockedSkills: []`. No generated file contains a blocked-skill instruction and inbound elision remains disabled.
4. Hostile-name activation: a configured name containing a quote, newline, backtick, and HTML-comment delimiter appears as a JSON string with escaped line breaks/quotes and Unicode-escaped backticks/angle brackets; it cannot inject a new Markdown line, fence, or comment.
5. Fallback preservation: existing large text-block and Skill-result elision tests still pass.
6. Ownership preservation: marker-based overwrite/prune and user-file protection tests remain unchanged and green.
7. Runtime generation: `ocx claude --version` rewrites the owned Sol agent file with the default guard; no interactive Claude process is launched.
8. Runtime preventive activation: a direct `ocx-gpt-5-6-sol` Claude Code prompt that names Claude Code completes, its system prompt contains the generated guard, and its transcript contains no blocked `Skill` tool-use or skill document bundle.
9. Native passthrough isolation: `ocx-self` with an unclaimed `claude-sonnet-*` picker model has no guard; the same picker id claimed by `modelMap` has the routed guard.
10. Direct-route classification: `ocx-self` using direct `provider/model` syntax has the guard even when inbound resolution is identity; raw `claude-*` also has the guard when `nativePassthrough:false`.

## Audit focus

- Check that policy normalization cannot drift from inbound elision.
- Check generated Markdown cannot be broken by configured skill names.
- Check `ocx-self` and roster definitions receive consistent policy.
- Check explicit `[]` remains a true opt-out.

## Completion evidence

- RED 1: `bun test --isolate ./tests/claude-agents-inject.test.ts` failed the new default/custom guard tests while 6 existing tests passed.
- RED 2: the native-Claude self regression failed because the first implementation incorrectly emitted the guard.
- RED 3: the direct `mock/big` self regression failed because the first native-classification repair incorrectly omitted the guard.
- GREEN: `bun test --isolate ./tests/claude-agents-inject.test.ts ./tests/claude-inbound.test.ts` — 36 pass, 0 fail, 154 expectations.
- Static: `bun run typecheck` and `git diff --check` — exit 0.
- Full suite: `bun test --isolate ./tests/` — 2551 pass, 0 fail, 10578 expectations across 238 files.
- Plan audit: Sol reviewer required shared normalization, `ocx-self` coverage, delimiter-safe serialization, and live activation; amended plan passed on round 3.
- Check review: Sol reviewer found and drove two native/routed self-classification repairs; final verdict PASS with no residual blockers.
- Preventive activation: direct Claude Code session `752388f2-f213-43bc-b133-1344adeac744` ran `ocx-gpt-5-6-sol`, completed normally, and its transcript contained zero `Skill` tool calls and zero skill bundles.
- Generated artifact: `ocx claude --version` rewrote `~/.claude/agents/ocx-gpt-5-6-sol.md`; line 15 contains the default `claude-api` guard.
- Runtime fallback: after the final restart, the proxy reported v2.7.20; a 150,000-character blocked bundle completed HTTP 200 with 168 input tokens.

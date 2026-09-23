# wp6 — MiMo markup without `</function>` (loop-spec, C2)

Loop-spec: class C2 (one adapter leaf + its focused tests + two doc sentences). Tool/credential
scope: local repo, gh for PR/CI/merge (authorized by the user: "pr 넣은 후에 머지해줘"). Write scope:
`src/adapters/command-code-tool-text.ts`, `tests/providers/command-code-tool-text.test.ts`,
`structure/providers-and-adapters.md`, `docs-site/src/content/docs/reference/adapters.md`, this unit.
Budget: one PABCD cycle; wall-clock bound: this session. No live service restart.

## Previous D (quoted)

wp2/wp5 (`020_wp2_result.md`): "`src/adapters/command-code-tool-text.ts` parses MiMo's native grammar
(`<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>`, raw freeform bodies,
the gateway's stray `</parameter>`)". Direction kept: fix the parser, keep dedupe/restore gates.

## Evidence

- 2026-09-23 13:04 KST, codex subagent on `command-code/xiaomi-mimo-v2.6-flash`, live proxy `206fbc6b3f`
  (contains #5611): visible text `<tool_call><function=exec>RAW JS</parameter></tool_call>` while the
  native `exec` call ran. No `</function>`.
- Probe `.tmp/mimo-research/probe.ts` on `e9643875f0`: `parseToolCallMarkup` returns `undefined` for
  `…</parameter></tool_call>`, `…</tool_call>`, the newline-wrapped variant and a params body without
  `</function>`; only the canonical close parses. Root cause: `WRAPPER` (line 44) requires
  `</function>\s*</tool_call>`.

## Architect consultation

Architect: gpt-6-sol read-only subagent `01a0cc77-0ca8-7bb1-bdbd-35a27bcb4ca0` (Aquinas).

| ID | Proposal | Main disposition |
|---|---|---|
| D1 | Accept `BODY</function></tool_call>` or `BODY</tool_call>`; raw body = no `<parameter=`; params body only when fully paired; strip one unmatched terminal `</parameter>` from raw; keep rejecting nested tags, outside prose, mixed bodies, missing `</tool_call>` | Accepted |
| D2 | A raw body that literally ends in `</function>`/`</parameter>` is ambiguous; prefer canonical reading, rely on exact native-input match for dedupe, document residual for text-only restore | Accepted; residual recorded below |
| D3 | No change to `markupMatchesInput`, `matchNative`, `salvagedArguments`, finish gating | Accepted |
| D4 | Tests in the existing file (588 lines, uncapped; 2000-line default threshold) | Accepted |
| D5 | Sync MiMo descriptions in docs/structure | Amended: the guide and reference sentences stay true; add one clause to `structure/providers-and-adapters.md` (source owner) and `reference/adapters.md`; translations unaffected (no contradiction) |

## Diff-level plan

1. `src/adapters/command-code-tool-text.ts`
   - `WRAPPER` → `/^<tool_call>\s*<function=([^>\s]+)>([\s\S]*)<\/tool_call>$/`; after the match, remove one
     trailing `\s*</function>\s*` from the body when present (canonical reading first).
   - Nested `<tool_call>`/`<function=` rejection unchanged (applies to the body after the optional close).
   - Raw branch unchanged: strip one trailing `</parameter>` when the body has no `<parameter=`.
   - Params branch unchanged: every byte must belong to a complete pair.
   - Update the module comment to state the tolerated close.
2. `tests/providers/command-code-tool-text.test.ts` (new cases, same file):
   - parse: `…</parameter></tool_call>`, `…</tool_call>`, newline-wrapped raw body → parsed;
     params body without `</function>` (per the audit amendment below), missing `</tool_call>`, trailing prose
     after `</tool_call>`, text before `<tool_call>`, nested `<function=` → undefined.
   - adapter: captured event order with the new text (no `</function>`) → exactly one `exec` call, zero text.
   - adapter: text-only variant (no native call) → restored `exec` call for declared freeform tool; same with an
     undeclared name → released as text.
   - adapter: native call whose input differs from the variant body → text released (no false drop).
3. Docs: one clause each in `structure/providers-and-adapters.md` line 58 and `docs-site/.../reference/adapters.md`.

## Acceptance (activation scenarios)

- c-1: the captured-order test fails on `e9643875f0` (text leaks) and passes after the change.
- c-2: restore / undeclared / mismatch / negative parse tests pass; the mismatch case proves the drop path
  does not fire on a different input.
- c-3: `bun test tests/providers/command-code-tool-text.test.ts tests/providers/command-code-provider.test.ts`
  + adapter conformance files, `bun run typecheck`, `bun test tests/test-layout.test.ts`,
  `bun test tests/ci-workflows/file-size-ratchet.test.ts`, `bun run structure:check`.
- c-4: PR to `dev`, exact-head required CI green, squash merge, merge commit on `origin/dev`.

## Residual

- D2 ambiguity: a freeform body whose real last characters are `</parameter>` or `</function>` loses them
  on text-only restore (the pre-existing `</parameter>` rule already had this). Dedupe is exact-match only.
- A block missing `</tool_call>` (truncated stream) stays text by design.
- Routing the OAuth preset over `/provider/v1` is not changed here; see the research note when it lands.


## Reflection (same architect)

Verdict MISALIGNED on D4 only; folded:
- add a nested `<tool_call>` negative parse case beside nested `<function=`;
- add literal-terminal cases: canonical `x</function></function></tool_call>` keeps `x</function>` as input;
  `x</parameter></function></tool_call>` keeps the canonical reading's stray-strip (documented residual);
  a native call whose input ends in `</function>` against the close-less echo is released as text, never
  dropped (exact-match dedupe), which pins the D2 residual as a visible text leak rather than lost input.
D1-D3, D5 mapped ALIGNED.


## Research sidecar (devin/swe-2, Aside + git + npm `command-code@1.64.0`)

Report: `.tmp/mimo-research/report.md` (scratch). The OAuth preset has posted to `/alpha/generate` since
`4505210d23`; no commit routed it over `/provider/v1` or reverted such a route (the only Command Code revert,
`a312f75747`, is the quota probe). The OAuth bearer does work on `/provider/v1/chat/completions` and
`/responses` for MiMo with structured calls, but switching needs a per-model base URL and loses
`/alpha/generate`-only fields; recorded as a follow-up. SGLang `MiMoDetector` and vLLM `mimo` both require
`</function>`; no request option suppresses the gateway echo. Recommendation adopted: tolerate the missing
close only on the parameter-free (freeform) path.

## Audit (gpt-6-sol 01a0cc7a, NEAR-PASS) dispositions

1. Close-less raw body literally ending in `</function>` on text-only restore — folded as a pinned test of the
   canonical reading; residual kept (a freeform JS body ending in that literal is not valid JS).
2. Trimmed raw comparison in dedupe — rebutted: a match only drops the echoed text; the native call and its
   own input are relayed unchanged, so no input can be altered or lost.
3. (non-blocking) Inner `</tool_call>` kept by the greedy wrapper — folded: a body containing `</tool_call>`
   is rejected; regression test added.
Amended step 1: `</function>` may be omitted only when the body has no `<parameter=`.

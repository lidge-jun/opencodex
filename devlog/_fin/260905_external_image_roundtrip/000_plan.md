# External-client image round trips

## Loop specification

- Class: C3 protocol compatibility repair; spec-satisfaction, no optimization race.
- Trigger: external clients report missing screenshots through OpenAI routes.
- Goal: preserve supported image bytes, URLs, ordering and detail across translation.
- Non-goals: no new uploader, provider settings, auth changes, live-service restart,
  release, image synthesis, or unrelated adapter refactor.
- Verifier: standalone converter/parser/adapter body inspection, TypeScript, exact-head
  GitHub CI. ALL local test suites are forbidden by the user, including focused suites.
- Stop: reviewed image-repair stack merged bottom-up to dev with green CI and ancestry.
- Memory: this unit and the session-bound goalplan/ledger.
- Outcomes: DONE only with proof; external dependencies may be BLOCKED/NEEDS_HUMAN;
  unsafe expansion is UNSAFE. No implementation-success claim from docs-only work.
- Scope: this managed checkout, read-only Aside official docs, GitHub stack/CI/admin
  merge. The user's follow-up permits unlimited useful parallel agents (subject to
  actual tool capacity); reassess after 90 minutes; no token cap set.
- Escalation: reclaim a lane after two distinct failed agents; any delegated writes
  must be planned with disjoint paths before B. No production credentials in artifacts.

## Measured baseline and hypotheses

H1: normal user images disappear in Responses serialization. Falsifier: compare the
synthetic URL in final request JSON. REJECTED: direct Chat converter -> parseRequest ->
canonical forward buildRequest preserves the input_image, as does openai-chat.
H2: Chat ingress drops image metadata or tool-result images. Falsifier: compare role:user
and role:tool with identical image_url parts. CONFIRMED: user detail is absent and tool
output becomes just `Read this`. Source: src/chat/inbound.ts:80 and :284.
H3: external route/native forwarding or Claude ingress drops otherwise preserved
images. Independent read-only investigation pending; don't assume a token count alone
identifies a serializer. Plain Claude image and tool-result paths have dedicated mapping.

Baseline command: standalone `bun -e` importing chat/inbound, responses/parser,
openai-responses, openai-chat and createTranslatorBudget. Exit 0; direct source imports
observe the actual owners, no bun:test import and no network. User image retained in
both wire formats; identical tool image absent from both. Original typecheck could not
resolve bun-types in this fresh worktree; frozen-lockfile dependency install (scripts
disabled) completed, with no manifest/lock edits. CI remains the test-suite authority.

No-code options: do nothing leaves demonstrated loss; deletion/configuration cannot
restore discarded payloads. Reuse userContentToBlocks and existing downstream image
serialization. Do not add a generic image helper or patch correct Responses code.

## Dependency-ordered roadmap

1. wp0: docs-only roadmap and independent audit (this cycle).
2. wp1 / 010: preserve Chat image detail and structured tool output; lower PR to dev.
3. wp2 / 020: cross-protocol wire regressions and public contract; child PR to lower.
4. User-expanded wp3 / 030: file references and explicit unsupported computer-output
   boundary. 003 records full format coverage and rejected hypotheses.
5. wp4 / 040: orphan tool image carriers on Anthropic and Command Code.
6. wp5 / 050: active external Cursor tool screenshot attachments.
7. wp6 / 060: all-format finding disposition, CI/review/admin-merge bottom-up, retarget
   children and verify exact heads/ancestry. Original completion criteria are unchanged.

Existing placement is reused: src/chat/, tests/responses/, public reference/proxy-formats,
structure/04_transports-and-sidecars.md. No new package, runtime module, or config.
The user explicitly requested stacking; the upper layer consumes the corrected
converter and protects the integrated contract independently of unit-level assertions.

## Continuity

wp1 outcome: commit `1f1daa368` implements 010 with ten converter regression cases;
draft PR #3586 targets dev. Independent patch reviewer inspected both changed files
and returned PASS. Standalone request JSON changed from image/detail missing (exit 1)
to both retained (exit 0); node TypeScript and privacy scan passed. Suites are CI-only,
not claimed green yet. wp2 inherits this verified converter and adds wire/HTTP evidence.

Roadmap audit: independent gpt-6-astra high reviewer returned GO-WITH-FIXES,
two medium findings. Both folded: exact no-suite typecheck/push commands and actual
Claude converter export. Direct node tsc exits 0. Standalone reproduction at
`.tmp/external-image-probe.ts` exits 1 before production edits with imageRetained=false
and detailRetained=false. No local suite ran. Aside opened official Chat docs confirming
image_url.url and nested auto/low/high detail; Anthropic tool-result docs confirm
nested image content. No upload handler is necessary for data URLs.

Roadmap initially recorded against freshly fetched origin/dev. Never claim the whole
reported model-specific outage fixed merely because a converter fix lands. Preserve
the negative result for ordinary user images in the final report.

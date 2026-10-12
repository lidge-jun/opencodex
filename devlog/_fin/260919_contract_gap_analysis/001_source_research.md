# Source coverage and evidence limits

## Inputs

The supplied 23-page report was extracted in full. Its findings are treated as hypotheses because its source acquisition did not establish a repository commit and its small mechanism examples did not execute the complete proxy. The two supplied shared conversations were opened with the authenticated browser on 2026-09-19. A welcome dialog was dismissed; no sign-in or account change was required. Browser traces and original text stay in ignored scratch because they contain material outside the requested publication scope.

The report contributes twelve themes: content decoding, custom-input stream consistency, isolated conformance fixtures, schema-loss policy, detailed capability projection, physical-send admission, terminal diagnostics, replay ownership, spend writer topology, key policy, observability export, and client configuration reconciliation.

The first conversation adds: static model-policy authority versus dynamic evidence; registry-derived metadata; explicit precedence; source-of-truth document ownership; behavioral versus structural verification; centralized hardened utilities; canonical history versus projections; executor/translator boundaries; and embedding. The second conversation summarizes the supplied report and its limitations; it adds no independent source execution evidence.

## Fixed source snapshot

`git fetch --no-recurse-submodules origin dev` followed by `git merge --ff-only origin/dev` advanced the initially clean `dev` checkout from `f02f3613be40bb11cb044d746d37ce6672e32d96` to `7864869c31c41cca9830d93540238f17df8faafb`. All line anchors in this unit refer to that final SHA unless explicitly stated otherwise. No live service restart or source test invocation was performed.

## Existing work discovered before publication

- #5070 is merged. Its source and regressions cover SOCKS gzip/deflate decoding, unsupported-coding refusal and bodyless responses, plus multiple freeform preview/completion mismatches. The report's broad decoding and fence claims require narrowing or rejection.
- #5047 is closed and already covers fallback-wrapper streaming disagreement.
- #5056 is merged and adds withheld-recovery attribution; a generic claim that budget refusals have no diagnostics is stale.
- #5032 is merged and makes the durable token ceiling configurable and refusal visible.
- #2358 remains an open umbrella for compatibility evidence and isolated core work. New proposals must be bounded follow-ups with specific missing behavior, not another umbrella.
- #3377 remains open for model capability declarations. Its exact axes must be distinguished from any new resolved-policy consumer consistency proposal.

Issue/PR state was read from GitHub, not inferred from old notes. A second targeted search will precede final publication.

## Research method

A read-only research pass was also dispatched for a read-only official-standard ledger covering Fetch/HTTP content codings, custom-tool grammar and argument streaming, function declaration schema subsets, and telemetry conventions. Standards establish contract vocabulary and constraints; only the pinned OpenCodex source establishes present behavior. No performance ranking, competitor behavior, model-quality claim, live API success rate or runtime test result is inferred.

## Official-source findings verified with the authenticated browser

Sources below were opened on 2026-09-19. These are contract constraints and design inferences, not proof of a proxy runtime test.

| Source | Supported finding | Limitation for this unit |
| --- | --- | --- |
| [Fetch Standard](https://fetch.spec.whatwg.org/), HTTP-network fetch and Response constructor | Network fetch processes content codings before exposing body bytes; constructing a Response around raw bytes is not network decoding. Null-body statuses constrain the constructor. | Does not prescribe a provider retry or tool replay owner. |
| [HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html), sections 6.4, 8.4, 9.3.2 and 15.3.6 | Content coding is a representation transformation; no-content methods/statuses need separate treatment. A 205 response must not generate content. | HTTP rules do not prove a particular local transport is correct. |
| [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling), strict mode, streaming and custom tools | Schema-constrained functions and grammar-constrained freeform calls are distinct contracts. Stream fragments need aggregation. | It does not mandate a new proxy-side universal validator or make lowering grammar to a string lossless. |
| [Telemetry metric conventions](https://opentelemetry.io/docs/specs/semconv/general/metrics/) | Consistent metric naming, meaningful aggregation and balanced attribute sets are documented. | Does not define OpenCodex-specific fields or justify collecting raw content. |

The supplied GenAI telemetry URL now displays a relocation notice; no current GenAI privacy contract is claimed from that page. This analysis uses the repository's explicit no-body/no-credential logging contract for any proposed metadata-only diagnostics. Original-schema validation before downstream delivery is a design option, not a requirement established by the provider docs; tool execution remains client-owned.

## Publication-time freshness check

During publication, remote `dev` advanced one commit to `04761a188281da4a2936fc4d8d9be5e02b33bb41` via #5100. The complete comparison from the pinned analysis SHA was read. Its runtime changes are confined to `src/responses/tool-name-aliases.ts` and `src/server/responses-undeclared-tool-guard.ts`, aligning emitted tool names with authorization. It does not change the custom-input progressive decoder/completion normalization, raw transports, static-policy merges, spend/replay paths or other candidate owners. The issue evidence therefore remains anchored to the reviewed SHA, with no candidate invalidated by this intervening commit. The associated test-layout and Responses documentation changes should be retained when implementing future fixes.

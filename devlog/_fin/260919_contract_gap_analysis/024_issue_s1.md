# S1: [Bug]: Keep routed custom-tool preview consistent with fence-normalized completion

### Client or integration

Direct HTTP/API client

### Area

Proxy and routing

### Summary

On routed Responses custom-tool restoration, the progressive decoder emits the string inside the input wrapper immediately. Completion strips a complete outer Markdown fence for exec/apply_patch. A delta consumer can therefore receive fence bytes that do not belong to the authoritative final input. The bridge fix in #5070 does not cover this restoration module.

### Reproduction

Static source trace at `7864869c31c41cca9830d93540238f17df8faafb`; the following fake-upstream regression is the proposed executable reproduction, not a claimed local test result.

1. Declare a custom exec tool and route it through function lowering.
2. Feed output_item.added and function argument deltas whose full argument object is `{"input":"```js\ntext(1)\n```"}`.
3. Complete the argument/item/response events.
4. Compare every emitted prefix with the canonical `text(1)` input. Current restoration can emit fence bytes before completion removes them.

### Version

7864869c31c41cca9830d93540238f17df8faafb

### Operating system

Source review on macOS 27.0; the transport logic is cross-platform. Runtime reproduction has not been executed in this analysis.

### Provider and model

Not provider- or model-specific. Use a local fake upstream and no real credentials.

### Logs or error output

No live traffic or runtime logs collected. Evidence is the exact source path below.

### Screenshots and supporting files

[src/server/responses-custom-tool-repair.ts:32](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/responses-custom-tool-repair.ts#L32); [src/server/responses-custom-tool-repair.ts:338](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/responses-custom-tool-repair.ts#L338); [src/server/responses-custom-tool-repair.ts:363](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/responses-custom-tool-repair.ts#L363); [src/responses/apply-patch-envelope.ts:31](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/responses/apply-patch-envelope.ts#L31); [src/bridge/sse.ts:198](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/bridge/sse.ts#L198). Related #5047/#5070; this is a remaining routed path.

### Redacted configuration

Use a fake Responses upstream with a caller-owned custom exec declaration lowered to a function. Feed the event fixture through the routed restoration helper; no live provider credentials, SOCKS tunnel or user home are needed.

### Implementation path

1. Add a small shared progressive freeform-input helper under `src/responses/`, used by `src/bridge/sse.ts` and `src/server/responses-custom-tool-repair.ts`. Preserve current completion normalization.
2. Hold only prefixes that can still become a fence, patch envelope or fallback wrapper; do not strip arbitrary backticks from executable input.
3. Keep ordinary safe input progressive, retain stable call/item identity and common TranslatorBudget charging/release.
4. Add sibling `tests/responses/responses-custom-tool-stream-consistency.test.ts`; the existing large repair test is at its cap. Update `structure/transports/responses.md` and adapter/byte-accounting owners.

### Acceptance criteria and verification

- Wrapped fenced exec across every split emits no prefix inconsistent with final input.
- Done/item/terminal input and identity agree; when preview is suppressed, the final input remains authoritative. Do not incorrectly require empty preview to equal a nonempty done payload.
- Plain input stays progressive; fallback keys, JSON whitespace/escapes and split surrogate pairs are covered.
- Existing patch normalization and buffer release on done/failure/incomplete/disposal remain intact.
- Define and document duplicate-key or late-invalid-wrapper preview limits rather than claiming an impossible general invariant without a buffering policy.

New test files must be registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`; split tests rather than raise file-size caps. Update `structure/transports/inventory.md` and any other owner declared by the manifest. Run focused regressions and exact-head hosted CI in the implementation PR; no passing runtime result is claimed here.

### Checks

- [x] I searched existing issues and documentation.
- [x] I removed secrets, tokens, account details, request credentials, and personal data.

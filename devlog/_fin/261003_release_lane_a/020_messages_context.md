# Preserve context rejection through Messages error projection

Depends on roadmap lock/audit and verified transport foundation. MODIFY existing owners only; no new error codes or type fields, so creation remains existing Responses context classification, serialization is the two Messages encoders, deserialization is collectAnthropicMessage, consumers are the HTTP collectors and Claude client. This is a preservation fix, not a new token limit or recovery mechanism.

## Exact runtime deltas

MODIFY src/claude/outbound.ts in `anthropicFailedStatus`:

```diff
 const code = typeof error.code === "string" ? error.code : undefined;
+if (code === "context_length_exceeded") return 400;
 return code === "translation_buffer_limit"
```

In response.failed's call to `fail(status, message, true)`, add fourth argument `code === "context_length_exceeded" ? code : undefined`. This preserves only the requested recognized code. All unknown code exposure remains unchanged. The existing translator-overflow branch retains its 413 identity.

MODIFY src/protocols/encoders/messages.ts terminal failed mapping:

```diff
-fail(anthropicFailedStatus(error, message), message, true);
+fail(anthropicFailedStatus(error, message), message, true,
+  error.code === "context_length_exceeded" ? error.code : undefined);
```

In its collected-response status:

```diff
-status: isError ? 502 : 200,
+status: isError ? (translatedError?.code === "context_length_exceeded" ? 400 : 502) : 200,
```

Update the collector doc comment to identify classified context rejection as 400 and unknown error frames as 502. Keep translator overflow 413 handling as-is.

MODIFY src/server/claude-messages.ts:

- Non-2xx error branch: initialize `let contextError = false`; add `code?: unknown` to parsed nested error type, and set contextError only for an object whose code is exactly context_length_exceeded. Preserve message extraction. Make `transient` false for contextError, choose outStatus 400 after replay-refusal and native-maintenance precedence, and pass context_length_exceeded as the error code only for this recognized case. Suppress Retry-After for this terminal context response; retain all other refusal/backoff behavior.
- Legacy collected status: use the identical narrow conditional from the direct collector above.
- HTTP 200 JSON status failed: after existing translation-buffer handling and before generic 502 return, add:

```ts
if (error?.code === "context_length_exceeded") {
  return anthropicErrorResponse(400, error.message ?? "upstream context limit exceeded", "invalid_request_error", error.code);
}
```

No change to core-auth.ts/core-options.ts/core-combo.ts or Responses retry/compaction policy. Reuse the current source classification, no message regex. Unknown error semantics stay unchanged.

## Test delta and activation

MODIFY tests/claude-integration/claude-outbound.test.ts with a nested Messages-ingress describe and locally scoped home/server fixtures. Reuse this existing registered file: a new roster row would push test-layout-expected.json to the prohibited 2,000-line threshold. No ratchet increase or compressed manifest rows. Reuse isolatedCodexHome and per-test OPENCODEX_HOME helpers from adjacent endpoint tests; fixtures contain synthetic input and credentials only. Public handleClaudeMessages with configured openai-responses local upstream activates the actual error translation. Include Retry-After in the non-2xx context fixture to prove suppression; for failed JSON assert upstream content type and record whether earlier normalization consumes it. Use HTTP 400 for the single-send non-2xx fixture; refusal/maintenance precedence stays covered separately by existing endpoint tests. Failed JSON must use a route/config that does not reframe it as SSE; if no public route reaches it, report the coverage limit instead of claiming activation. Parameterize stream true/false and terminal SSE/provider 413/non-2xx context error/failed JSON where constructible. Assert exact invalid_request_error + context_length_exceeded, HTTP 400 for nonstream/JSON, no retry header, one upstream send, one terminal stream error and no message_stop. 413 fixture embeds a private-marker string in upstream body; final error must contain only proxy-safe copy. Add unknown and transient negative cases preserving existing classification. Cancel the response consumer and assert upstream cleanup/no extra dispatch where the harness can observe it.

MODIFY tests/claude-integration/claude-outbound.test.ts: update the existing classified invalid_request_error exact assertion to include context_length_exceeded; synthetic response.failed with status 413 + context code and status-absent context code both produce invalid_request_error/context_length_exceeded without message_start or successful terminal. Explicit expectations, not parity.

MODIFY tests/responses/protocol-direct-encoders-messages.test.ts: direct AdapterEvent error with code context_length_exceeded reaches streaming frame and folded HTTP 400; keep explicit oracle assertions. Update the test's legacyFold fixture narrow status rule to mirror the new ingress, without deriving expectations from production helpers. Keep unknown failures and translator limits in existing cases.

Run explicit test files plus tests/responses/responses-context-overflow.test.ts and existing claude-messages-endpoint.test.ts. Direct Arguments observe each target; baseline three-file command passed 143 tests (001); new-file and endpoint coverage will run after implementation. Exact implementation command: `bun test tests/claude-integration/claude-outbound.test.ts tests/claude-integration/claude-messages-endpoint.test.ts tests/responses/protocol-direct-encoders-messages.test.ts tests/responses/responses-context-overflow.test.ts`. Add source-oracle test layout/file-size checks if a new test file is added. No source cap is to be increased.

## Exact documentation additions

MODIFY structure/data-planes/inbound-compat.md: add a short Messages error projection paragraph naming src/claude/outbound.ts, src/protocols/encoders/messages.ts and src/server/claude-messages.ts: classified context_length_exceeded remains invalid_request_error through SSE and HTTP 400 through collection/failed JSON; unknown transient/transport and local translator limits retain their distinct handling. No implicit recovery send.

MODIFY docs-site/src/content/docs/guides/claude-code.md after Auto context warning: explain that a model's advertised window is not a guarantee that a tool-heavy serialized request fits. A classified input-limit error is terminal; reduce current input or compact earlier. If manual compact also exceeds input limits, preserve original history and compact a fork with fewer enabled tool/MCP schemas if the client supports it. Do not promise that changing client accounting or a [1m] marker raises upstream limits; recommend inspecting actual model metadata rather than hardcoding reporter measurements as supported thresholds.

Verify relevant translated pages do not contradict changed semantics; do not introduce a new setting or change auto-context defaults. Run docs build and structure check after changes.

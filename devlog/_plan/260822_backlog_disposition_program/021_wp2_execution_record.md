# 021 — WP2 execution: one merged, three held on reproduced defects

Four changes-requested PRs reviewed at their current heads. One merged; three left
open. Every hold rests on a defect reproduced by the main agent, not on a reviewer's
say-so.

| PR | Verdict | Disposition |
|----|---------|-------------|
| #2310 apply_patch envelope repair | PASS | **MERGED** `b268d1814` |
| #2350 empty tool-output annotation | FAIL | LEAVE OPEN |
| #2351 config mutation audit | FAIL | LEAVE OPEN |
| #2355 config divergence warning | FAIL | LEAVE OPEN |

## #2310 — merged

Every recorded blocker is closed at `93b977d3`, and the earlier objections were about
a *different* implementation: the regex rewrite of `exec` JS and
`wrapRawApplyPatchAsExec` are gone, and `repairFreeformToolInput(source, "exec")` is now
identity. Delimiter normalization is confined to the outer lines of one complete
top-level envelope. The CodeRabbit `custom_tool_call.input` bypass is fixed with the
unnamed-call byte-identical regression present.

Verified on a merge of that head onto current `dev`: `tsc` exit 0, and 216 pass / 0 fail
across five suites. An identity-revert of `normalizeApplyPatchDelimiters` fails 9 tests,
so the coverage is load-bearing.

## #2350 — annotating an empty output by deleting a real one

`isToolOutputEmpty` in `src/adapters/openai-responses.ts` classifies **any part without
non-empty `text`/`refusal`** as empty:

```ts
return output.every(part => {
  if (!isPlainObject(part)) return true;
  if (typeof part.text === "string" && part.text.trim() !== "") return false;
  if (part.type === "refusal" && ...) return false;
  return true;   // input_image, encrypted_content, input_file all land here
});
```

So an image, an encrypted blob, or a `file_id`-only payload is **replaced** with the
annotation. The Chat half of the same PR gets it right —
`content.every(part => part.type === "text")` refuses to annotate a mixed array — which
is what makes this a slip rather than a design disagreement.

It matters because the flag is on by default for DeepSeek, whose V4 models go out over
the Responses wire, so existing configs inherit it on upgrade.

CI stayed green because the Responses tests only send `""`, `"   "`, and `"ok"` —
strings, never the content-part array Codex actually produces.

## #2351 — an audit feature that records the secret

The durability defect from the earlier review **is closed**: reconciliation now commits
in its own transaction before the new mutation begins.

The new blocker is worse. Reproduced directly:

```
redactSecrets({ apiKeys: [{ id, name, key: "ocx_data_SECRETVALUE123", createdAt }] })
  -> apiKeys[0].key === "ocx_data_SECRETVALUE123"    // unchanged
  -> control: apiKey -> "[REDACTED]"
```

Redaction keys off the **last path segment**, and `SENSITIVE_KEY_PATTERN` is anchored:
`api_key` matches, bare `key` does not. `OcxApiKeyEntry.key` is the data-plane admission
secret whose own type contract says it never leaves the server except in the one-time
`POST /api/keys` response. Every such call now writes it to `config-mutation.sqlite`,
readable through `GET /api/config/mutations`.

The route's principal gate is real, so this is not remotely reachable — but a durable
plaintext copy of the admission secret is a worse posture than not having the feature.

The durability test also does not cover the defect it was added for: reverting the
reconciliation hunk leaves the suite at 17 pass / 0 fail, because the test throws
*before* a second marker is ever written.

## #2355 — the warning that disappears

Reproduced:

```
afterEdit.diverged           = true
afterIncidentalLoad.diverged = false     // same process, just loadConfig()
```

`residentConfigSha256` is a module global reassigned on every `loadConfig()`. A live
server calls it incidentally from `codex/sync.ts`, `catalog/sync.ts`, `inject.ts`, and
`plan-from-token.ts` on token refresh — any of which re-reads the edited file and
overwrites the armed digest. The warning vanishes while the proxy still serves the old
snapshot, which is precisely the condition the feature exists to surface.

The correct pattern is already adjacent in the same file: `liveConfigBaseline` is a
`WeakMap<OcxConfig, OcxConfig>` with the comment *"a second `loadConfig()` elsewhere
must not refresh the baseline"*. The digest needed the same treatment and did not get it.

Its test stays green because it never calls `loadConfig()` after the edit.

## The pattern across the three holds

None of these is a style objection or a stale-branch complaint. In each case the code
does something the PR description says it does not:

- #2350 says it annotates empty outputs; it deletes non-empty ones.
- #2351 says it never records a secret; it records the admission secret.
- #2355 says it warns while the proxy serves stale config; the warning clears itself.

And in each case the existing tests pass either way, which is why review had to run the
code rather than read it. That is the whole argument for reverting a hunk and re-running
instead of trusting a green check.

All three stay open with the evidence posted, because the intent is sound in every one
and the remaining work is small and well-defined.


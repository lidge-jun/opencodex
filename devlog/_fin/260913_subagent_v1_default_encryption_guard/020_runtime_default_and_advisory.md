# wp2 — Runtime: v1 default and the advisory state

## What changes

`src/config/multi-agent-surface.ts` (new) owns three things:

- `MULTI_AGENT_SURFACE_ADVISORY_VERSION = 1`.
- `resolveMultiAgentMode(config)`, the single reader that turns a stored value into
  `"v1" | "default" | "v2"`. It keeps the existing rule that an absent key means
  `"default"`; it exists so the advisory and the catalog agree on one answer.
- `multiAgentSurfaceAdvisoryRequired(config)`, true when the resolved mode is not `"v1"`
  and the stored `multiAgentSurfaceAdvisoryVersion` is below the constant.

`getDefaultConfig()` gains `multiAgentMode: "v1"` and
`multiAgentSurfaceAdvisoryVersion: MULTI_AGENT_SURFACE_ADVISORY_VERSION`. A fresh install
has nothing to advise about, so it starts acknowledged.

`src/types/config.ts` gains the optional `multiAgentSurfaceAdvisoryVersion?: number`, and
`configSchema` in `src/config.ts` accepts it as a positive integer with `.catch(undefined)`
so a hand-edited value cannot fail the parse.

## Management API

`GET /api/v2` adds one response-only object:

```json
{
  "multiAgentSurfaceAdvisory": {
    "required": true,
    "mode": "v2",
    "recommended": "v1",
    "version": 1,
    "docsUrl": "https://opencodex.me/guides/subagent-v1-default/"
  }
}
```

`PUT /api/v2` accepts `multiAgentSurfaceAdvisoryAcknowledged: true`, which stores the
current constant and is idempotent. It composes with an existing `multiAgentMode` write in
the same body, because `v1으로 바꾸기` sends both in one request and must not leave the
advisory raised if the mode write succeeded.

It stays a boolean in, number out. A client that could post an arbitrary version could
silence a future advisory it has never seen.

## What deliberately does not change

The catalog stamping in `src/codex/catalog/sync.ts`, the `keepNativeChatGptOnV1` hybrid,
and every `?? "default"` fallback. This phase moves the written default and adds one
piece of state; it does not renegotiate what the three modes mean.

## Tests

New tests go into existing files. `tests/test-layout.test.ts` requires every new test file to
be registered in both `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`, and a file named after this route does not resolve
through the regex seeds. Extending files that already own these subsystems is the smaller
change and keeps the guard quiet.

`tests/server/config.test.ts` — a fresh config resolves to v1 and starts acknowledged.
`tests/codex-integration/codex-v2-gate.test.ts`, in its existing management-API parity
describe block — the advisory is required for a v2 config and for a config with no key, not
required after acknowledgement, and a combined mode plus acknowledgement write persists both.

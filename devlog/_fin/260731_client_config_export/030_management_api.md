# 030 — Phase 3: management API endpoint

Consumes `010`. Serves the GUI (`040`) and any external agent that prefers HTTP
over spawning a CLI. Depends on `010` only — independent of `020`, but sequenced
after it so the CLI's human-framing decisions are settled before the route
encodes the same metadata.

## Scope

IN
- MODIFY `src/server/management/model-routes.ts` — add `GET /api/client-config`.
- NEW `tests/management-client-config-route.test.ts`.

OUT
- No mutation. GET only; this route never writes a file or config.
- No new auth mechanism — the existing management admission applies unchanged.
- No GUI (`040`).

## Route

```
GET /api/client-config?client=<opencode|pi>
```

Placed in `model-routes.ts` beside `/api/models` because it consumes exactly that
model list and shares its catalog imports. A separate module would duplicate the
fetch path for no isolation benefit.

### Response

```jsonc
{
  "client": "opencode",
  "filename": "opencode.json",
  "destination": "~/.config/opencode/opencode.json",
  "apiKeyEnv": "OPENCODEX_OPENCODE_API_KEY",
  "exportHint": "export OPENCODEX_OPENCODE_API_KEY=<your key>",
  "modelCount": 19,
  "modelsWithoutLimits": 2,
  "config": { /* the client config itself */ }
}
```

The envelope carries every fact the GUI needs to render `003` §4's states without
recomputing anything: `modelsWithoutLimits` drives the degraded line, `destination`
and `exportHint` drive the framing, `filename` names the download.

`config` is the same object `020` prints, from the same function. A GUI and a CLI
that disagree about the exported bytes would be a defect this structure prevents.

### Status codes

| Case | Status | Body |
|------|--------|------|
| ok | 200 | envelope above |
| missing/unknown `client` | 400 | `{ error: "client must be one of: opencode, pi" }` |
| catalog unavailable | 503 | `{ error: ... }` — never a partial config |
| unauthenticated | existing management behavior | unchanged |

The 503 rather than a degraded 200 is deliberate and matches `020`: an empty
`models` block reads as valid and offers nothing. `003` §4's error state expects
a real failure to render against.

## Security notes

This route returns a document that references a credential by env-var NAME. It must
never return the value. Two guards:

- The serializer (`010`) is the only thing producing `config`, and its accept
  criteria already forbid `ocx_` in output.
- This phase's test asserts the full response body contains no `ocx_` even when a
  key exists in the running config.

Per AGENTS.md this touches the management API surface but not authentication,
token handling, or OAuth flows — it adds a read-only endpoint behind the existing
admission check. No new credential path is introduced.

## File change map

| Path | Action |
|------|--------|
| `src/server/management/model-routes.ts` | MODIFY — add the GET branch after the `/api/models` block |
| `tests/management-client-config-route.test.ts` | NEW |

## Accept criteria

1. `GET /api/client-config?client=opencode` returns 200 and its `config` is
   byte-identical to `ocx export --client opencode --json`. **Activation:** the
   test calls the route and the exported builder and deep-compares.
2. `client=pi` returns a Pi-shaped payload (models array).
3. Unknown/missing client returns 400 naming both valid values.
4. Response body never contains `ocx_`. **Activation:** the test seeds a real-looking
   key into the running config first, then asserts absence.
5. `modelsWithoutLimits` matches the count of emitted models lacking a limit block.
6. Unauthenticated request behaves exactly as other `/api/*` routes do today.

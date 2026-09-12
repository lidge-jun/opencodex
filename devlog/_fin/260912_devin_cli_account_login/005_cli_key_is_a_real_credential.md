# 005 — The CLI credential is an ordinary Cognition key

This invalidates the mechanism the whole unit was built on, so it is recorded
before anything else changes.

## What was measured

`~/.local/share/devin/credentials.toml` holds `windsurf_api_key` and
`api_server_url`. Feeding those two straight into the EXISTING cloud-direct
client:

```
host: https://server.codeium.com
key shape: devin-session-token$ey...(189 chars)
user_jwt minted: true
catalog HTTP: 200
models in catalog: 229 enabled: 229
```

and then a real turn through `streamChatEvents`:

```
REPLY: "CLIKEY-OK"
```

The CLI's key is a `devin-session-token$<JWT>` — byte-for-byte the same shape
`src/oauth/devin/types.ts` already documents for the Cognition era, and the same
shape `ocx login devin` obtains through RegisterUser. It mints a `user_jwt`, it
opens the full 229-model catalog, and it streams chat over
`exa.api_server_pb.ApiServerService/GetChatMessage`.

## Why that ends the argument the unit was having

Every blocker the three audit rounds produced was downstream of one decision: that
`devin-cli` has no credential opencodex may hold, so an account row would have to
be faked with a marker.

That premise is false. There is a real credential, in a file the CLI writes, in
the format the proxy already parses.

With a real token:

- the marker disappears, and with it the "anything that treats this as a bearer is
  a bug" caveat the first audit round correctly called already-false;
- `authKind: "oauth"` is honest rather than a classification trick — the request
  path resolves a genuine key and uses it;
- blocker 1 evaporates: `getValidAccessTokenSnapshot` returns a working token, so
  there is no 401-until-you-click and no upgrade story to apologise for;
- blocker 3 evaporates: login is a file read, not an interactive paste, so the
  `stdin` design that three rounds could not get right is not needed at all.
  `spawnInteractive` and `DevinCliLoginChild` are deleted.

This is exactly kiro's import-first shape, and now with the same substance:
kiro imports a real token from an installed CLI's own store, and so does this.

## The direction change

**Before:** `devin-cli` drives `devin acp` over stdio; opencodex holds nothing;
an account row needs a marker.

**After:** `devin-cli` imports the CLI's key and routes through the cloud-direct
Connect-RPC transport the `devin` adapter already owns.

LOOP-CONTINUITY-01 requires a reason for changing direction. The reason is
measured, above: the ACP route was chosen when the credential was believed
unreachable, and it is not.

What is genuinely given up: ACP runs Devin's own agent loop in the child, with its
own tools and permissions. The cloud route is plain inference. For a proxy whose
job is to expose a model to Codex and Claude Code, plain inference is the correct
surface — the local agent loop was never the thing being exposed, and it is what
produced the `--permission-mode` defect already fixed on `dev` (PR #4332).

## What the unit becomes

wp2 shrinks to a credential importer. wp3 keeps the `authKind` flip and
`dashboardPreset: false`, and additionally repoints the adapter. wp4 is unchanged
apart from describing the new transport.

The phase documents are rewritten in `011`, `021`, `031`; `010`/`020`/`030` stay
in place as the superseded record of the ACP design, because the audit trail that
killed it is worth keeping.


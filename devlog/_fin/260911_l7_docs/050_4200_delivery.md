# #4200 — delivery record

Commit `59d2dc48f8` on the stacked branch `codex/260911-l7-remote-hub`, based on the #4215 head.
Closes #4200.

## What shipped

`docs-site/src/content/docs/guides/remote-hub.md`:

- The setup block creates `hub` and `remoteGui` before setting any field, and names the exact error
  a reader would otherwise hit. A whole-object alternative is offered for a genuinely empty config,
  with the warning that a whole-object set replaces rather than merges, plus the two details that
  decide whether a line is accepted at all: the value is parsed as JSON first, and both objects are
  strict so a mistyped key is rejected at write time.
- A new **Giving the data listener TLS** section states that opencodex terminates no TLS itself,
  gives the macOS recipe, shows `ocx connect` with a data origin and a separate `--management-url`,
  and documents the loopback-bind trap.
- The troubleshooting list loses `--allow-insecure-http`, which does not exist, and gains the
  `403 origin_rejected` symptom pointing at the new section.
- The Docker section says why its nested sets work there, so the guide states one rule.

`tests/ci-workflows/docs-remote-hub-claims.test.ts` guards all of it, registered in both layout maps.

## The finding that shaped the recipe

The issue asks for "a supported macOS Tailscale-extension data transport example". The obvious one
— bind the data listener to loopback so Serve can reach it — is wrong, and wrong in a way that
passes a health check.

`isApiAuthRequired` is `!isLoopbackHostname(config.hostname)`, keyed on the **configured bind**
address rather than the socket or the `Host` header (`src/server/auth-cors.ts:288`-`290`). A loopback
bind therefore takes the first arm of `isAllowedRequestOrigin` (`auth-cors.ts:90`-`94`), which stops
requiring a data credential and starts requiring the request's `Host` to be loopback too. A TLS
frontend forwards `Host: hub-name.tailnet-name.ts.net`, so `/v1/catalog` returns
`403 origin_rejected` (`src/server/index.ts:1303`) — while `/readyz`, which never runs that check
(`index.ts:1222`-`1242`), still returns `200`. Nothing reads `X-Forwarded-Host`, so the frontend
cannot repair it.

So the guide keeps the tailnet bind, where credential admission stays on and the `Host` check does
not apply, and puts a loopback forwarder in front for Serve to target. That is also what the issue
reporter deployed successfully.

| `hostname` | Serve can reach it? | `/v1/catalog` |
|---|---|---|
| `127.0.0.1` | yes | 403 `origin_rejected` — the trap |
| `0.0.0.0` | yes | works; publishes on every interface |
| tailnet IP | no, needs a forwarder | works |

## Decisions this lane made

- **Documentation only.** The issue's review explicitly leaves auto-creating a missing parent out
  of scope, so `src/cli/config-command.ts` is untouched and the guide documents the CLI as it
  behaves.
- **Both config forms are shown**, because they are good at different things: whole-object for a
  fresh config, `'{}'` plus nested sets when adapting an existing one without dropping siblings.
- **The dead `--allow-insecure-http` is fixed in the same PR.** It is one line in an owned file and
  the same class of defect the issue reports — a published command that cannot run. Leaving a
  known-false command beside the one being corrected would be indefensible.
- **Serve's HTTPS port set is not asserted.** The guide uses 8443 and tells the reader to confirm
  with `tailscale serve status`, rather than publishing a port list this lane did not verify.
- **Translations are a follow-up.** The seven locale copies still carry the dead flag and the old
  setup block. They are outside this lane's owned paths, and the issue asks for English first.

## Verification

Local product suite, typecheck and build NOT RUN by operator instruction. Hosted CI on the exact
pushed head is the proof.

Two read-only reviewers stood in for the local run. One verified every assertion in the new test by
reading, including the ordering assertion that is the actual fix — it confirmed the initializer
precedes the first nested set, and that neither the Docker Compose lines nor the Rollback section
steal the `indexOf` the test depends on. The other checked the recipe against the admission code,
quoting the predicate, and confirmed the anchors, the scope, and both layout registrations. Its one
residual finding — a backgrounded forwarder does not survive a reboot while the service does — is
folded into the guide.

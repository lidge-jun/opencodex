# wp-030 roadmap audit — GPT-5.6 Sol high/priority

## First verdict

GO-WITH-FIXES. Eight implementation-readiness blockers:

1. positive-integer max-input validation lacked disk and management owners;
2. successful live discovery could drop the standard GPT-5.6 alias;
3. existing hint/cap semantics could not guarantee trusted 1.05M/922K limits;
4. virtual resolver types, no-match/error behavior, mutation, and reasoning merge were underspecified;
5. client-visible HTTP JSON/SSE/WS model identity was undecided;
6. compact exactly-once log ownership was underspecified;
7. key-provider DTO and CLI cloning paths were absent;
8. the activation gate did not require strict real-transport interception or new config/management suites.

Residual correction: eight API models total means existing `gpt-5.5` plus seven
GPT-5.6 ids, with exactly three virtual Pro aliases. `src/usage/summary.ts` needs a
regression test but no expected production change.

## Plan repairs

The roadmap now names disk and management validators, all seven trusted-row
reconstruction after live discovery, trusted-baseline-then-user-cap semantics, exact
resolver types and errors, client-visible virtual identity rewriting, compact index-only
logging, key-login paths, strict HTTP/SSE/real-WS/compact capture, and the expanded gate.

Independent re-audit is required before Build.

## Second verdict and repairs

Five blockers remained: exact catalog augmentation activation/signature, Windows native
SSE safety, compact cancellation/body-read observability, malformed-registry test seam,
and an unnamed key-login test owner.

Repairs:

- catalog augmentation now has an exact `(models, config)` signature, enabled-API-tier
  guard, and semantic identical/conflicting warning rules;
- response identity is explicitly catalog/log/usage-only; native HTTP JSON/SSE/WS
  payloads keep the base model and the Windows relay remains untouched;
- compact buffers under a cap with `req.signal`, maps abort/body/connect/status outcomes,
  and index logs the final status exactly once;
- synthetic malformed definitions use a pure validator seam without registry mutation;
- `tests/umans-provider.test.ts` is the named key-provider/CLI clone owner and is in the gate.

Another independent re-audit is required before Build.

## Third verdict and repairs

Three blockers remained: exact-eight enforcement, a concrete bounded compact reader,
and deterministic collision semantics.

Repairs:

- enabled API augmentation filters to and rebuilds the exact eight ids, including
  `gpt-5.5`, while absent/disabled API remains a no-op;
- compact uses a 32 MiB incremental reader, rejects oversized `Content-Length` before
  reading, cancels on chunked overflow, returns one sanitized 502, and relays no partial body;
- collision comparison has a normalized semantic signature and process-wide mismatch
  key with a test reset seam, so repeated identical mismatches warn once and changed
  signatures warn again.

Independent re-audit is still required before Build.

## Final verdict

PASS — the same GPT-5.6 Sol high/priority reviewer confirmed the exact-eight catalog,
bounded compact reader, collision semantics, Windows relay, validator seam, identity
ownership, and key-login gate are implementation-ready with no remaining blocker.

## Implementation audit

The same GPT-5.6 Sol high/priority reviewer then audited the implementation in four
rounds. The first implementation pass exposed six false-green gaps: no exact-eight live
catalog activation, incomplete max-input validation/capping, key-login metadata loss,
non-fail-closed virtual definitions, unbounded/unlogged compact relay, and no real
HTTP/SSE/WebSocket persistence proof.

After those repairs, the reviewer found three adversarial gaps: prototype-inherited
virtual keys, incomplete usage JSONL assertions, and a helper-only catalog test that did
not exercise `gatherRoutedModels`. The next round found two narrower gaps: an own-key
`undefined` definition was treated as no-match, and grouped transport assertions could
not prove exactly one persisted row per transport. Each finding received a regression
before re-audit.

Final independent implementation verdict: **PASS** with no remaining blocker.

- focused gate: 263 pass, 0 fail;
- `bun x tsc --noEmit`: exit 0;
- `git diff --check`: exit 0;
- exact-eight live discovery, trusted 1.05M/922K metadata, and lowering-only user caps;
- HTTP JSON, HTTP SSE, real WebSocket, and compact base-wire/virtual-log identity proof;
- every compact success, upstream 4xx/5xx, connect/read failure, overflow, and abort
  persists exactly one final request-log and usage JSONL row;
- prototype keys are ordinary no-match while malformed matched definitions fail closed.

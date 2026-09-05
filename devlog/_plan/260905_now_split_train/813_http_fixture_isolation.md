# 813 — Deterministic transport isolation for the HTTP auth fixture

## Loop spec and repair scope

This is a bounded verifier repair inside810's first closeout work-phase,
not another modularization layer. The first C did not complete: one ordinary
run stalled in discovery; another completed with a WebSocket terminal
watchdog failure. No passing receipt was fabricated. Return toP/A before
changing the test. This amended cycle still counts only once when its real
C/D succeeds;820 remains a separate full second regression cycle.

ClassC3 test isolation; explicit trust-boundary review. Goal: preserve the
downstream WebSocket per-turn auth assertions while making the existing
HTTP/SSE fixture independent of native upstream transport availability.
No product transport, auth policy, timeout, test skip or pipeline partition
changes. Main owns the one-file edit; reviewers remain read-only.

## Evidence and rejected alternatives

Matched traces reproduced the same1s watchdog failure on pinned dev. The
HTTP fixture helper only replaced fetch. A temporary no-egress sentinel
observed two canonical native WebSocket construction attempts; blocking those
attempts still allowed the original old/new HTTP credential assertion to
pass, while the new zero-unhandled-dials oracle failed2!=0. Complete traces
and the controlled RED remain in ignored session evidence.

Do not increase the watchdog or weaken completion matching. Do not route an
upgrade through the HTTP fixture handler: it would add handshake requests to
the fixture's auth observation array. Reuse the Proxy constructor-isolation
pattern already present in
tests/adapters/openai/openai-provider-option-e2e.test.ts180. Native successful
upstream transport continues to be covered by tests/responses/ws-upstream.test.ts.

This explains the HTTP-fixture dependency exposed by the watchdog; it does
not claim to explain or fix the separate CPU-bound discovery stall.

## Exact file change

MODIFY only tests/server/server-auth.test.ts:

1. Capture originalGlobalWebSocket beside originalGlobalFetch.
2. In redirectCanonicalCodexTo, move the existing canonical path prefix from
   inside the fetch callback to function scope before installing either wrapper.
   Install a Proxy around the current constructor. For wss, exact chatgpt.com
   host and that exact path or a slash-delimited child path, throw a fixed
   HTTP-only-fixture refusal before
   any real native dial. For every other URL, Reflect.construct the original
   target with unchanged arguments and newTarget. Existing fetch redirection
   stays unchanged. Downstream loopback WebSocket remains real.
3. Restore originalGlobalWebSocket in the existing afterEach.
4. Add one local constructor-boundary regression test in the existing
   server-local-auth describe block. A capturing constructor avoids all real
   network calls; assert canonical upstream refusal, unchanged loopback URL/
   protocol arguments, delegated near-prefix paths and other hostnames, and
   preserved static OPEN. Hooks restore on failure.
   Keep every existing auth/header/log assertion unchanged.

No new test file or layout mapping. No generic helper module. The existing
large test file is not opportunistically restructured in this closeout.

## Audited patch shape

    const prefix = "/backend-api/codex";
    const currentWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(currentWebSocket, {
      construct(target, args, newTarget) {
        const url = new URL(String(args[0]));
        if (url.protocol === "wss:" && url.hostname === "chatgpt.com"
          && (url.pathname === prefix || url.pathname.startsWith(\x60\x24{prefix}/\x60))) {
          throw new Error("HTTP-only Codex fixture rejects native upstream WebSocket");
        }
        return Reflect.construct(target, args, newTarget);
      },
    });

The refusal is test-only. The production transport's existing constructor-
failure fallback runs; no new runtime bypass or altered credential policy is
introduced.

## A synthesis

Both reviewer findings are accepted. The shared prefix must be explicitly
hoisted, and the new WebSocket predicate must not swallow near-prefix paths.
The existing HTTP matcher is intentionally unchanged. Noncanonical delegation
cases are added to the new constructor test; no blocker was rebutted. Main
judges the amended plan near-pass with both concrete fixes folded in, subject
to independent code and runtime verification. The review did not certify a
fix for the separate discovery stall.

## Verification and acceptance

- Existing no-egress sentinel on unmodified e052 is RED2!=0 after the old/new
  auth assertion passes (already observed).
- The same sentinel with the helper fix must be GREEN0 attempts, with both
  original credentials observed. Reverse the temporary sentinel and confirm
  clean exact-head source before acceptance.
- Run the new helper-boundary case and the complete existing server-auth
  file, plus ws-upstream and the adjacent provider-option fixture remotely
  under unchanged assertion/deadline policy. Repeated focused runs verify
  restoration and measure recurrence; they do not substitute for full gates.
- Fresh exact-head typecheck, privacy and ordinary full suite through the
  source-bound receipt, with no profiling flags. Existing same-content
  dashboard build/component and14stage proofs stay accurately attributed.
- Independent C review; any discovery stall recurrence returns toRCA.
  Do not close that earlier unexplained observation merely because the helper
  repair and a later run pass. No publication before820 final gates.

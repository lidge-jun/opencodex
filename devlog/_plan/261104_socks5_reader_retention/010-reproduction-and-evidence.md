# SOCKS5 reader disposal and request-body retention

## Failure and minimal reproduction

A pending `readUntil()` can receive partial framing bytes just before its owner
disposes the reader. Resolving the underlying `readAny()` queues a continuation;
disposal then removes socket listeners and rejects the waiters that exist at that
instant. Without a terminal flag, the continuation registers a new waiter and
abort listener after the socket has lost its normal completion path.

The deterministic schedule is:

```text
pending = reader.readUntil(CRLF, limit, signal)
socket.emit(data, partialFrame)  // resolve readAny; queue the continuation
reader.dispose()
socket.destroy()
await pending                  // must reject, not enqueue a new waiter
```

Run the focused regression from the repository root with the pinned Bun version:

```sh
bun test tests/lib/socks5-reader-lifecycle.test.ts
bun test tests/lib/socks5-timeout-cleanup.test.ts
```

The reader test executes the private class extracted from the current production
source, rather than maintaining a second implementation or exporting a test-only
runtime API. It uses a disconnected socket and synthetic bytes, and tests the
actual asynchronous continuation and listener state. The transport test exercises
the public fetch entry point against a synthetic loopback peer. Neither needs a
provider account, production traffic, external DNS, or a heap snapshot.

The fix marks disposal terminal before rejecting waiters, after preserving any
SOCKS handshake bytes for the next socket owner. It also removes the owned
handshake/response timeout callbacks on terminal paths. Disabling a socket timeout
or destroying the socket alone does not remove its timeout listener in the tested
Bun runtime.

## Sanitized diagnostic evidence

The original observation used OpenCodex 2.93.0 and Bun 1.4.4. Two idle heap
captures from the same process, approximately 19 minutes apart, showed:

| Observation | Baseline | Later capture |
|---|---:|---:|
| External memory after explicit GC | 55.32 MiB | 445.69 MiB |
| Retained SocketReader / TLSSocket pairs | 5 | 84 |
| Pending anyWaiters per retained reader | 1 | 1 |
| Pending exactWaiters per retained reader | 0 | 0 |

Those sockets retained `end` and `timeout` listeners, but not the reader's
`data`, `error`, or `close` listeners. The representative strong path was:

```text
GC-rooted Function
  -> readAny waiter / abort-listener lexical environment
  -> SocketReader
  -> TLSSocket
  -> timeout callback
  -> fetch lexical environment
  -> request body
```

Removing only the corresponding timeout reference edges in an offline heap graph
disconnected an additional 388.64 MiB of shallow node size between captures.
This supports the path as a major contributor in that window. It is not a
measurement of memory actually released, and graph shallow size and runtime
external memory have different accounting. The analysis did not compute full
dominators or match object identities across snapshots; this runtime did not
provide stable snapshot node IDs in a synthetic identity check.

Local validation before upstream packaging included 9 reader lifecycle checks
and 36 SOCKS/HTTP/HTTPS integration checks. The integration load used synthetic
requests, eight-way concurrency and cancellation, but did not reliably reproduce
the original long-term memory curve. Its memory samples are not evidence of an
absence of leaks; the deterministic race and listener assertions are the
regression signal. PR verification records the separately rerun repository tests.

After applying the fix, natural use on the same process accumulated 280 request
records over approximately 131 minutes, including six application-classified
abort records. Input contexts reached approximately 246,000 tokens and sampled
concurrency reached three. A separately sampled 59-minute window ranged from
48.32 to 283.51 MiB external memory and returned to approximately 49 MiB after
peaks, without forced GC. A following 15-minute window ended above its starting
memory level while the response cache was filling. These were not equal-load
A/B runs, not 131 minutes of continuous memory sampling, and not proof that every
possible leak is eliminated. There is no post-fix heap-graph comparison here.

Only aggregate counters, relative durations, runtime versions and structural
type/edge names are published. Raw heaps, request contents, object strings,
accounts, machine identifiers, local paths and capture timestamps remain outside
the repository.

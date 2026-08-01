# 030 — WP3: labelling the runtime the dashboard is actually talking to

Depends on WP2: this phase changes what the numbers are called, WP2 changes what one of
them measures. Doing labels first would document a value that is about to change meaning.

## Symptom

Running against the Go proxy, the memory card reads:

| Tile | Shown | Actually |
|---|---|---|
| 상주 메모리 (RSS) | 899.4 MiB | `MemStats.Sys` (fixed by WP2) |
| JS 힙 (사용 / 전체) | 340.3 / 882.8 MiB | Go heap: `HeapAlloc` / `HeapSys` |
| JSC 힙 | — | JavaScriptCore does not exist here |
| External / ArrayBuffers | — | V8/JSC concepts with no Go counterpart |

There is no JS heap in this process. The card is reporting Go runtime figures under
JavaScript runtime names, and the empty JSC row reads as a missing measurement rather than
an inapplicable one.

The details text is the actively harmful part. `dash.mem.hint` currently tells the user that
"RSS는 증가하는데 JS 힙이 평탄하면 ... 네이티브 런타임" — a Bun-specific heuristic that
separates the JS heap from native allocations. On Go both numbers come from the same
allocator, so the rule it teaches cannot discriminate anything and points at a conclusion
that is never warranted.

## Root cause

`gui/src/components/MemoryObservabilityCard.tsx:338-341` renders fixed labels for whatever
the endpoint returned:

```tsx
<Stat label={t("dash.mem.jsHeap")} value={data ? `${formatBytes(data.heapUsed, locale)} / ${formatBytes(data.heapTotal, locale)}` : "—"} />
<Stat label={t("dash.mem.jscHeap")} value={data?.jscHeap ? formatBytes(data.jscHeap.heapSize, locale) : "—"} />
```

The card predates the Go runtime and had only one possible backend. The Go handler
(`go/internal/management/system.go:34`) already sends `goVersion` and `goroutines` and omits
`jscHeap`/`external`/`arrayBuffers`; the Bun handler
(`src/server/management/system-routes.ts:66`) sends `bunVersion`/`bunRevision` and `jscHeap`.
The discriminator is already on the wire and simply unread.

## MODIFY map

### MODIFY `gui/src/components/MemoryObservabilityCard.tsx`

1. Extend `SystemMemory` with the fields the Go handler already returns:
   `goVersion?: string` and `goroutines?: number`.
2. Derive the runtime once, from the payload rather than from a guess:
   ```ts
   // The Go and Bun handlers each send their own version field; neither sends the other's.
   const runtime = data?.goVersion ? "go" : "js";
   ```
3. Swap the heap label: `t(runtime === "go" ? "dash.mem.goHeap" : "dash.mem.jsHeap")`.
   The value expression is unchanged — `heapUsed`/`heapTotal` are correct for both.
4. Replace the third tile on Go: instead of a permanently empty JSC row, show
   `dash.mem.goroutines` with `data.goroutines`. On Bun the JSC tile stays exactly as is.
5. Use `dash.mem.hintGo` for the details text when `runtime === "go"`, keeping the existing
   `dash.mem.hint` for Bun.
6. In the runtime-counters block, `external`/`arrayBuffers` already render "—" via
   `=== undefined`, which is correct on Go; no change beyond leaving them alone.

No new component and no runtime abstraction: this is one discriminator and three ternaries
inside the component that already owns the card.

### MODIFY `gui/src/i18n/{ko,en,ja,zh,ru,de}.ts`

Add next to the existing `dash.mem.*` block in each locale:

- `dash.mem.goHeap` — Go heap (used / total)
- `dash.mem.goroutines` — Goroutines
- `dash.mem.hintGo` — read-only diagnostics phrased for a single-allocator runtime: rising
  resident memory with a flat Go heap points at retained buffers or memory the runtime has
  not yet returned to the OS, not at a separate native allocator.

`en.ts` is the source; the other five are translated to match, with the Korean copy written
as natural Korean rather than a transliteration of the English.

## TESTS

### MODIFY `gui/tests/memory-observability-card.test.tsx`

The existing `MEMORY_PAYLOAD` is a Bun payload and stays as the JS-runtime case. Add a Go
payload fixture (`goVersion: "go1.26.4"`, `goroutines: 17`, no `jscHeap`, no `external`) and
assert:

- the Go heap label renders and the JS heap label does not;
- the goroutine count renders in place of the JSC tile;
- the Bun payload still renders the JS heap and JSC labels unchanged.

## Verification (C)

| Command | Expected |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun test gui/tests/memory-observability-card.test.tsx` | exit 0, both runtime cases pass |
| `bun run lint:gui` | exit 0 |
| `bun run build:gui`, rebuild dogfood, read the card at :10100 | Go heap + goroutines shown, no empty JSC row |

The rendered check is required rather than optional: this phase changes only what the user
sees, so a passing test without looking at the card would not prove the fix (dev-frontend
verification grounding).

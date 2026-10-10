# U1 — Textual TOOL_CALL markers stay off the text channel (#4815)

## What the branch does today

`drainCursorTextToolCalls` folds `pending + chunk`, emits the prose around every
`[TOOL_CALL]name[ARGS]{json}` block, and returns the parsed calls.
`mapCursorProtobufServerMessage` promotes each drained call immediately, minting
`textcall_<n>` and running it through the same atomic
`recordToolCall` / `commitToolCall` pair a real frame uses.

## The contract this unit has to hold

**A Cursor turn has at most one source of tool calls, and a real frame always
wins.** The text channel is a fallback for a turn that produced no real
`toolCall*` frame at all. It is never an addition to one.

That is the invariant the delegation asks for, and the current branch does not
have it: nothing correlates a promoted `textcall_` with a real frame, so a model
that emits both the frame and its textual echo hands the client two executable
calls for one intent.

### Decided resolution

Promotion becomes deferred rather than immediate.

1. Strip the marker from visible text at the moment it is drained, exactly as
   today. Nothing about the text channel changes.
2. Buffer the drained calls on the event state instead of emitting them.
3. Set a `sawRealClientToolCall` flag wherever a real client tool frame is
   recorded (`toolCallStarted`, the `mcpToolCall` path, and the synthetic
   structured-edit path that already routes through `recordToolCall`).
4. In `finalizeTurnEvents`, flush the buffered text calls only when that flag is
   clear. If any real frame appeared during the turn — completed or left
   incomplete — drop the whole buffer.

Deferring to finalize is what makes the ordering irrelevant. Suppressing future
promotions once a real frame appears would not help, because a promoted call
cannot be retracted after it has been emitted, and the dangerous ordering is
marker-first.

### Three edge cases the delegation names

**Marker split across deltas.** Already held in `pendingTextToolCall`; the hold
survives, and the deferral does not change it. The regression to add is a split
that lands *and* a real frame arriving in the same turn.

**Arguments malformed.** `JSON.parse` failure must stay fail-closed: never promote
a call whose arguments do not parse. Today that failure is completely silent, so
the only visible symptom is a tool that never runs. Add a
`debugProviderDiagnostic` record so the drop is observable without logging the
arguments themselves.

**Pending buffer over the cap.** `holdOrDrop` currently returns `""` once the hold
passes `MAX_PENDING_TEXT_TOOLCALL_BYTES`. That resets the drain to a clean state
in the middle of a marker, so the *tail* of that marker — everything after the
64 KiB point, including the closing brace — has no opener in front of it and is
emitted as visible assistant text. Dropping the buffer is exactly the leak the
module exists to prevent.

Replace the drop with a suppressed-scan mode: keep consuming input while
tracking brace depth and string state incrementally, emit nothing, and resume
normal text only after the JSON object closes or the turn ends. The retained
buffer stays bounded; what becomes unbounded is only the *scan*, which is O(1)
state.

While there: the cap is compared against `String.length`, which counts UTF-16
code units, not bytes. Either rename the constant or measure bytes; do not leave
a name that says one thing and a comparison that does another.

### One more defect found by reading

`[TOOL_CALL]foo[ARGS]not-json` takes the "marker without a JSON object" branch,
which sets `cursor = afterOpen` — the position immediately after `[TOOL_CALL]`.
Scanning resumes *before* the name, so `foo[ARGS]not-json` is re-scanned, finds no
opener, and is emitted as visible text. The opener is suppressed and its own
payload leaks. Resume after the `[ARGS]` tag instead.

### Advertised-name guard

`if (state.clientToolNames && !advertised) continue;` drops unadvertised names only
when an advertised set exists. With no set, every name promotes. A turn with no
advertised tool set cannot know that a name is executable, so the promotion must
be dropped there too; the marker text is stripped either way.

## Files

`src/adapters/cursor/text-toolcall.ts`, `src/adapters/cursor/protobuf-events.ts`,
`tests/providers/cursor/cursor-protobuf-events.test.ts`,
`structure/providers/cursor.md`.

## Regressions to add

Real frame plus textual echo in one turn yields exactly one client tool call;
marker split across deltas in a turn that also has a real frame promotes nothing;
malformed arguments promote nothing and leak no text; a hold past the cap leaks
no tail; `[ARGS]` with a non-JSON payload leaks no text; no advertised set
promotes nothing.

## Implementation outcome

Implemented in the allowed Cursor adapter surface. Textual calls are buffered until
turn finalization, while real client-tool frames mark the turn authoritative and discard
that fallback buffer. Oversized pending markers now switch to a byte-counted,
constant-space suppressed scan. Malformed argument diagnostics include no argument
content, and all six regressions above are covered in the existing Cursor protobuf event
test file. Per lane policy, verification is static/source-based only; hosted CI remains the
lane owner's completion gate.

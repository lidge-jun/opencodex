# wp2 result — MiMo tool-call text on Command Code

Commit `48514ccadc` (`fix(command-code): stop MiMo tool-call markup from reaching the client as text`).

## What changed

- `src/adapters/command-code-tool-text.ts` parses MiMo's native grammar
  (`<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>`, raw freeform bodies,
  the gateway's stray `</parameter>`), matches a block against a native call exactly, and builds
  restored arguments only when they fit a declared tool (required keys present, no undeclared keys,
  typed values decode).
- `CommandCodeToolTextFilter` holds a text block only while it opens with `<tool_call>`; a block
  pairs with the tool inputs open when it started and is released only after all of them are ruled
  out. Held bytes are reserved in the translator budget and capped at 64 KiB.
- `src/adapters/command-code.ts` feeds `text-start`/`text-delta`/`text-end`/`tool-input-start`
  into the filter, runs the duplicate check before relaying each native call, restores unmatched
  blocks at `finish` (reporting `tool_calls`), and releases held text on an error finish or an
  `error` event. The adapter reads the catalog of the request it last built, because the server
  builds one adapter per routed request and parses a guarded wrapper of the upstream response.

## Evidence

- Red/green: on the pre-change adapter, the captured event order, both restore cases and the
  Responses bridge case fail (4/4); on `48514ccadc` all 17 cases in
  `tests/providers/command-code-tool-text.test.ts` pass.
- Focused suites: command-code-tool-text, command-code-provider, the three adapter conformance
  files and both layout guards — 144 pass, 0 fail.

## Direction change during the cycle

The plan first carried the declared catalog on `AdapterRequest` and a `WeakMap<Response>`. The
Responses bridge test showed the server hands `parseStream` a wrapped response, so the map never
hit; the shared `AdapterRequest` field was removed and the per-instance catalog is the only source.

## Pre-push review fold (wp5)

A final review found that a block resolved by `toolCall` stayed `held` in the open-block map, so
text arriving before its `text-end` was retained and never released. Resolved blocks now switch to
streaming, and a test asserts the translator budget returns to zero. Restored arguments also reject
unsafe integers and values outside a declared `enum`, `const` or numeric bound.

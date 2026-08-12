# 002 — Upstream multi-agent v2 and realtime v3 behavior

Research only. No diffs. Focus: what a proxy on the wire can observe, versus what is
internal to the Rust runtime.

## Part A — multi-agent v2

### A1. Stable, still opt-in (`b00c9b2e1`)

`multi_agent_v2` is now `Stage::Stable` with `default_enabled: false`. The only
behavioral effect is that structured v2 config no longer triggers
under-development warnings. Nothing on the wire changes.

### A2. `subagent_developer_instructions` (`49025589b`)

Semantics, in precedence order:

1. A role file's own `developer_instructions` always wins.
2. Otherwise, if the override is set to a non-empty string, it replaces the inherited
   parent developer-instruction fragment for V2 children.
3. If set to a blank string, the inherited fragment is cleared.
4. If unset, the child inherits the parent's instructions.

It applies across full and bounded forks, through compacted replacement histories, and
on cold resume. The runtime also guards against duplicating the override when a full
fork reuses the parent reference context.

### A3. Delegated tasks survive remote compaction (`4f6d06d48`)

Remote V2 compaction retains child→parent `AgentMessage` items when both hold:

- the message is not a completion message, detected by its first text content item
  starting with exactly `Message Type: FINAL_ANSWER\n`; and
- the item estimates to at most 10,000 tokens (`MAX_RETAINED_AGENT_MESSAGE_TOKENS`).

Encrypted agent-message content now counts toward token estimation instead of being
treated as free. Child completion messages are excluded from retained follow-up
history, and inherited parent agent messages are stripped when forking a child.

Proxy visibility: indirect only. The proxy sees different subsequent model input, not a
new message type.

### A4. Fork requires a live parent (`c5779ed6b`)

Forking now requires the parent thread to be loaded. The child's history mode and
usage-hint config are read from that live parent rather than from stored metadata.
Forking an archived or unloaded parent now fails outright.

### A5. Multi-agent mode is durable world state (`0da13c6c9`)

The active mode became a `multi_agent_mode` world-state section that diffs, snapshots,
and restores. Custom mode text is truncated to 400 tokens. Two edge behaviors worth
knowing: transitioning from `Proactive` to no explicit mode renders
`ExplicitRequestOnly`, and no mode over an unknown previous state also renders
`ExplicitRequestOnly`. The initial mode instruction is placed *after* the root usage
hint so mode semantics take precedence.

### A6. Spawn inherits ready step environments (`fe01054a2`)

Both V1 and V2 spawn handlers now read `step_context.environments` instead of the
turn-level snapshot, so an environment that becomes ready mid-turn is visible to a
later spawn in the same turn.

### A7. Direct-input capability in thread listings (`9a6668f67`)

`thread/list` and `thread/search` enrich loaded spawned-thread rows with current status
and a nullable `canAcceptDirectInput`. V1 agents supporting direct input report `true`;
parent-owned V2 agents report `false`; inapplicable rows stay `null`. Shutdown and
not-found both map to `NotLoaded`, and untracked threads are no longer conflated with
explicitly shut-down ones.

### A8. Spawn models restricted to the active backend (`92938d880`) — RESOLVED, see `060`

Under V2, both the advertised `spawn_agent.model` list and runtime validation accept
only model presets whose `multi_agent_version` equals the active backend. V1 and
disabled mode impose no such filter. A rejected model produces exactly:

```
Unknown model `<requested>` for spawn_agent. Available models: <up to 5 compatible picker models>
```

**This is the unresolved design question for OpenCodex.** The restriction assumes a
single backend. OpenCodex is deliberately multi-provider, so importing it verbatim
would reject exactly the cross-provider spawns OpenCodex exists to enable. Three
candidate policies:

1. Mirror upstream exactly. Highest fidelity, defeats a core OpenCodex use case.
2. Widen the compatible set to every model OpenCodex routes. Preserves the error
   shape and the "unknown model" guardrail without the single-backend assumption.
3. Pass through without validation. Simplest, but a typo reaches the provider as an
   opaque upstream error instead of a clear tool-level message.

Resolved by the user as option 2 (option B in the plan's wording). The implementation
design is `060`; it turned out to be a two-line catalog-eligibility change in
`src/codex/catalog/sync.ts` rather than a validator rewrite, because OpenCodex generates
the catalog the native binary validates against instead of re-implementing the check.

### A9. Spawn model overrides exposed by default (`ea1545628`)

`expose_spawn_agent_model_overrides` defaults to `true`, so V2 `spawn_agent` exposes
`model` and `reasoning_effort` even when other spawn metadata is hidden. The injected
guidance states that full-history forks (`fork_turns` omitted or `"all"`) inherit model
and reasoning and reject overrides; using an override requires `"none"` or a positive
fork count.

## Part B — realtime v3 (GPT Live)

### B1. Frameless Bidi is a new dialect (`2e1607ee2`)

Version `v3` maps to the `FramelessBidi` event parser. It keeps V1-style
conversational and audio behavior but changes the wire vocabulary. Concretely:

- default model `gpt-live-1-boulder-alpha`
- header `openai-alpha: quicksilver=v2`
- no `intent` query parameter for V3 (V1 and V2 still carry theirs)
- text output modality is rejected for V3; it remains V2-only

Handled inbound events include `session.started`, `session.updated`,
`output_audio.delta`, `input_transcript.added`, `output_transcript.added`, `turn.done`,
and `delegation.created`. Outbound delegation writes use `delegation.context.append`.
Those two are the only `delegation.*` names in the current tree.

### B2. V3 URL construction

For V3, path normalization rewrites a realtime base to `/live`: an empty, `/`, `/v1`,
or `/v1/` path becomes `/v1/live`, a trailing `/realtime` becomes `/live`, and a
trailing `/live/` is trimmed. WebRTC call creation posts to `live` for ordinary
providers but keeps `realtime/calls` for backend-shaped providers, where
`intent=quicksilver&architecture=avas` is also retained.

### B3. Session bootstrap and `initialItems` (`312caf176`)

The V3 bootstrap payload is:

```
instructions, audio.output.voice, delegation.type = "client",
model (when configured), initial_items (omitted entirely when empty)
```

Each initial item is a `message` with a role and one content entry. Role→content-type
mapping: `user` and `developer` → `input_text`; `assistant` → `output_text`.

Limits are 128 items and 8,192 estimated tokens both per item and in total. The four
client-visible error strings are:

- `initial realtime items require realtime v3`
- `initial realtime items must contain no more than 128 items`
- `each initial realtime item must not exceed 8192 estimated tokens`
- `initial realtime items must not exceed 8192 estimated tokens in total`

### B4. Canonical sideband URL (`438c9e98d`)

WebRTC sideband joins no longer derive from the model provider or its query
parameters. The default base is exactly `https://api.openai.com/v1`, and for V3 the
call id is appended as a path segment: `wss://api.openai.com/v1/live/<call_id>`. V1
and V2 instead append `call_id` as a query parameter.

`experimental_realtime_ws_base_url` overrides the websocket/API provider base URL and
is also passed as the explicit sideband base override. It does *not* override
`experimental_realtime_webrtc_call_base_url`, which is a separate setting for call
creation.

### B5. Handoff routing by channel (`025db2205`)

`codexResponseHandoffMode` applies to V3 only:

| Mode | Behavior |
|---|---|
| omitted / `thinking` | no `channel` field |
| `commentary` | all automatic output carries `"channel":"commentary"` |
| `bemTags` | parse the BEM envelope: `analysis`/`commentary` → commentary, `final` → speakable, unrecognized header → speakable |

The BEM envelope is preserved in forwarded content and stream delivery waits until the
header is complete. Explicit speech is always speakable. V3 no longer prefixes
`"Agent Final Message"` the way V1 did.

## Proxy-visible versus runtime-internal

Wire-visible, therefore OpenCodex's concern:

- the V3 `/live` dialect: path, `quicksilver=v2` header, absent V3 intent, and the
  `delegation.*` / `session.context.append` / `input_audio.append` / `session.close`
  vocabulary
- V3 WebRTC call creation path selection and the canonical sideband join URL
- the bootstrap payload shape, including `delegation.type` and `initial_items` role
  mapping and empty-list omission
- the four `initialItems` validation errors, if OpenCodex chooses to emulate them
- `codexResponseHandoffMode` channel values and BEM preservation
- the `spawn_agent` model-validation error shape (see A8)

Runtime-internal, therefore not OpenCodex's concern:

- feature stage classification, `[agents]` backend precedence, V2 concurrency
  normalization, config-lock state, world-state persistence
- developer-instruction inheritance and fork-history scrubbing
- live-parent fork requirements and compaction retention rules
- step-environment inheritance, except as it changes later provider-bound requests
- thread-list status enrichment and `canAcceptDirectInput`, unless OpenCodex also
  implements the app-server thread-management API

## Verified SHAs

```
b00c9b2e1 Mark multi-agent v2 as stable (#34383)
03bb3b123 Unify multi-agent settings under `agents` (#33550)
49025589b Add configurable developer instructions for v2 subagents (#35708)
4f6d06d48 Preserve delegated tasks across remote compaction (#36128)
c5779ed6b Use the live parent history mode when forking agents (#34779)
0da13c6c9 Track multi-agent mode in world state (#34845)
fe01054a2 Inherit ready step environments when spawning agents (#35895)
9a6668f67 Report direct input capability for listed subagents (#35944)
92938d880 Restrict spawned-agent models to the active backend (#32751)
ea1545628 Expose model overrides for multi-agent v2 spawns (#32749)
2e1607ee2 Add Frameless Bidi support for realtime conversations (#33261)
312caf176 Seed realtime V3 sessions with initial text items (#34067)
438c9e98d Route WebRTC sideband joins to the Realtime API (#35830)
025db2205 Route realtime V3 handoffs by response channel (#33903)
```

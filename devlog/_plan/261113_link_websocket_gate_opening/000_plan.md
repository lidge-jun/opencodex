# Link WebSocket: what opening the Child gates still needs

Both Children can carry Codex's Responses WebSocket over a Remote Link, and both ship with that path switched off. The TypeScript Child (`src/client/link-websocket.ts`, merged as #8614, #8619, #8620 and #8658) waits on `linkWebsocketChildReady()`; the lightweight `ocx-child` (`native/ocx-child/src/link_ws*.rs`, merged as #8653) waits on its own gate, which no build without the `link-ws-test-gate` Cargo feature can open. The Home side (#8593) has its own release gate. `structure/remote-link.md` describes what holds today. This unit lists what the change that opens each Child's gate still has to carry, so none of it is lost between that change and the reviews that found it. Nothing here is implemented yet.

## ocx-child

1. **Control-frame deadline.** Every frame write registers an absolute deadline before it takes the leg's write lock: 600 s for data, 30 s for a pong or close. A pong or close that waits behind a long data write can therefore reach its 30 s deadline while the data write is healthy, and the reaper then cuts the socket. A waiting control write should inherit the remaining deadline of the write holding the lock, or the Child should answer only the latest ping. Today the Home's link socket sends no pings (Bun `idleTimeout: 0`), so this does not happen yet.
2. **Reaper wakeups.** Each frame write registers and clears a reaper deadline, which wakes the reaper twice per frame. Optional; measure first.
3. **Autobahn.** Run the Autobahn suite against the frame reader in both roles (`link_ws_frame.rs`).
4. **Memory.** An RSS acceptance against the 32 MiB reservation per socket, with maximum-size messages in both directions at once.
5. **Pinned Codex.** Run the release-gate scenarios with the pinned codex-rs (`tests/fixtures/link-gate-codex.json`) through `ocx-child`.
6. **Split `link_ws.rs`.** A pure-move split of the module (handshake and headers; registry and reaper; the socket, frame writes, terminal transition and pumps; open, serve and stop; tests into `link_ws/tests.rs`), with no behaviour change, before the gate opens.
7. **Child-local opt-out.** The TypeScript Child reads `linkResponsesWebsocketOptOut` (owner decision D4); `ocx-child` needs the same, read once when `serve` starts and checked before the advertisement, with a way for the Home or an operator to set it.
8. **Platforms.** macOS and Windows runs of the crate and the real-binary tests.
9. **User docs.** The guide pages that describe the link WebSocket on a lightweight Child, with the Spanish mirror rule.
10. **CI path filter.** `tests/fixtures/link/link-ws-state-proof.json` is outside the Rust CI path filter in `.github/workflows/ci.yml`, so a change to the vectors alone does not run the Rust tests. Add it the next time `ci.yml` is edited (an edit needs the release-evidence re-pin).

## TypeScript Child

1. **Gate preconditions.** The framer's client conformance run and the Child's memory acceptance, which `linkWebsocketChildReady()` names as its own preconditions.
2. **Pinned Codex.** The reviewed digest in `tests/fixtures/link-gate-codex.json`, then a release-gate run with the pinned codex-rs.
3. **A real Child restart.** On a restart the Child answers every upgrade 503 while its tunnel supervisor stops (up to the 5 s TERM window), and then the listener closes and connections are refused while the replacement binds. codex-rs retries a refused connection without limit and stays on the WebSocket, but each 503 spends its stream retry budget (about 1.5 to 2 s), so a 503 phase longer than the budget sends the session to HTTP for good. The measurement (refused WebSocket and HTTP during a restart, reconnect time after the bind, a close before the 101) decides between closing the listener when the drain starts, holding the upgrade unanswered, and shortening the 503 phase.
4. **The first upgrade after a restart.** A restarted Child starts with the Home's advertisement unknown and reads it as off, so an upgrade before the first preflight answer gets 426, which moves Codex to HTTP. The first teacher is the route-intent watch's first poll once the tunnel is up. Letting an upgrade go on while the state is unknown (its own preflight decides) removes the race.
5. **Diagnostics table.** Show the `link_ws_*` events (open, close reasons, fallback reasons including `draining`) in the dashboard's diagnostics table.
6. **Wording and counting.** Three comments and the structure doc still say a failed local upgrade counts nothing; one that threw after Bun opened Codex's socket counts as a stop. "As the Home counts it" is wrong for Bun's own oversized-message 1006, which the Home receives as 1011 and counts complete. The Child counts a 1015 close as complete where the Home's rule (#8647) does not: `finish("client", code !== 1006 && code !== 1015)`, with a test.
7. **Platforms and docs.** macOS and Windows runs, and the user guide pages, with the Spanish mirror rule.
